import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { DshRemoteError, NeedsAttentionError, TimeoutError, TransportError } from './errors.mjs';
import { sha256, stableJson } from './protocol.mjs';
import { remoteRequirements, validateDesiredState, validateSyncReceipt } from './desired-state.mjs';
import { TrustedArtifactRegistry } from './desired-state-registry.mjs';
import { validateSafePosixPath } from './path-safety.mjs';

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/u;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function parseJson(stdout, code, message) {
  try { return JSON.parse(stdout ?? '{}'); } catch (error) { throw new DshRemoteError(message, { code, details: { message: error.message } }); }
}

function isUnknownTransport(error) {
  return error instanceof TransportError || error instanceof TimeoutError || ['SSH_BRIDGE_EXITED', 'SSH_BRIDGE_CLOSED', 'SSH_BRIDGE_WRITE_FAILED'].includes(error?.code);
}

function safeOperationId(value) {
  const operationId = value ?? randomUUID();
  if (!OPERATION_ID.test(operationId)) throw new DshRemoteError('plugin sync operation id is invalid', { code: 'PLUGIN_SYNC_OPERATION_INVALID' });
  return operationId;
}

function itemKey(kind, id, version) {
  return `${kind}:${id}@${version}`;
}

function statusMatches(status, action) {
  return status?.status === 'installed' && status.kind === action.kind && status.id === action.id && status.version === action.version && status.sha256 === action.sha256 && status.packageName === action.packageName;
}

export function buildPluginSyncCommands(action) {
  return {
    mkdir: ['mkdir', '-p', action.stagingPath],
    status: ['node', action.installerPath, '--status', '--kind', action.kind, '--id', action.id, '--install-root', action.remoteRoot],
    install: ['node', action.installerPath, '--artifact', action.remoteArtifactPath, '--sha256', action.sha256, '--kind', action.kind, '--id', action.id, '--version', action.version, '--package-name', action.packageName, '--protocol-version', action.protocolVersion, '--target', 'linux-x86_64', '--install-root', action.remoteRoot, '--atomic', '--no-scripts'],
    probe: ['node', action.installerPath, '--probe', '--kind', action.kind, '--id', action.id, '--install-root', action.remoteRoot],
    cleanup: ['rm', '-f', action.remoteArtifactPath],
    cleanupDir: ['rmdir', action.stagingPath],
  };
}

export class DesiredStateSynchronizer {
  constructor({ registry, transport, remoteRoot, installerPath = null } = {}) {
    if (!(registry instanceof TrustedArtifactRegistry) && typeof registry?.resolve !== 'function') throw new DshRemoteError('plugin sync requires a trusted artifact registry', { code: 'PLUGIN_SYNC_REGISTRY_INVALID' });
    if (!transport || typeof transport.upload !== 'function' || typeof transport.execArgv !== 'function') throw new DshRemoteError('plugin sync transport must provide upload and execArgv', { code: 'PLUGIN_SYNC_TRANSPORT_INVALID' });
    validateSafePosixPath(remoteRoot, { field: 'plugin remoteRoot', allowHome: false });
    this.registry = registry;
    this.transport = transport;
    this.remoteRoot = posix.normalize(remoteRoot);
    this.installerPath = installerPath ?? posix.join(this.remoteRoot, 'host', 'current', 'bin', 'dsh-remote-artifact-installer.mjs');
    validateSafePosixPath(this.installerPath, { field: 'plugin installerPath', allowHome: false });
    this.statuses = new Map();
  }

  status(operationId) {
    return clone(this.statuses.get(operationId) ?? { status: 'unknown', operationId });
  }

  async plan({ desiredState, operationId } = {}) {
    const state = validateDesiredState(desiredState);
    const id = safeOperationId(operationId);
    const resolved = [];
    for (const item of remoteRequirements(state)) resolved.push({ ...item, artifact: await this.registry.resolve(item.kind === 'skill' ? { kind: 'skill', ...item.requirement } : { kind: 'plugin', ...item.requirement }, { dshVersion: state.dshVersion, apiVersion: state.apiVersion }) });
    const pluginArtifacts = new Map(resolved.filter((item) => item.kind === 'plugin').map((item) => [item.requirement.id, item.artifact]));
    for (const skill of state.skills.filter((item) => item.bundledWith && item.placement !== 'control')) {
      const plugin = pluginArtifacts.get(skill.bundledWith.pluginId);
      if (!plugin || plugin.version !== skill.bundledWith.pluginVersion) throw new DshRemoteError('bundled Skill requires its matching plugin version', { code: 'SKILL_BUNDLE_MISMATCH', details: { skill: skill.id, plugin: skill.bundledWith.pluginId } });
      const bundled = plugin.packageJson.dsh?.remote?.bundledSkills ?? [];
      if (!bundled.some((item) => item?.id === skill.id && item?.version === skill.version && item?.sha256 === skill.sha256)) throw new DshRemoteError('plugin manifest does not contain the requested bundled Skill digest', { code: 'SKILL_BUNDLE_MISMATCH', details: { skill: skill.id, plugin: plugin.id } });
    }
    const actions = resolved.map(({ kind, requirement, artifact }) => {
      const key = itemKey(kind, requirement.id, requirement.version);
      const stagingPath = posix.join(this.remoteRoot, 'staging', 'plugins', id);
      const remoteArtifactPath = posix.join(stagingPath, `${kind}-${requirement.id}-${requirement.version}.tgz`);
      return {
        key,
        kind,
        id: requirement.id,
        version: requirement.version,
        placement: requirement.placement,
        sha256: requirement.sha256,
        size: artifact.size,
        packageName: artifact.packageName,
        protocolVersion: artifact.manifest?.protocolVersion ?? '1.0',
        artifactPath: artifact.artifactPath,
        source: requirement.source,
        requiredBy: requirement.requiredBy,
        remoteRoot: this.remoteRoot,
        stagingPath,
        remoteArtifactPath,
        installerPath: this.installerPath,
      };
    });
    return {
      protocolVersion: '1.0',
      operationId: id,
      desiredStateSha256: sha256(stableJson(state)),
      actions,
      skipped: state.plugins.filter((item) => item.placement === 'control').map((item) => ({ kind: 'plugin', id: item.id, version: item.version, placement: item.placement })),
      skippedSkills: state.skills.filter((item) => item.placement === 'control' || item.bundledWith).map((item) => ({ kind: 'skill', id: item.id, version: item.version, placement: item.placement, bundledWith: item.bundledWith ?? null })),
    };
  }

  async sync({ desiredState, operationId } = {}) {
    const id = safeOperationId(operationId);
    const previous = this.statuses.get(id);
    if (previous?.status === 'completed') return clone(previous);
    let plan;
    try {
      plan = await this.plan({ desiredState, operationId: id });
    } catch (error) {
      const result = { status: 'incompatible', operationId: id, desiredStateSha256: typeof desiredState === 'object' && desiredState !== null ? sha256(stableJson(desiredState)) : null, items: [], error: { code: error.code ?? 'PLUGIN_SYNC_REJECTED', message: error.message, details: error.details } };
      this.statuses.set(id, result);
      return clone(result);
    }
    const running = { status: 'running', operationId: id, desiredStateSha256: plan.desiredStateSha256, items: [], plan };
    this.statuses.set(id, running);
    const completed = [];
    try {
      for (const action of plan.actions) {
        const result = await this.#syncAction(action);
        completed.push(result);
        running.items = [...completed];
        this.statuses.set(id, running);
      }
      const result = { status: 'completed', operationId: id, desiredStateSha256: plan.desiredStateSha256, items: completed, skipped: [...plan.skipped, ...plan.skippedSkills], planDigest: sha256(stableJson(plan)) };
      this.statuses.set(id, result);
      return clone(result);
    } catch (error) {
      const status = isUnknownTransport(error) ? 'persistence-unknown' : completed.length > 0 ? 'partial' : 'needs-attention';
      const result = { status, operationId: id, desiredStateSha256: plan.desiredStateSha256, items: completed, planDigest: sha256(stableJson(plan)), error: { code: error.code ?? 'PLUGIN_SYNC_FAILED', message: error.message, details: error.details }, plan };
      this.statuses.set(id, result);
      return clone(result);
    }
  }

  async reconcile(operationId) {
    const current = this.statuses.get(operationId);
    if (!current || !current.plan) return clone(current ?? { status: 'unknown', operationId });
    const items = [];
    let unknown = false;
    for (const action of current.plan.actions) {
      try {
        const result = parseJson((await this.transport.execArgv(buildPluginSyncCommands(action).status)).stdout, 'PLUGIN_STATUS_INVALID', 'remote plugin status is invalid');
        if (statusMatches(result, action)) items.push({ key: action.key, status: 'verified', version: action.version, sha256: action.sha256 });
        else unknown = true;
      } catch (error) {
        unknown = true;
        items.push({ key: action.key, status: 'unknown', version: action.version, sha256: action.sha256, error: { code: error.code ?? 'PLUGIN_STATUS_UNKNOWN', message: error.message } });
      }
    }
    const status = unknown ? (items.some((item) => item.status === 'verified') ? 'partial' : 'needs-attention') : 'completed';
    const result = { ...current, status, reconciled: true, items };
    this.statuses.set(operationId, result);
    return clone(result);
  }

  async #syncAction(action) {
    const commands = buildPluginSyncCommands(action);
    let remote;
    try { remote = parseJson((await this.transport.execArgv(commands.status)).stdout, 'PLUGIN_STATUS_INVALID', 'remote plugin status is invalid'); } catch (error) {
      if (error?.code === 'PLUGIN_STATUS_NOT_INSTALLED') remote = { status: 'missing' };
      else throw error;
    }
    if (statusMatches(remote, action)) return { key: action.key, status: 'reused', version: action.version, sha256: action.sha256 };
    await this.transport.execArgv(commands.mkdir);
    await this.transport.upload(action.artifactPath, action.remoteArtifactPath, { sha256: action.sha256, size: action.size });
    const installed = parseJson((await this.transport.execArgv(commands.install)).stdout, 'PLUGIN_INSTALL_RESULT_INVALID', 'remote plugin installer returned invalid JSON');
    if (!statusMatches(installed, action)) throw new DshRemoteError('remote plugin installer did not return the requested verified artifact', { code: 'PLUGIN_INSTALL_RESULT_INVALID', details: { key: action.key, installed } });
    const probe = parseJson((await this.transport.execArgv(commands.probe)).stdout, 'PLUGIN_PROBE_INVALID', 'remote plugin probe returned invalid JSON');
    if (!statusMatches(probe, action)) throw new DshRemoteError('remote plugin probe did not confirm the requested artifact', { code: 'PLUGIN_PROBE_FAILED', details: { key: action.key, probe } });
    await this.transport.execArgv(commands.cleanup);
    await this.transport.execArgv(commands.cleanupDir);
    return { key: action.key, status: 'installed', version: action.version, sha256: action.sha256 };
  }
}

export function validatePluginSyncReceipt(receipt, desiredState) {
  return validateSyncReceipt(receipt, desiredState);
}

export function pluginSyncNeedsAttention(receipt) {
  return ['partial', 'incompatible', 'needs-attention', 'persistence-unknown'].includes(receipt?.status);
}

export const PLUGIN_SYNC_FAILURE = Object.freeze({
  incompatible: 'PLUGIN_SYNC_INCOMPATIBLE',
  partial: 'PLUGIN_SYNC_PARTIAL',
  needsAttention: 'PLUGIN_SYNC_NEEDS_ATTENTION',
  persistenceUnknown: 'PLUGIN_SYNC_PERSISTENCE_UNKNOWN',
});
