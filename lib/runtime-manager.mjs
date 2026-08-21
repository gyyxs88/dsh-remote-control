import { isAbsolute, posix } from 'node:path';
import { DshRemoteError } from './errors.mjs';
import { inspectRemoteArtifact } from './remote-artifact-installer.mjs';
import { parseSemver, runtimeRequirements, RUNTIME_TARGET, validateDesiredState, validateRuntimeRequirement, validateRuntimeSyncReceipt } from './desired-state.mjs';
import { sha256, stableJson } from './protocol.mjs';

export const RUNTIME_STATES = Object.freeze([
  'not-required',
  'missing',
  'installing',
  'auth-required',
  'ready',
  'installed-auth-unverified',
  'update-required',
  'incompatible',
  'degraded',
]);

const DRIVER_DEFINITIONS = Object.freeze({
  codex: { id: 'codex', authMethods: [{ id: 'codex-login', kind: 'browser', label: 'OpenAI Codex official login', instructions: 'Run the installed Codex executable with --login in the user-controlled remote terminal/browser flow.' }], permissions: ['read-only', 'workspace-write', 'danger-full-access'], capabilities: ['exec', 'app-server', 'approval-requests'] },
  'claude-code': { id: 'claude-code', authMethods: [{ id: 'claude-login', kind: 'browser-or-enterprise', label: 'Claude Code official login', instructions: 'Use the official Claude Code /login browser flow, Claude Console, or the configured enterprise provider; DSH never handles the credential.' }], permissions: ['read-only', 'workspace-write', 'danger-full-access'], capabilities: ['headless', 'agent-sdk', 'approval-callback'] },
  'grok-build': { id: 'grok-build', authMethods: [{ id: 'grok-device-auth', kind: 'device-code', label: 'Grok Build device authentication', instructions: 'Run grok login --device-auth and complete the displayed public URL/device code; DSH never receives the resulting credential.' }, { id: 'grok-api-key', kind: 'api-key', label: 'Grok API authentication', instructions: 'Inject XAI_API_KEY through the approved remote process environment; DSH never stores or echoes it.' }], permissions: ['read-only', 'workspace-write', 'danger-full-access'], capabilities: ['headless', 'acp', 'permission-mode', 'sandbox-profile'] },
  acp: { id: 'acp', authMethods: [{ id: 'agent-defined', kind: 'agent-defined', label: 'ACP agent-defined authentication', instructions: 'Use authMethods negotiated by the ACP Agent; DSH forwards only public challenge metadata.' }], permissions: [], capabilities: ['initialize', 'auth-negotiation'] },
});

const SAFE_RELATIVE_EXECUTABLE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._+@-]+(?:\/[A-Za-z0-9._+@-]+)*$/u;
const MAX_RUNTIME_AUTH_TTL_MS = 24 * 60 * 60 * 1000;

function fail(message, code = 'RUNTIME_MANAGER_ERROR', details) {
  throw new DshRemoteError(message, { code, details });
}

function parseJson(stdout, code, message) {
  try { return JSON.parse(stdout); } catch (error) { fail(message, code, { message: error.message }); }
}

function isUnknownTransport(error) {
  return Boolean(error?.unknownTerminal || ['TRANSPORT_ERROR', 'TIMEOUT', 'UNKNOWN_TERMINAL_STATE', 'REMOTE_EXEC_TIMEOUT'].includes(error?.code));
}

function runtimeKey(requirement) {
  return `runtime:${requirement.id}@${requirement.version}`;
}

function encodedRuntimeId(id) {
  return id.replaceAll('/', '__');
}

function safeRuntimeInstallRoot(root) {
  const windowsAbsolute = typeof root === 'string' && /^[A-Za-z]:[\\/]/u.test(root);
  if (typeof root !== 'string' || (!root.startsWith('/') && !windowsAbsolute) || root.includes('\0') || /[\r\n]/u.test(root) || root.split(/[\\/]/u).includes('..')) fail('runtime remote root is invalid', 'RUNTIME_ROOT_INVALID');
  return windowsAbsolute ? root : posix.normalize(root);
}

function runtimeTargetFromStatus(status) {
  if (status?.status === 'missing') return { status: 'missing' };
  if (status?.status === 'installed' && typeof status.id === 'string' && typeof status.version === 'string' && typeof status.sha256 === 'string' && Number.isSafeInteger(status.size) && typeof status.packageName === 'string' && typeof status.executablePath === 'string' && typeof status.target === 'string' && typeof status.protocolVersion === 'string') return { status: 'installed', kind: 'runtime', id: status.id, version: status.version, sha256: status.sha256, size: status.size, packageName: status.packageName, executablePath: status.executablePath, target: status.target, protocolVersion: status.protocolVersion };
  fail('runtime status cannot be used as a rollback receipt', 'RUNTIME_STATUS_INVALID', { status });
}

function statusMatches(status, action) {
  return status?.status === 'installed' && status.kind === 'runtime' && status.id === action.id && status.version === action.version && status.sha256 === action.sha256 && status.size === action.size && status.packageName === action.packageName && status.executablePath === action.executablePath && status.target === RUNTIME_TARGET && status.protocolVersion === action.protocolVersion;
}

function rollbackResultMatches(result, target) {
  if (target.status === 'missing') return result?.status === 'missing' || result?.status === 'already-missing';
  return (result?.status === 'rolled-back' || result?.status === 'already-current') && result.kind === 'runtime' && result.id === target.id && result.version === target.version && result.sha256 === target.sha256 && result.size === target.size && result.packageName === target.packageName && result.executablePath === target.executablePath && result.target === target.target && result.protocolVersion === target.protocolVersion;
}

export function buildRuntimeSyncCommands(action) {
  return {
    mkdir: ['mkdir', '-p', action.remoteStagingRoot],
    status: ['node', action.installerPath, '--status', '--kind', 'runtime', '--id', action.id, '--install-root', action.remoteRoot],
    install: ['node', action.installerPath, '--artifact', action.remoteArtifactPath, '--sha256', action.sha256, '--kind', 'runtime', '--id', action.id, '--version', action.version, '--package-name', action.packageName, '--executable-path', action.executablePath, '--protocol-version', action.protocolVersion, '--target', RUNTIME_TARGET, '--install-root', action.remoteRoot, '--atomic', '--no-scripts'],
    probe: ['node', action.installerPath, '--probe', '--kind', 'runtime', '--id', action.id, '--install-root', action.remoteRoot],
    rollback: (target) => ['node', action.installerPath, '--rollback', '--kind', 'runtime', '--id', action.id, '--install-root', action.remoteRoot, '--atomic', '--no-scripts', ...(target.status === 'missing' ? ['--target-missing'] : ['--target-version', target.version, '--target-sha256', target.sha256, '--target-size', String(target.size), '--target-package-name', target.packageName, '--target-executable-path', target.executablePath, '--protocol-version', target.protocolVersion, '--target', target.target])],
    cleanup: ['rm', '-f', action.remoteArtifactPath],
    cleanupDir: ['rmdir', action.remoteStagingRoot],
  };
}

export class RuntimeManagerPort {
  async inspect(_requirements) { throw new DshRemoteError('RuntimeManagerPort.inspect is not implemented', { code: 'RUNTIME_PORT_NOT_IMPLEMENTED' }); }
  async ensure(_requirements) { throw new DshRemoteError('RuntimeManagerPort.ensure is not implemented', { code: 'RUNTIME_PORT_NOT_IMPLEMENTED' }); }
  async resolveExecutable(_requirement) { throw new DshRemoteError('RuntimeManagerPort.resolveExecutable is not implemented', { code: 'RUNTIME_PORT_NOT_IMPLEMENTED' }); }
  async authChallenge(_requirement) { throw new DshRemoteError('RuntimeManagerPort.authChallenge is not implemented', { code: 'RUNTIME_PORT_NOT_IMPLEMENTED' }); }
}

/** Remote authority. It never searches PATH or reads vendor login directories. */
export class InstalledRuntimeManager extends RuntimeManagerPort {
  constructor({ transport = null, installRoot = '/home/.dsh-remote', authProbe = null, platform = 'linux', arch = 'x86_64', dshVersion = '0.1.0-rc.6', apiVersion = '1.0', drivers = {} } = {}) {
    super();
    this.transport = transport;
    this.installRoot = safeRuntimeInstallRoot(installRoot);
    this.authProbe = authProbe;
    this.platform = platform;
    this.arch = arch;
    this.dshVersion = dshVersion;
    this.apiVersion = apiVersion;
    this.drivers = drivers;
  }

  async #artifactStatus(requirement) {
    if (this.platform !== 'linux' || this.arch !== 'x86_64') return { status: 'incompatible' };
    const command = buildRuntimeSyncCommands({ id: requirement.id, remoteRoot: this.installRoot, installerPath: posix.join(this.installRoot, 'current', 'bin', 'dsh-remote-artifact-installer.mjs') }).status;
    try {
      if (this.transport?.execArgv) return parseJson((await this.transport.execArgv(command)).stdout, 'RUNTIME_STATUS_INVALID', 'runtime status is invalid');
      return await inspectRemoteArtifact({ kind: 'runtime', id: requirement.id, installRoot: this.installRoot });
    } catch (error) {
      if (['PLUGIN_STATUS_NOT_INSTALLED', 'RUNTIME_NOT_INSTALLED', 'ENOENT'].includes(error?.code)) return { status: 'missing', id: requirement.id };
      throw error;
    }
  }

  async #authState(requirement, status) {
    const driver = this.drivers[requirement.driver] ?? runtimeDriver(requirement.driver);
    if (typeof this.authProbe !== 'function') return { state: 'installed-auth-unverified', auth: { status: 'unverified', method: driver.authMethods[0]?.id ?? 'driver-defined' } };
    let result;
    try { result = await this.authProbe({ requirement: structuredClone(requirement), status: structuredClone(status), driver: { id: driver.id, authMethods: structuredClone(driver.authMethods), permissions: [...driver.permissions], capabilities: [...driver.capabilities] } }); } catch (error) { return { state: 'degraded', auth: { status: 'unknown', error: { code: error.code ?? 'RUNTIME_AUTH_PROBE_FAILED', message: error.message } } }; }
    if (!result || !['ready', 'auth-required', 'installed-auth-unverified', 'degraded'].includes(result.state)) return { state: 'degraded', auth: { status: 'unknown', error: { code: 'RUNTIME_AUTH_PROBE_INVALID', message: 'authentication probe returned an invalid state' } } };
    const auth = result.auth ?? {};
    if (auth.expiresAt !== undefined) {
      const expiry = typeof auth.expiresAt === 'string' ? Date.parse(auth.expiresAt) : Number.NaN;
      if (!Number.isFinite(expiry)) return { state: 'degraded', auth: { status: 'unknown', error: { code: 'RUNTIME_AUTH_EXPIRY_INVALID', message: 'authentication expiry is invalid' } } };
      if (expiry <= Date.now()) return { state: 'auth-required', auth: { ...sanitizeAuth(auth), status: 'expired' } };
      if (expiry - Date.now() > MAX_RUNTIME_AUTH_TTL_MS) return { state: 'degraded', auth: { status: 'unknown', error: { code: 'RUNTIME_AUTH_EXPIRY_TOO_LONG', message: 'authentication expiry exceeds the allowed TTL' } } };
    }
    return { state: result.state, auth: sanitizeAuth(auth) };
  }

  async inspect(requirements = []) {
    if (!Array.isArray(requirements)) fail('runtime requirements must be an array', 'RUNTIME_REQUIREMENTS_INVALID');
    const normalized = validateDesiredState({ dshVersion: this.dshVersion, apiVersion: this.apiVersion, plugins: [], skills: [], runtimes: requirements, defaultPermission: 'workspace-write', modelRoute: 'local-gateway-required' }).runtimes;
    if (normalized.length === 0) return [{ state: 'not-required', id: null, version: null, executable: null }];
    const results = [];
    for (const requirement of normalized) {
      const base = { id: requirement.id, version: requirement.version, driver: requirement.driver, target: requirement.target, executable: null, requiredBy: requirement.requiredBy };
      if (this.platform !== 'linux' || this.arch !== 'x86_64') { results.push({ ...base, state: 'incompatible', reason: 'runtime-target-linux-x86_64-only' }); continue; }
      let status;
      try { status = await this.#artifactStatus(requirement); } catch (error) { results.push({ ...base, state: 'degraded', reason: error.code ?? 'RUNTIME_STATUS_FAILED', error: { message: error.message } }); continue; }
      if (status.status === 'missing') { results.push({ ...base, state: 'missing', reason: 'runtime-artifact-not-installed' }); continue; }
      if (status.status !== 'installed' || status.kind !== 'runtime' || status.id !== requirement.id || status.target !== RUNTIME_TARGET || status.protocolVersion !== requirement.protocolVersion) { results.push({ ...base, state: 'incompatible', reason: 'installed-runtime-identity-mismatch', observed: sanitizeRuntimeStatus(status) }); continue; }
      if (status.version !== requirement.version || status.sha256 !== requirement.sha256 || status.size !== requirement.size || status.packageName !== requirement.packageName || status.executablePath !== requirement.executablePath) { results.push({ ...base, state: 'update-required', reason: 'installed-runtime-version-drift', observed: sanitizeRuntimeStatus(status) }); continue; }
      const auth = await this.#authState(requirement, status);
      results.push({ ...base, ...auth, executable: status.executable, installed: sanitizeRuntimeStatus(status) });
    }
    return results;
  }

  async ensure(requirements = [], { runtimeSync = null } = {}) {
    const states = await this.inspect(requirements);
    const receiptValid = runtimeSync ? validateRuntimeSyncReceipt(runtimeSync, { dshVersion: this.dshVersion, apiVersion: this.apiVersion, plugins: [], skills: [], runtimes: requirements, defaultPermission: 'workspace-write', modelRoute: 'local-gateway-required' }) : requirements.length === 0;
    const blocking = states.filter((item) => !['not-required', 'ready', 'installed-auth-unverified'].includes(item.state));
    return { ok: receiptValid && blocking.length === 0, states, receiptValid, requiresFirstCallConfirmation: states.some((item) => item.state === 'installed-auth-unverified'), requiresAttention: blocking.length > 0 || !receiptValid };
  }

  async resolveExecutable(requirement) {
    const normalized = validateRuntimeRequirement(requirement);
    const state = (await this.inspect([normalized]))[0];
    if (!['ready', 'installed-auth-unverified'].includes(state.state) || typeof state.executable !== 'string' || !isAbsolute(state.executable)) throw new DshRemoteError('runtime executable is not ready', { code: state.state === 'auth-required' ? 'RUNTIME_AUTH_REQUIRED' : 'RUNTIME_NOT_READY', details: state });
    return { executable: state.executable, state: state.state, auth: state.auth ?? null, runtime: normalized };
  }

  async authChallenge(requirement, { output = null } = {}) {
    const normalized = validateRuntimeRequirement(requirement);
    const state = (await this.inspect([normalized]))[0];
    const driver = this.drivers[normalized.driver] ?? runtimeDriver(normalized.driver);
    return { runtimeId: normalized.id, version: normalized.version, state: state.state, challenge: driver.challenge({ executable: state.executable, runtime: normalized, output: typeof output === 'string' ? output.slice(0, 16_384) : null }) };
  }
}

export class StageARuntimeManager extends RuntimeManagerPort {
  async inspect(requirements = []) { if (!Array.isArray(requirements)) throw new DshRemoteError('runtime requirements must be an array', { code: 'RUNTIME_REQUIREMENTS_INVALID' }); return requirements.map((requirement) => ({ id: requirement.id, version: requirement.version, state: 'missing', reason: 'stage-a-runtime-installers-not-implemented', executable: null })); }
  async ensure(requirements = []) { const states = await this.inspect(requirements); return { ok: states.length === 0, states, requiresAttention: states.length > 0 }; }
}

export function runtimeDriver(driver) {
  const definition = DRIVER_DEFINITIONS[driver];
  if (!definition) fail('runtime driver is invalid', 'RUNTIME_DRIVER_INVALID');
  return { ...definition, challenge({ executable, runtime, output }) { return { executable, runtimeId: runtime.id, methods: definition.authMethods, ...(driver === 'grok-build' && output ? parseGrokDeviceAuthOutput(output) : {}) }; } };
}

export function parseGrokDeviceAuthOutput(output) {
  if (typeof output !== 'string') return {};
  const bounded = output.slice(0, 16_384);
  const urlMatch = bounded.match(/https:\/\/(?:[A-Za-z0-9-]+\.)?(?:x\.ai|grok\.com)(?:\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]*)?/iu);
  // Match only a labelled device/verification code. This avoids treating an
  // identifier, URL segment, or token-shaped text as a user-facing challenge.
  const codeMatch = bounded.match(/(?:device\s*code|verification\s*code)\s*[:：]?\s*([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?)/iu);
  return { ...(urlMatch ? { url: urlMatch[0] } : {}), ...(codeMatch ? { userCode: codeMatch[1] } : {}) };
}

function sanitizeRuntimeStatus(value) { if (!value || typeof value !== 'object') return null; return { status: value.status, kind: value.kind, id: value.id, version: value.version, sha256: value.sha256, size: value.size, packageName: value.packageName, executablePath: value.executablePath, target: value.target, protocolVersion: value.protocolVersion }; }
function sanitizeAuth(auth) { return { status: auth.status, method: auth.method, expiresAt: auth.expiresAt, url: auth.url, userCode: auth.userCode, ...(auth.error ? { error: { code: auth.error.code, message: auth.error.message } } : {}) }; }

export function assertRuntimeState(value) { if (!RUNTIME_STATES.includes(value)) throw new DshRemoteError(`invalid runtime state: ${value}`, { code: 'RUNTIME_STATE_INVALID' }); }

export class RuntimeSynchronizer {
  constructor({ registry, transport, remoteRoot = '/home/.dsh-remote', installerPath = '/home/.dsh-remote/current/bin/dsh-remote-artifact-installer.mjs', dshVersion = '0.1.0-rc.6', apiVersion = '1.0' } = {}) {
    if (!registry || typeof registry.resolve !== 'function') fail('RuntimeSynchronizer requires a trusted registry', 'RUNTIME_CONFIG_ERROR');
    if (!transport || typeof transport.execArgv !== 'function' || typeof transport.upload !== 'function') fail('RuntimeSynchronizer requires an argv/upload transport', 'RUNTIME_CONFIG_ERROR');
    this.registry = registry; this.transport = transport; this.remoteRoot = safeRuntimeInstallRoot(remoteRoot); this.installerPath = installerPath; this.dshVersion = dshVersion; this.apiVersion = apiVersion; this.statuses = new Map();
  }

  async plan({ desiredState, operationId } = {}) {
    const state = validateDesiredState(desiredState); const actions = [];
    for (const { requirement } of runtimeRequirements(state)) {
      const entry = await this.registry.resolve({ kind: 'runtime', ...requirement }, { dshVersion: state.dshVersion, apiVersion: state.apiVersion }); const encoded = encodedRuntimeId(requirement.id);
      actions.push({ key: runtimeKey(requirement), kind: 'runtime', id: requirement.id, version: requirement.version, sha256: requirement.sha256, size: requirement.size, packageName: requirement.packageName, executablePath: requirement.executablePath, target: requirement.target, protocolVersion: requirement.protocolVersion, driver: requirement.driver, authPolicy: requirement.authPolicy, capabilities: requirement.capabilities, artifactPath: entry.artifactPath, remoteRoot: this.remoteRoot, remoteStagingRoot: posix.join(this.remoteRoot, 'staging', 'runtimes', encoded), remoteArtifactPath: posix.join(this.remoteRoot, 'staging', 'runtimes', encoded, `${encoded}-${requirement.version}.tgz`), installerPath: this.installerPath });
    }
    return { operationId, desiredStateSha256: sha256(stableJson(state)), actions };
  }

  async sync({ desiredState, operationId } = {}) {
    const id = operationId ?? `runtime-sync-${Date.now().toString(36)}`; let plan;
    try { plan = await this.plan({ desiredState, operationId: id }); } catch (error) { const state = typeof desiredState === 'object' && desiredState !== null ? validateDesiredState(desiredState) : null; const result = { status: 'incompatible', operationId: id, desiredStateSha256: state ? sha256(stableJson(state)) : null, items: [], rollback: { attempted: false, status: 'not-attempted', items: [] }, error: { code: error.code ?? 'RUNTIME_SYNC_REJECTED', message: error.message, details: error.details } }; this.statuses.set(id, result); return structuredClone(result); }
    if (plan.actions.length === 0) { const result = { status: 'completed', operationId: id, desiredStateSha256: plan.desiredStateSha256, items: [], rollback: { attempted: false, status: 'not-attempted', items: [] }, planDigest: sha256(stableJson(plan)), states: [{ state: 'not-required' }] }; this.statuses.set(id, result); return structuredClone(result); }
    const completed = []; const attempted = [];
    try {
      for (const action of plan.actions) { let result; try { result = await this.#syncAction(action); } catch (error) { if (error.syncActionContext) attempted.push(error.syncActionContext); throw error; } attempted.push(result.context); completed.push(result.item); }
      const result = { status: 'completed', operationId: id, desiredStateSha256: plan.desiredStateSha256, items: completed, rollback: { attempted: false, status: 'not-attempted', items: [] }, planDigest: sha256(stableJson(plan)), states: completed.map((item) => ({ id: item.id, version: item.version, state: 'installed-auth-unverified' })) }; this.statuses.set(id, result); return structuredClone(result);
    } catch (error) {
      const rollback = await this.#rollback(attempted); const status = rollback.status === 'unknown' || isUnknownTransport(error) && rollback.status !== 'completed' ? 'persistence-unknown' : 'needs-attention'; const result = { status, operationId: id, desiredStateSha256: plan.desiredStateSha256, items: completed, rollback, planDigest: sha256(stableJson(plan)), states: [], error: { code: error.code ?? 'RUNTIME_SYNC_FAILED', message: error.message, details: error.details }, plan }; this.statuses.set(id, result); return structuredClone(result);
    }
  }

  async reconcile(operationId) {
    const current = this.statuses.get(operationId); if (!current?.plan) return structuredClone(current ?? { status: 'unknown', operationId }); const observed = new Map();
    const readStatus = async (action) => { if (observed.has(action.key)) return observed.get(action.key); try { const value = parseJson((await this.transport.execArgv(buildRuntimeSyncCommands(action).status)).stdout, 'RUNTIME_STATUS_INVALID', 'runtime status is invalid'); const result = { status: 'ok', value }; observed.set(action.key, result); return result; } catch (error) { const result = { status: 'unknown', error }; observed.set(action.key, result); return result; } };
    const items = []; let targetUnknown = false;
    for (const action of current.plan.actions) { const result = await readStatus(action); if (result.status === 'ok' && statusMatches(result.value, action)) items.push({ key: action.key, status: 'verified', id: action.id, version: action.version, sha256: action.sha256, size: action.size, packageName: action.packageName, executablePath: action.executablePath, target: action.target, protocolVersion: action.protocolVersion }); else { targetUnknown = true; items.push({ key: action.key, status: result.status === 'ok' ? 'not-current' : 'unknown', id: action.id, version: action.version, sha256: action.sha256, size: action.size, packageName: action.packageName, executablePath: action.executablePath, target: action.target, protocolVersion: action.protocolVersion, ...(result.status === 'ok' ? { observed: sanitizeRuntimeStatus(result.value) } : { error: { code: result.error.code ?? 'RUNTIME_STATUS_UNKNOWN', message: result.error.message } }) }); } }
    let rollback = current.rollback ?? { attempted: false, status: 'not-attempted', items: [] };
    if (rollback.attempted) { const rollbackItems = []; let unknown = false; let failed = false; for (const item of rollback.items) { const action = current.plan.actions.find((candidate) => candidate.key === item.key); if (!action) { unknown = true; rollbackItems.push({ ...item, status: 'unknown' }); continue; } const result = await readStatus(action); let matched = false; if (result.status === 'ok') { const observedTarget = result.value.status === 'missing' ? { status: 'missing' } : runtimeTargetFromStatus(result.value); matched = item.target.status === 'missing' ? observedTarget.status === 'missing' : observedTarget.version === item.target.version && observedTarget.sha256 === item.target.sha256 && observedTarget.executablePath === item.target.executablePath; } if (matched) rollbackItems.push({ ...item, status: 'completed', observed: sanitizeRuntimeStatus(result.value) }); else if (result.status === 'ok') { failed = true; rollbackItems.push({ ...item, status: 'failed', observed: sanitizeRuntimeStatus(result.value) }); } else { unknown = true; rollbackItems.push({ ...item, status: 'unknown', error: { code: result.error.code ?? 'RUNTIME_STATUS_UNKNOWN', message: result.error.message } }); } } rollback = { ...rollback, status: unknown ? 'unknown' : failed ? 'failed' : 'completed', items: rollbackItems }; }
    const status = rollback.attempted ? (rollback.status === 'completed' ? 'needs-attention' : 'persistence-unknown') : targetUnknown ? 'needs-attention' : 'completed'; const result = { ...current, status, reconciled: true, targetStatus: targetUnknown ? 'not-current-or-unknown' : 'completed', items, rollback }; this.statuses.set(operationId, result); return structuredClone(result);
  }

  async #syncAction(action) {
    const commands = buildRuntimeSyncCommands(action); let remote;
    try { remote = parseJson((await this.transport.execArgv(commands.status)).stdout, 'RUNTIME_STATUS_INVALID', 'runtime status is invalid'); } catch (error) { if (error.code === 'RUNTIME_NOT_INSTALLED' || error.code === 'PLUGIN_STATUS_NOT_INSTALLED') remote = { status: 'missing' }; else throw error; }
    const previous = runtimeTargetFromStatus(remote); const context = { key: action.key, action, previous, changed: false }; if (statusMatches(remote, action)) return { item: { key: action.key, id: action.id, status: 'reused', version: action.version, sha256: action.sha256, size: action.size, packageName: action.packageName, executablePath: action.executablePath, target: action.target, protocolVersion: action.protocolVersion, previous, changed: false }, context }; context.changed = true;
    try { await this.transport.execArgv(commands.mkdir); await this.transport.upload(action.artifactPath, action.remoteArtifactPath, { sha256: action.sha256, size: action.size }); const installed = parseJson((await this.transport.execArgv(commands.install)).stdout, 'RUNTIME_INSTALL_RESULT_INVALID', 'runtime installer returned invalid JSON'); if (!statusMatches(installed, action)) fail('runtime installer did not return the requested verified artifact', 'RUNTIME_INSTALL_RESULT_INVALID'); const probe = parseJson((await this.transport.execArgv(commands.probe)).stdout, 'RUNTIME_PROBE_INVALID', 'runtime probe returned invalid JSON'); if (!statusMatches(probe, action)) fail('runtime probe did not confirm the requested artifact', 'RUNTIME_PROBE_FAILED'); await this.transport.execArgv(commands.cleanup); await this.transport.execArgv(commands.cleanupDir); return { item: { key: action.key, id: action.id, status: 'installed', version: action.version, sha256: action.sha256, size: action.size, packageName: action.packageName, executablePath: action.executablePath, target: action.target, protocolVersion: action.protocolVersion, previous, changed: true }, context }; } catch (error) { Object.defineProperty(error, 'syncActionContext', { value: context, enumerable: false, configurable: true }); throw error; }
  }

  async #rollback(attempted) {
    const changed = attempted.filter((item) => item.changed).reverse(); if (changed.length === 0) return { attempted: false, status: 'not-attempted', items: [] }; const items = []; let unknown = false; let failed = false;
    for (const context of changed) { try { const result = parseJson((await this.transport.execArgv(buildRuntimeSyncCommands(context.action).rollback(context.previous))).stdout, 'RUNTIME_ROLLBACK_RESULT_INVALID', 'runtime rollback returned invalid JSON'); if (!rollbackResultMatches(result, context.previous)) fail('runtime rollback did not confirm its target receipt', 'RUNTIME_ROLLBACK_RESULT_INVALID'); items.push({ key: context.key, status: 'completed', target: context.previous }); } catch (error) { const isUnknown = isUnknownTransport(error) || error.code === 'RUNTIME_ROLLBACK_RESULT_INVALID'; if (isUnknown) unknown = true; else failed = true; items.push({ key: context.key, status: isUnknown ? 'unknown' : 'failed', target: context.previous, error: { code: error.code ?? 'RUNTIME_ROLLBACK_FAILED', message: error.message } }); } }
    return { attempted: true, status: unknown ? 'unknown' : failed ? 'failed' : 'completed', items };
  }
}
