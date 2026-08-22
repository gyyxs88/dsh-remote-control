import { isAbsolute, posix } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  codex: { id: 'codex', authCommand: ['login'], authMethods: [{ id: 'codex-login', kind: 'browser', label: 'OpenAI Codex official login', instructions: 'Start the fixed official `codex login` flow in the remote user context; DSH never handles the credential.' }], permissions: ['read-only', 'workspace-write', 'danger-full-access'], capabilities: ['exec', 'app-server', 'approval-requests'] },
  'claude-code': { id: 'claude-code', authCommand: ['auth', 'login'], authMethods: [{ id: 'claude-login', kind: 'browser-or-enterprise', label: 'Claude Code official login', instructions: 'Start the fixed official `claude auth login` flow, Claude Console, or the configured enterprise provider; DSH never handles the credential.' }], permissions: ['read-only', 'workspace-write', 'danger-full-access'], capabilities: ['headless', 'agent-sdk', 'approval-callback'] },
  'grok-build': { id: 'grok-build', authCommand: ['login', '--device-auth'], authMethods: [{ id: 'grok-device-auth', kind: 'device-code', label: 'Grok Build device authentication', instructions: 'Start the fixed official `grok login --device-auth` flow and complete the public URL/device code; DSH never receives the resulting credential.' }, { id: 'grok-api-key', kind: 'api-key', label: 'Grok API authentication', instructions: 'Inject XAI_API_KEY through the approved remote process environment; DSH never stores or echoes it.' }], permissions: ['read-only', 'workspace-write', 'danger-full-access'], capabilities: ['headless', 'acp', 'permission-mode', 'sandbox-profile'] },
  acp: { id: 'acp', authCommand: null, authMethods: [{ id: 'agent-defined', kind: 'agent-defined', label: 'ACP agent-defined authentication', instructions: 'Use the fixed auth negotiation defined by the ACP driver; DSH forwards only public challenge metadata.' }], permissions: [], capabilities: ['initialize', 'auth-negotiation'] },
});

const SAFE_RELATIVE_EXECUTABLE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._+@-]+(?:\/[A-Za-z0-9._+@-]+)*$/u;
const MAX_RUNTIME_AUTH_TTL_MS = 24 * 60 * 60 * 1000;
const RUNTIME_AUTH_LEASE_TTL_MS = 15 * 60 * 1000;
const MAX_MANAGED_AUTH_CHALLENGES = 64;

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
  async commitAuthReservation(_requirement, _context) { throw new DshRemoteError('RuntimeManagerPort.commitAuthReservation is not implemented', { code: 'RUNTIME_PORT_NOT_IMPLEMENTED' }); }
  async authChallenge(_requirement) { throw new DshRemoteError('RuntimeManagerPort.authChallenge is not implemented', { code: 'RUNTIME_PORT_NOT_IMPLEMENTED' }); }
  async authChallengeStatus(_challengeId) { throw new DshRemoteError('RuntimeManagerPort.authChallengeStatus is not implemented', { code: 'RUNTIME_PORT_NOT_IMPLEMENTED' }); }
  async authChallengeCancel(_challengeId) { throw new DshRemoteError('RuntimeManagerPort.authChallengeCancel is not implemented', { code: 'RUNTIME_PORT_NOT_IMPLEMENTED' }); }
  async close() {}
}

export function createBoundedAuthRunner({ spawnImpl = spawn, killGraceMs = 1_000 } = {}) {
  const active = new Set();
  const terminate = (child) => {
    if (!child) return;
    const pid = Number.isSafeInteger(child.pid) ? child.pid : null;
    let groupSignalled = false;
    if (pid && process.platform !== 'win32') {
      try { process.kill(-pid, 'SIGTERM'); groupSignalled = true; } catch {}
    } else if (pid && process.platform === 'win32') {
      try {
        const killer = spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer?.once?.('error', () => { try { child.kill?.('SIGTERM'); } catch {} });
        groupSignalled = true;
      } catch {}
    }
    if (!groupSignalled) {
      try { child.kill?.('SIGTERM'); } catch {}
    }
    const killTimer = setTimeout(() => {
      if (pid && process.platform !== 'win32') {
        try { process.kill(-pid, 'SIGKILL'); } catch {}
      } else if (!groupSignalled) {
        try { child.kill?.('SIGKILL'); } catch {}
      }
    }, killGraceMs);
    killTimer.unref?.();
  };
  const start = (argv, { timeoutMs = 60_000, signal, maxStdoutBytes = 16_384, maxStderrBytes = 16_384, challengeTtlMs = 15 * 60_000, parseChallenge = parsePublicAuthChallenge } = {}) => {
    if (!Array.isArray(argv) || typeof argv[0] !== 'string' || argv[0].length === 0) {
      const error = new DshRemoteError('runtime auth command argv is invalid', { code: 'RUNTIME_AUTH_ARGV_INVALID' });
      throw error;
    }
    let child;
    try { child = spawnImpl(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }); }
    catch (error) { throw error; }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let phase = 'running';
    let terminal = null;
    let publicChallenge = null;
    let timer;
    let challengeTimer;
    let handle;
    let doneResolve;
    let doneReject;
    let challengeResolve;
    const challengePromise = new Promise((resolve) => { challengeResolve = resolve; });
    const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
    handle = {
      pid: child.pid ?? null,
      argv: [...argv],
      challenge: challengePromise,
      done,
      status() { return { phase, pid: child.pid ?? null, challenge: publicChallenge ? structuredClone(publicChallenge) : null, ...(terminal?.error ? { error: { ...terminal.error } } : {}) }; },
      cancel() { onAbort(); return done.catch(() => undefined); },
    };
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (challengeTimer !== undefined) clearTimeout(challengeTimer);
      signal?.removeEventListener('abort', onAbort);
      active.delete(handle);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      terminal = error ? { phase, error: { code: error.code ?? 'RUNTIME_AUTH_FAILED', message: error.message } } : { phase, result: value };
      cleanup();
      challengeResolve(publicChallenge);
      if (error) {
        if (phase === 'running') phase = error.code === 'RUNTIME_AUTH_TIMEOUT' ? 'timed-out' : error.code === 'RUNTIME_AUTH_CANCELLED' ? 'cancelled' : 'failed';
        terminal.phase = phase;
        doneReject(error);
      } else doneResolve(value);
    };
    const onAbort = () => {
      if (settled) return;
      phase = 'cancelled';
      terminate(child);
      finish(new DshRemoteError('runtime auth command was cancelled', { code: 'RUNTIME_AUTH_CANCELLED' }));
    };
    active.add(handle);
    const output = (kind, chunk) => {
      const text = String(chunk);
      if (kind === 'stdout') {
        stdout += text;
        if (Buffer.byteLength(stdout, 'utf8') > maxStdoutBytes) {
          phase = 'failed';
          terminate(child);
          finish(new DshRemoteError('runtime auth stdout exceeded limit', { code: 'RUNTIME_AUTH_OUTPUT_TOO_LARGE' }));
        }
      } else {
        stderr += text;
        if (Buffer.byteLength(stderr, 'utf8') > maxStderrBytes) {
          phase = 'failed';
          terminate(child);
          finish(new DshRemoteError('runtime auth stderr exceeded limit', { code: 'RUNTIME_AUTH_OUTPUT_TOO_LARGE' }));
        }
      }
      if (settled || publicChallenge) return;
      try {
        const parsed = parseChallenge(`${stdout}\n${stderr}`);
        if (parsed && (parsed.url || parsed.userCode)) {
          publicChallenge = { ...(parsed.url ? { url: parsed.url } : {}), ...(parsed.userCode ? { userCode: parsed.userCode } : {}), expiresAt: new Date(Date.now() + challengeTtlMs).toISOString() };
          challengeResolve(publicChallenge);
          challengeTimer = setTimeout(() => {
            if (settled) return;
            phase = 'expired';
            terminate(child);
            finish(new DshRemoteError('runtime auth public challenge expired', { code: 'RUNTIME_AUTH_CHALLENGE_EXPIRED' }));
          }, challengeTtlMs);
          challengeTimer.unref?.();
        }
      } catch {}
    };
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => output('stdout', chunk));
    child.stderr?.on?.('data', (chunk) => output('stderr', chunk));
    child.once?.('error', (error) => finish(new DshRemoteError(`runtime auth command failed: ${error.message}`, { code: 'RUNTIME_AUTH_COMMAND_FAILED' })));
    child.once?.('close', (code, signalName) => {
      if (settled) return;
      if (code === 0) { phase = 'completed'; finish(null, { code, signal: signalName, stdout, stderr }); }
      else { phase = 'failed'; finish(new DshRemoteError('runtime auth command exited unsuccessfully', { code: 'RUNTIME_AUTH_COMMAND_FAILED', details: { code, signal: signalName } })); }
    });
    timer = setTimeout(() => {
      if (settled) return;
      phase = 'timed-out';
      terminate(child);
      finish(new DshRemoteError('runtime auth command timed out', { code: 'RUNTIME_AUTH_TIMEOUT' }));
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    return handle;
  };
  const runner = (argv, options = {}) => {
    let handle;
    try { handle = start(argv, options); } catch (error) { return Promise.reject(error); }
    return handle.done;
  };
  runner.start = start;
  runner.close = () => Promise.all([...active].map((handle) => handle.cancel()));
  return runner;
}

/** Remote authority. It never searches PATH or reads vendor login directories. */
export class InstalledRuntimeManager extends RuntimeManagerPort {
  constructor({ transport = null, installRoot = '/home/.dsh-remote', authProbe = null, authRunner = null, platform = 'linux', arch = 'x86_64', dshVersion = '0.1.1-rc.2', apiVersion = '1.0', drivers = {} } = {}) {
    super();
    this.transport = transport;
    this.installRoot = safeRuntimeInstallRoot(installRoot);
    this.authProbe = authProbe;
    this.authRunner = authRunner;
    this.platform = platform;
    this.arch = arch;
    this.dshVersion = dshVersion;
    this.apiVersion = apiVersion;
    this.drivers = drivers;
    this.pendingAuthConfirmations = new Map();
    this.authLeases = new Map();
    this.authReservationCommits = new Map();
    this.authAudit = [];
    this.managedAuthChallenges = new Map();
    this.authChallengeByRuntime = new Map();
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

  #confirmationKey(requirement) { return `${requirement.id}\u0000${requirement.version}\u0000${requirement.sha256}`; }

  #reservationKey(requirement, sourceSessionId, operationId) { return `${this.#confirmationKey(requirement)}\u0000${sourceSessionId}\u0000${operationId}`; }

  #leaseKey(requirement, targetSessionId, sourceSessionId) { return `${this.#confirmationKey(requirement)}\u0000${sourceSessionId ?? '*'}\u0000${targetSessionId ?? '*'}`; }

  #leaseFor(requirement, targetSessionId, sourceSessionId) {
    const exact = this.authLeases.get(this.#leaseKey(requirement, targetSessionId, sourceSessionId));
    const wildcard = targetSessionId === undefined || targetSessionId === null ? this.authLeases.get(this.#leaseKey(requirement, null, sourceSessionId)) : null;
    const lease = exact ?? wildcard;
    if (!lease || Date.parse(lease.expiresAt) <= Date.now()) {
      if (lease) this.authLeases.delete(this.#leaseKey(requirement, lease.targetSessionId, lease.sourceSessionId));
      return null;
    }
    return lease;
  }

  #validateAuthConfirmation(requirement, confirmation, { sourceSessionId, targetSessionId, operationId } = {}) {
    if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation)) return false;
    if (confirmation.runtimeId !== requirement.id || confirmation.version !== requirement.version || confirmation.sha256 !== requirement.sha256) return false;
    if (confirmation.authority !== 'dsh-session-control' || confirmation.approved !== true || typeof confirmation.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(confirmation.nonce)) return false;
    if (typeof confirmation.sourceSessionId !== 'string' || typeof confirmation.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(confirmation.operationId) || typeof confirmation.reservationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(confirmation.reservationId) || (confirmation.targetSessionId !== null && (typeof confirmation.targetSessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(confirmation.targetSessionId))) || (sourceSessionId !== undefined && confirmation.sourceSessionId !== sourceSessionId) || (operationId !== undefined && confirmation.operationId !== operationId) || (confirmation.targetSessionId !== null && targetSessionId !== undefined && confirmation.targetSessionId !== null && confirmation.targetSessionId !== targetSessionId)) return false;
    const expiresAt = Date.parse(confirmation.expiresAt);
    const issuedAt = Date.parse(confirmation.issuedAt);
    const recoverableReservation = confirmation.recoverable === true && operationId !== undefined && confirmation.operationId === operationId;
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > Date.now() || (!recoverableReservation && expiresAt <= Date.now()) || expiresAt - issuedAt > MAX_RUNTIME_AUTH_TTL_MS) return false;
    return true;
  }

  #stageAuthConfirmation(requirement, confirmation, context) {
    if (!this.#validateAuthConfirmation(requirement, confirmation, context)) {
      this.authAudit.push({ runtimeId: requirement.id, version: requirement.version, result: 'rejected', reason: 'invalid-or-expired-confirmation', at: new Date().toISOString() });
      return false;
    }
    const key = this.#reservationKey(requirement, confirmation.sourceSessionId, confirmation.operationId);
    const existing = this.pendingAuthConfirmations.get(key);
    if (existing && (existing.reservationId !== confirmation.reservationId || existing.runtimeId !== confirmation.runtimeId || existing.version !== confirmation.version || existing.sha256 !== confirmation.sha256)) return false;
    this.pendingAuthConfirmations.set(key, { ...existing, ...confirmation, stagedAt: existing?.stagedAt ?? new Date().toISOString() });
    this.authAudit.push({ runtimeId: requirement.id, version: requirement.version, result: 'staged', sourceSessionId: confirmation.sourceSessionId, targetSessionId: confirmation.targetSessionId, at: new Date().toISOString() });
    return true;
  }

  async commitAuthReservation(requirement, { reservationId, operationId, sourceSessionId, targetSessionId } = {}) {
    const normalized = validateRuntimeRequirement(requirement);
    if (typeof reservationId !== 'string' || typeof operationId !== 'string' || typeof sourceSessionId !== 'string' || typeof targetSessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(operationId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(sourceSessionId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(targetSessionId)) throw new DshRemoteError('runtime auth reservation identity is invalid', { code: 'RUNTIME_AUTH_RESERVATION_INVALID' });
    const key = this.#reservationKey(normalized, sourceSessionId, operationId);
    const committed = this.authReservationCommits.get(key);
    if (committed) {
      if (committed.reservationId !== reservationId || committed.targetSessionId !== targetSessionId) throw new DshRemoteError('runtime auth reservation was already committed to another target', { code: 'RUNTIME_AUTH_RESERVATION_CONFLICT' });
      return { committed: true, lease: structuredClone(committed.lease) };
    }
    const pending = this.pendingAuthConfirmations.get(key);
    if (!pending || pending.reservationId !== reservationId || !this.#validateAuthConfirmation(normalized, pending, { sourceSessionId, operationId })) throw new DshRemoteError('runtime auth reservation is unknown, expired, or bound to another operation', { code: 'RUNTIME_AUTH_RESERVATION_INVALID' });
    if (pending.targetSessionId !== null && pending.targetSessionId !== targetSessionId) throw new DshRemoteError('runtime auth reservation target mismatch', { code: 'RUNTIME_AUTH_RESERVATION_CONFLICT' });
    const lease = { runtimeId: pending.runtimeId, version: pending.version, sha256: pending.sha256, sourceSessionId, targetSessionId, reservationId, operationId, expiresAt: new Date(Date.now() + RUNTIME_AUTH_LEASE_TTL_MS).toISOString() };
    this.authLeases.set(this.#leaseKey(normalized, targetSessionId, sourceSessionId), lease);
    this.authReservationCommits.set(key, { reservationId, targetSessionId, lease });
    this.pendingAuthConfirmations.delete(key);
    this.authAudit.push({ runtimeId: normalized.id, version: normalized.version, result: 'committed', sourceSessionId, operationId, targetSessionId, at: new Date().toISOString() });
    return { committed: true, lease: structuredClone(lease) };
  }

  restoreAuthReservation(reservation) {
    if (!reservation || !['reserved', 'committed'].includes(reservation.status)) return false;
    const requirement = validateRuntimeRequirement({
      id: reservation.runtimeId,
      version: reservation.version,
      placement: 'remote',
      source: { registry: 'restored', artifact: reservation.runtimeId },
      sha256: reservation.sha256,
      size: reservation.size,
      target: reservation.target,
      packageName: reservation.packageName,
      executablePath: reservation.executablePath,
      protocolVersion: reservation.protocolVersion,
      driver: reservation.driver,
      authPolicy: reservation.authPolicy,
      capabilities: reservation.capabilities ?? [],
      compatibility: reservation.compatibility ?? { dsh: { min: this.dshVersion, max: this.dshVersion }, api: { min: this.apiVersion, max: this.apiVersion } },
      requiredBy: reservation.requiredBy ?? ['restored:reservation'],
    });
    const key = this.#reservationKey(requirement, reservation.sourceSessionId, reservation.operationId);
    if (reservation.status === 'committed' && typeof reservation.targetSessionId === 'string') {
      const lease = {
        runtimeId: reservation.runtimeId,
        version: reservation.version,
        sha256: reservation.sha256,
        sourceSessionId: reservation.sourceSessionId,
        targetSessionId: reservation.targetSessionId,
        reservationId: reservation.reservationId,
        operationId: reservation.operationId,
        expiresAt: reservation.leaseExpiresAt ?? new Date(Date.now() + RUNTIME_AUTH_LEASE_TTL_MS).toISOString(),
      };
      this.authLeases.set(this.#leaseKey(requirement, reservation.targetSessionId, reservation.sourceSessionId), lease);
      this.authReservationCommits.set(key, { reservationId: reservation.reservationId, targetSessionId: reservation.targetSessionId, lease });
      return true;
    }
    this.pendingAuthConfirmations.set(key, { ...reservation, targetSessionId: reservation.targetSessionId ?? null, reservationId: reservation.reservationId, operationId: reservation.operationId, recoverable: reservation.sessionControlAttempted === true, authority: 'dsh-session-control', approved: true });
    return true;
  }

  async ensure(requirements = [], { runtimeSync = null, authConfirmation = null, sourceSessionId, targetSessionId, operationId } = {}) {
    const states = await this.inspect(requirements);
    let receiptValid = requirements.length === 0;
    if (runtimeSync) {
      try {
        validateRuntimeSyncReceipt(runtimeSync, { dshVersion: this.dshVersion, apiVersion: this.apiVersion, plugins: [], skills: [], runtimes: requirements, defaultPermission: 'workspace-write', modelRoute: 'local-gateway-required' });
        receiptValid = true;
      } catch {
        receiptValid = false;
      }
    }
    for (const state of states) {
      if (state.state === 'installed-auth-unverified') {
        const requirement = requirements.find((item) => item.id === state.id && item.version === state.version);
        const confirmation = requirement && authConfirmation && typeof authConfirmation === 'object' && !Array.isArray(authConfirmation) && authConfirmation[requirement.id]?.runtimeId
          ? authConfirmation[requirement.id]
          : authConfirmation;
        if (requirement && confirmation) this.#stageAuthConfirmation(requirement, confirmation, { sourceSessionId, targetSessionId, operationId });
        const reserved = requirement && operationId && sourceSessionId ? this.pendingAuthConfirmations.has(this.#reservationKey(requirement, sourceSessionId, operationId)) : false;
        state.authConfirmation = reserved ? 'staged' : this.#leaseFor(requirement, targetSessionId, sourceSessionId) ? 'leased' : 'required';
      }
    }
    const blocking = states.filter((item) => !['not-required', 'ready'].includes(item.state) && !(item.state === 'installed-auth-unverified' && ['staged', 'leased'].includes(item.authConfirmation)));
    return { ok: receiptValid && blocking.length === 0, states, receiptValid, requiresFirstCallConfirmation: states.some((item) => item.state === 'installed-auth-unverified' && !['staged', 'leased'].includes(item.authConfirmation)), requiresAttention: blocking.length > 0 || !receiptValid };
  }

  async resolveExecutable(requirement, { authConfirmation = null, sourceSessionId, targetSessionId, operationId } = {}) {
    const normalized = validateRuntimeRequirement(requirement);
    const state = (await this.inspect([normalized]))[0];
    if (state.state === 'installed-auth-unverified' && !this.#leaseFor(normalized, targetSessionId, sourceSessionId)) {
      throw new DshRemoteError('runtime authentication confirmation is required before first model call', { code: 'RUNTIME_AUTH_CONFIRMATION_REQUIRED', details: { ...state, requiresFirstCallConfirmation: true } });
    }
    if (!['ready', 'installed-auth-unverified'].includes(state.state) || typeof state.executable !== 'string' || !isAbsolute(state.executable)) throw new DshRemoteError('runtime executable is not ready', { code: state.state === 'auth-required' ? 'RUNTIME_AUTH_REQUIRED' : 'RUNTIME_NOT_READY', details: state });
    return { executable: state.executable, state: state.state, auth: state.auth ?? null, authConfirmed: state.state === 'installed-auth-unverified', authLeaseExpiresAt: this.#leaseFor(normalized, targetSessionId)?.expiresAt ?? null, runtime: normalized };
  }

  async authChallenge(requirement, { signal, timeoutMs = 60_000 } = {}) {
    const normalized = validateRuntimeRequirement(requirement);
    const state = (await this.inspect([normalized]))[0];
    const driver = this.drivers[normalized.driver] ?? runtimeDriver(normalized.driver);
    const base = { runtimeId: normalized.id, version: normalized.version, state: state.state, challenge: driver.challenge({ executable: state.executable, runtime: normalized }) };
    if (!driver.authCommand || typeof state.executable !== 'string' || !isAbsolute(state.executable)) return { ...base, executableHintOnly: true };
    const argv = [state.executable, ...driver.authCommand];
    const runner = this.authRunner ?? (this.transport?.execArgv ? (command, options) => this.transport.execArgv(command, options) : null);
    if (typeof runner !== 'function') return { ...base, executableHintOnly: true, argv };
    if (typeof runner.start === 'function') {
      this.#pruneManagedAuthChallenges();
      const runtimeId = this.#confirmationKey(normalized);
      const existingId = this.authChallengeByRuntime.get(runtimeId);
      if (existingId && this.managedAuthChallenges.has(existingId)) return this.authChallengeStatus(existingId);
      const challengeId = randomUUID().replaceAll('-', '');
      const handle = runner.start(argv, {
        timeoutMs,
        signal,
        maxStdoutBytes: 16_384,
        maxStderrBytes: 16_384,
        challengeTtlMs: 15 * 60_000,
        parseChallenge: (output) => parsePublicAuthChallenge(output, normalized.driver),
      });
      const record = { challengeId, runtimeId, requirement: normalized, state, argv, handle, baseChallenge: base.challenge, startedAt: new Date().toISOString(), challengeExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), authState: null };
      this.managedAuthChallenges.set(challengeId, record);
      this.authChallengeByRuntime.set(runtimeId, challengeId);
      handle.done.then(() => this.#finishManagedAuth(record), () => this.#finishManagedAuth(record)).catch(() => undefined);
      const observed = await Promise.race([
        handle.challenge,
        new Promise((resolve) => setTimeout(() => resolve(null), 250)),
      ]);
      return this.#managedAuthResult(record, observed);
    }
    try {
      const result = await runner(argv, { timeoutMs, signal, maxStdoutBytes: 16_384, maxStderrBytes: 16_384 });
      const output = `${String(result?.stdout ?? '').slice(0, 16_384)}\n${String(result?.stderr ?? '').slice(0, 16_384)}`;
      return { ...base, argv, challenge: driver.challenge({ executable: state.executable, runtime: normalized, output }), authStateChanged: false };
    } catch (error) {
      return { ...base, argv, challenge: { ...base.challenge, status: 'unknown', error: { code: error.code ?? 'RUNTIME_AUTH_CHALLENGE_FAILED', message: error.message } }, authStateChanged: false };
    }
  }

  async #finishManagedAuth(record) {
    if (record.authState) return;
    const status = record.handle.status();
    if (status.phase === 'completed') {
      try { record.authState = await this.#authState(record.requirement, record.state.installed ?? record.state); }
      catch (error) { record.authState = { state: 'degraded', auth: { status: 'unknown', error: { code: error.code ?? 'RUNTIME_AUTH_PROBE_FAILED', message: error.message } } }; }
    } else if (status.phase !== 'running') {
      record.authState = { state: 'installed-auth-unverified', auth: { status: 'unverified' } };
    }
  }

  #pruneManagedAuthChallenges() {
    if (this.managedAuthChallenges.size < MAX_MANAGED_AUTH_CHALLENGES) return;
    for (const [challengeId, record] of this.managedAuthChallenges) {
      if (record.handle.status().phase !== 'running') {
        this.managedAuthChallenges.delete(challengeId);
        if (this.authChallengeByRuntime.get(record.runtimeId) === challengeId) this.authChallengeByRuntime.delete(record.runtimeId);
      }
      if (this.managedAuthChallenges.size < MAX_MANAGED_AUTH_CHALLENGES) return;
    }
    fail('too many managed runtime auth challenges are active', 'RUNTIME_AUTH_CHALLENGE_LIMIT');
  }

  async #managedAuthResult(record, observed = null) {
    await this.#finishManagedAuth(record);
    const status = record.handle.status();
    const publicChallenge = observed ?? status.challenge;
    const phase = status.phase;
    const challenge = {
      ...record.baseChallenge,
      ...(publicChallenge ?? {}),
      status: phase === 'running' ? 'pending' : phase,
      expiresAt: publicChallenge?.expiresAt ?? record.challengeExpiresAt,
    };
    return {
      challengeId: record.challengeId,
      runtimeId: record.requirement.id,
      version: record.requirement.version,
      state: record.state.state,
      status: phase,
      flow: phase === 'completed' ? 'completed' : phase,
      argv: [...record.argv],
      challenge,
      ...(record.authState ? { auth: structuredClone(record.authState) } : {}),
      ...(status.error ? { error: { ...status.error } } : {}),
    };
  }

  async authChallengeStatus(challengeId) {
    if (typeof challengeId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(challengeId)) fail('runtime auth challenge id is invalid', 'RUNTIME_AUTH_CHALLENGE_INVALID');
    const record = this.managedAuthChallenges.get(challengeId);
    if (!record) fail('runtime auth challenge is unknown', 'RUNTIME_AUTH_CHALLENGE_UNKNOWN');
    return this.#managedAuthResult(record);
  }

  async authChallengeCancel(challengeId) {
    if (typeof challengeId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(challengeId)) fail('runtime auth challenge id is invalid', 'RUNTIME_AUTH_CHALLENGE_INVALID');
    const record = this.managedAuthChallenges.get(challengeId);
    if (!record) fail('runtime auth challenge is unknown', 'RUNTIME_AUTH_CHALLENGE_UNKNOWN');
    await record.handle.cancel();
    return this.#managedAuthResult(record);
  }

  async close() {
    if (typeof this.authRunner?.close === 'function') await this.authRunner.close();
    this.managedAuthChallenges.clear();
    this.authChallengeByRuntime.clear();
    this.pendingAuthConfirmations.clear();
    this.authReservationCommits.clear();
    this.authLeases.clear();
  }
}

export class StageARuntimeManager extends RuntimeManagerPort {
  async inspect(requirements = []) { if (!Array.isArray(requirements)) throw new DshRemoteError('runtime requirements must be an array', { code: 'RUNTIME_REQUIREMENTS_INVALID' }); return requirements.map((requirement) => ({ id: requirement.id, version: requirement.version, state: 'missing', reason: 'stage-a-runtime-installers-not-implemented', executable: null })); }
  async ensure(requirements = []) { const states = await this.inspect(requirements); return { ok: states.length === 0, states, requiresAttention: states.length > 0 }; }
}

export function runtimeDriver(driver) {
  const definition = DRIVER_DEFINITIONS[driver];
  if (!definition) fail('runtime driver is invalid', 'RUNTIME_DRIVER_INVALID');
  return { ...definition, challenge({ executable, runtime, output }) { return { executable, runtimeId: runtime.id, methods: definition.authMethods, command: definition.authCommand, ...(output ? parsePublicAuthChallenge(output, driver) : {}) }; } };
}

function parsePublicAuthChallenge(output, driver) {
  const bounded = String(output).slice(0, 16_384);
  const domains = driver === 'codex' ? '(?:auth\\.)?openai\\.com' : driver === 'claude-code' ? '(?:claude\\.ai|console\\.anthropic\\.com)' : '(?:x\\.ai|grok\\.com)';
  const urlMatch = bounded.match(new RegExp(`https://(?:[A-Za-z0-9-]+\\.)?${domains}(?:/[A-Za-z0-9._~:/?#\\[\\]@!$&'()*+,;=%-]*)?`, 'iu'));
  const codeMatch = bounded.match(/(?:device\s*code|verification\s*code|user\s*code)\s*[:：]?\s*([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?)/iu);
  return { ...(urlMatch ? { url: urlMatch[0] } : {}), ...(codeMatch ? { userCode: codeMatch[1] } : {}) };
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
  constructor({ registry, transport, remoteRoot = '/home/.dsh-remote', installerPath = '/home/.dsh-remote/current/bin/dsh-remote-artifact-installer.mjs', dshVersion = '0.1.1-rc.2', apiVersion = '1.0' } = {}) {
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
