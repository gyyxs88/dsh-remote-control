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
  return status?.status === 'installed' && status.kind === action.kind && status.id === action.id && status.version === action.version && status.sha256 === action.sha256 && status.size === action.size && status.packageName === action.packageName && status.target === 'linux-x86_64' && status.protocolVersion === action.protocolVersion;
}

function receiptFromStatus(status) {
  if (status?.status === 'missing') return { status: 'missing' };
  if (status?.status === 'installed' && typeof status.kind === 'string' && typeof status.id === 'string' && typeof status.version === 'string' && typeof status.sha256 === 'string' && Number.isSafeInteger(status.size) && typeof status.packageName === 'string' && typeof status.target === 'string' && typeof status.protocolVersion === 'string') {
    return { status: 'installed', kind: status.kind, id: status.id, version: status.version, sha256: status.sha256, size: status.size, packageName: status.packageName, target: status.target, protocolVersion: status.protocolVersion };
  }
  throw new DshRemoteError('remote plugin status cannot be used as a rollback receipt', { code: 'PLUGIN_STATUS_INVALID', details: { status } });
}

function receiptMatchesStatus(status, receipt) {
  if (receipt?.status === 'missing') return status?.status === 'missing';
  return status?.status === 'installed'
    && status.kind === receipt.kind
    && status.id === receipt.id
    && status.version === receipt.version
    && status.sha256 === receipt.sha256
    && status.size === receipt.size
    && status.packageName === receipt.packageName
    && status.target === receipt.target
    && status.protocolVersion === receipt.protocolVersion;
}

function rollbackResultMatches(result, receipt) {
  if (receipt?.status === 'missing') return result?.status === 'missing' || result?.status === 'already-missing';
  return (result?.status === 'rolled-back' || result?.status === 'already-current')
    && result.kind === receipt.kind
    && result.id === receipt.id
    && result.version === receipt.version
    && result.sha256 === receipt.sha256
    && result.size === receipt.size
    && result.packageName === receipt.packageName
    && result.target === receipt.target
    && result.protocolVersion === receipt.protocolVersion;
}

export function buildPluginSyncCommands(action) {
  return {
    mkdir: ['mkdir', '-p', action.stagingPath],
    status: ['node', action.installerPath, '--status', '--kind', action.kind, '--id', action.id, '--install-root', action.remoteRoot],
    install: ['node', action.installerPath, '--artifact', action.remoteArtifactPath, '--sha256', action.sha256, '--kind', action.kind, '--id', action.id, '--version', action.version, '--package-name', action.packageName, '--protocol-version', action.protocolVersion, '--target', 'linux-x86_64', '--install-root', action.remoteRoot, '--atomic', '--no-scripts'],
    probe: ['node', action.installerPath, '--probe', '--kind', action.kind, '--id', action.id, '--install-root', action.remoteRoot],
    rollback: (receipt) => [
      'node', action.installerPath, '--rollback', '--kind', action.kind, '--id', action.id, '--install-root', action.remoteRoot, '--atomic', '--no-scripts',
      ...(receipt.status === 'missing'
        ? ['--target-missing']
        : ['--target-version', receipt.version, '--target-sha256', receipt.sha256, '--target-size', String(receipt.size), '--target-package-name', receipt.packageName, '--protocol-version', receipt.protocolVersion, '--target', receipt.target]),
    ],
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
    const running = { status: 'running', operationId: id, desiredStateSha256: plan.desiredStateSha256, items: [], rollback: { attempted: false, status: 'not-attempted', items: [] }, plan };
    this.statuses.set(id, running);
    const completed = [];
    const attempted = [];
    try {
      for (const action of plan.actions) {
        let result;
        try {
          result = await this.#syncAction(action);
        } catch (error) {
          if (error.syncActionContext) attempted.push(error.syncActionContext);
          throw error;
        }
        attempted.push(result.context);
        completed.push(result.item);
        running.items = [...completed];
        this.statuses.set(id, running);
      }
      const result = { status: 'completed', operationId: id, desiredStateSha256: plan.desiredStateSha256, items: completed, rollback: { attempted: false, status: 'not-attempted', items: [] }, skipped: [...plan.skipped, ...plan.skippedSkills], planDigest: sha256(stableJson(plan)) };
      this.statuses.set(id, result);
      return clone(result);
    } catch (error) {
      const rollback = await this.#rollback(attempted);
      const status = rollback.status === 'unknown' || isUnknownTransport(error) && rollback.status !== 'completed' ? 'persistence-unknown' : 'needs-attention';
      const result = { status, operationId: id, desiredStateSha256: plan.desiredStateSha256, items: completed, rollback, planDigest: sha256(stableJson(plan)), error: { code: error.code ?? 'PLUGIN_SYNC_FAILED', message: error.message, details: error.details }, plan };
      this.statuses.set(id, result);
      return clone(result);
    }
  }

  async reconcile(operationId) {
    const current = this.statuses.get(operationId);
    if (!current || !current.plan) return clone(current ?? { status: 'unknown', operationId });
    const observed = new Map();
    const readStatus = async (action) => {
      if (observed.has(action.key)) return observed.get(action.key);
      try {
        const value = parseJson((await this.transport.execArgv(buildPluginSyncCommands(action).status)).stdout, 'PLUGIN_STATUS_INVALID', 'remote plugin status is invalid');
        const result = { status: 'ok', value };
        observed.set(action.key, result);
        return result;
      } catch (error) {
        const result = { status: 'unknown', error };
        observed.set(action.key, result);
        return result;
      }
    };
    const items = [];
    let targetUnknown = false;
    for (const action of current.plan.actions) {
      const result = await readStatus(action);
      if (result.status === 'ok' && statusMatches(result.value, action)) items.push({ key: action.key, status: 'verified', version: action.version, sha256: action.sha256, size: action.size, packageName: action.packageName, target: 'linux-x86_64', protocolVersion: action.protocolVersion });
      else if (result.status === 'ok') {
        targetUnknown = true;
        items.push({ key: action.key, status: 'not-current', version: action.version, sha256: action.sha256, size: action.size, packageName: action.packageName, target: 'linux-x86_64', protocolVersion: action.protocolVersion, observed: result.value });
      } else {
        targetUnknown = true;
        items.push({ key: action.key, status: 'unknown', version: action.version, sha256: action.sha256, size: action.size, packageName: action.packageName, target: 'linux-x86_64', protocolVersion: action.protocolVersion, error: { code: result.error.code ?? 'PLUGIN_STATUS_UNKNOWN', message: result.error.message } });
      }
    }
    let rollback = current.rollback ?? { attempted: false, status: 'not-attempted', items: [] };
    if (rollback.attempted) {
      const rollbackItems = [];
      let rollbackUnknown = false;
      let rollbackFailed = false;
      for (const rollbackItem of rollback.items.filter((item) => item.status !== 'not-needed')) {
        const action = current.plan.actions.find((candidate) => candidate.key === rollbackItem.key);
        if (!action) { rollbackUnknown = true; rollbackItems.push({ ...rollbackItem, status: 'unknown' }); continue; }
        const result = await readStatus(action);
        if (result.status === 'ok' && receiptMatchesStatus(result.value, rollbackItem.target)) rollbackItems.push({ ...rollbackItem, status: 'completed', observed: result.value });
        else if (result.status === 'ok') { rollbackFailed = true; rollbackItems.push({ ...rollbackItem, status: 'failed', observed: result.value }); }
        else { rollbackUnknown = true; rollbackItems.push({ ...rollbackItem, status: 'unknown', error: { code: result.error.code ?? 'PLUGIN_STATUS_UNKNOWN', message: result.error.message } }); }
      }
      rollback = { ...rollback, status: rollbackUnknown ? 'unknown' : rollbackFailed ? 'failed' : 'completed', items: rollbackItems };
    }
    const status = rollback.attempted ? (rollback.status === 'completed' ? 'needs-attention' : 'persistence-unknown') : targetUnknown ? 'needs-attention' : 'completed';
    const result = { ...current, status, reconciled: true, targetStatus: targetUnknown ? 'not-current-or-unknown' : 'completed', items, rollback };
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
    const previous = receiptFromStatus(remote);
    const context = { key: action.key, action, previous, changed: false };
    if (statusMatches(remote, action)) return { item: { key: action.key, status: 'reused', version: action.version, sha256: action.sha256, size: action.size, packageName: action.packageName, target: 'linux-x86_64', protocolVersion: action.protocolVersion, previous, changed: false }, context };
    context.changed = true;
    try {
      await this.transport.execArgv(commands.mkdir);
      await this.transport.upload(action.artifactPath, action.remoteArtifactPath, { sha256: action.sha256, size: action.size });
      const installed = parseJson((await this.transport.execArgv(commands.install)).stdout, 'PLUGIN_INSTALL_RESULT_INVALID', 'remote plugin installer returned invalid JSON');
      if (!statusMatches(installed, action)) throw new DshRemoteError('remote plugin installer did not return the requested verified artifact', { code: 'PLUGIN_INSTALL_RESULT_INVALID', details: { key: action.key, installed } });
      const probe = parseJson((await this.transport.execArgv(commands.probe)).stdout, 'PLUGIN_PROBE_INVALID', 'remote plugin probe returned invalid JSON');
      if (!statusMatches(probe, action)) throw new DshRemoteError('remote plugin probe did not confirm the requested artifact', { code: 'PLUGIN_PROBE_FAILED', details: { key: action.key, probe } });
      await this.transport.execArgv(commands.cleanup);
      await this.transport.execArgv(commands.cleanupDir);
      return { item: { key: action.key, status: 'installed', version: action.version, sha256: action.sha256, size: action.size, packageName: action.packageName, target: 'linux-x86_64', protocolVersion: action.protocolVersion, previous, changed: true }, context };
    } catch (error) {
      Object.defineProperty(error, 'syncActionContext', { value: context, enumerable: false, configurable: true });
      throw error;
    }
  }

  async #rollback(attempted) {
    const changed = attempted.filter((item) => item.changed).reverse();
    if (changed.length === 0) return { attempted: false, status: 'not-attempted', items: [] };
    const items = [];
    let unknown = false;
    let failed = false;
    for (const context of changed) {
      try {
        const result = parseJson((await this.transport.execArgv(buildPluginSyncCommands(context.action).rollback(context.previous))).stdout, 'PLUGIN_ROLLBACK_RESULT_INVALID', 'remote rollback returned invalid JSON');
        if (!rollbackResultMatches(result, context.previous)) throw new DshRemoteError('remote rollback did not confirm its target receipt', { code: 'PLUGIN_ROLLBACK_RESULT_INVALID', details: { key: context.key, result, target: context.previous } });
        items.push({ key: context.key, status: 'completed', target: context.previous });
      } catch (error) {
        const isUnknown = isUnknownTransport(error) || error?.code === 'PLUGIN_ROLLBACK_RESULT_INVALID';
        if (isUnknown) unknown = true; else failed = true;
        items.push({ key: context.key, status: isUnknown ? 'unknown' : 'failed', target: context.previous, error: { code: error.code ?? 'PLUGIN_ROLLBACK_FAILED', message: error.message } });
      }
    }
    return { attempted: true, status: unknown ? 'unknown' : failed ? 'failed' : 'completed', items };
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
