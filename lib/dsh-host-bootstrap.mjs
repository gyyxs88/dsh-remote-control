import { randomUUID } from 'node:crypto';
import { lstat, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshRemoteError, NeedsAttentionError } from './errors.mjs';
import { sha256File } from './bootstrap.mjs';
import { validateSafePosixPath } from './path-safety.mjs';

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SESSION_ID = /^session-[A-Za-z0-9-]{8,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/u;

async function regular(filePath, label) {
  const link = await lstat(filePath);
  if (!link.isFile() || link.isSymbolicLink()) throw new DshRemoteError(`${label} must be a regular non-symlink file`, { code: 'DSH_BOOTSTRAP_FILE_INVALID' });
  return stat(filePath);
}

function safeId(value, label) {
  if (!ID.test(value ?? '')) throw new DshRemoteError(`${label} is invalid`, { code: 'DSH_BOOTSTRAP_ID_INVALID' });
  return value;
}

function safeOperationId(value) {
  if (!OPERATION_ID.test(String(value))) throw new DshRemoteError('DSH bootstrap operation id is invalid', { code: 'DSH_BOOTSTRAP_OPERATION_INVALID' });
  return String(value);
}

export function createDshProfileConfig({ profileName = 'web', dshVersion, plugins, sessionControl, runtimeManager } = {}) {
  safeId(profileName, 'profileName');
  if (!VERSION.test(dshVersion ?? '') || !Array.isArray(plugins) || plugins.length === 0) throw new DshRemoteError('DSH profile identity is invalid', { code: 'DSH_PROFILE_CONFIG_INVALID' });
  const normalizedPlugins = plugins.map((plugin) => {
    safeId(plugin.id, 'plugin.id');
    safeId(plugin.packageName, 'plugin.packageName');
    validateSafePosixPath(plugin.packagePath, { field: 'plugin.packagePath', allowHome: false });
    if (!VERSION.test(plugin.version ?? '') || !SHA256.test(plugin.sha256 ?? '')) throw new DshRemoteError('DSH profile plugin identity is invalid', { code: 'DSH_PROFILE_CONFIG_INVALID' });
    return { id: plugin.id, packageName: plugin.packageName, version: plugin.version, sha256: plugin.sha256, packagePath: plugin.packagePath };
  });
  if (!normalizedPlugins.some((plugin) => plugin.packageName === 'dsh-session-control')) throw new DshRemoteError('DSH profile requires dsh-session-control', { code: 'DSH_PROFILE_SESSION_CONTROL_REQUIRED' });
  if (!sessionControl || !SESSION_ID.test(sessionControl.controllerSessionId ?? '') || sessionControl.sameWorkspaceOnly !== false) throw new DshRemoteError('session-control profile identity is invalid', { code: 'DSH_PROFILE_CONFIG_INVALID' });
  for (const [field, value] of [['hostId', sessionControl.hostId], ['sourceHostId', sessionControl.source?.sourceHostId], ['sourceSessionId', sessionControl.source?.sourceSessionId]]) safeId(value, `sessionControl.${field}`);
  if (sessionControl.source?.controllerSessionId !== sessionControl.controllerSessionId) throw new DshRemoteError('controller registration must bind the exact target controller Session', { code: 'DSH_PROFILE_CONFIG_INVALID' });
  validateSafePosixPath(sessionControl.stateDir, { field: 'sessionControl.stateDir', allowHome: false });
  validateSafePosixPath(sessionControl.socketPath, { field: 'sessionControl.socketPath', allowHome: false });
  const normalized = {
    schemaVersion: '1.0',
    profileName,
    dshVersion,
    plugins: normalizedPlugins,
    sessionControl: {
      controllerSessionId: sessionControl.controllerSessionId,
      stateDir: sessionControl.stateDir,
      sameWorkspaceOnly: false,
      socketPath: sessionControl.socketPath,
      hostId: sessionControl.hostId,
      source: {
        sourceHostId: sessionControl.source.sourceHostId,
        sourceSessionId: sessionControl.source.sourceSessionId,
        controllerSessionId: sessionControl.controllerSessionId,
      },
    },
  };
  if (runtimeManager !== undefined) {
    if (!normalizedPlugins.some((plugin) => plugin.packageName === 'dsh-subagent-code-agents')) throw new DshRemoteError('runtime manager profile requires dsh-subagent-code-agents', { code: 'DSH_PROFILE_CONFIG_INVALID' });
    for (const [field, value] of [['hostId', runtimeManager.hostId], ['sourceHostId', runtimeManager.sourceHostId], ['sourceSessionId', runtimeManager.sourceSessionId]]) safeId(value, `runtimeManager.${field}`);
    validateSafePosixPath(runtimeManager.socketPath, { field: 'runtimeManager.socketPath', allowHome: false });
    validateSafePosixPath(runtimeManager.tokenFile, { field: 'runtimeManager.tokenFile', allowHome: false });
    const channels = [...new Set(runtimeManager.channels ?? [])];
    if (channels.some((channel) => !['codex', 'claude-code', 'grok-build'].includes(channel))) throw new DshRemoteError('runtime manager channel is invalid', { code: 'DSH_PROFILE_CONFIG_INVALID' });
    normalized.runtimeManager = { ...runtimeManager, channels };
  }
  return normalized;
}

export async function writeDshProfileConfig(filePath, input) {
  const config = createDshProfileConfig(input);
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { config, sha256: await sha256File(filePath) };
}

export class DshHostBootstrapper {
  constructor({ transport, trustedCatalog = {}, installerPath = fileURLToPath(new URL('../bin/dsh-remote-dsh-installer.mjs', import.meta.url)) } = {}) {
    if (!transport || typeof transport.upload !== 'function' || typeof transport.execArgv !== 'function') throw new DshRemoteError('DSH bootstrap transport must provide upload and execArgv', { code: 'DSH_BOOTSTRAP_TRANSPORT_INVALID' });
    this.transport = transport;
    this.trustedCatalog = trustedCatalog;
    this.installerPath = installerPath;
    this.statuses = new Map();
  }

  status(operationId) {
    return this.statuses.get(operationId) ?? { status: 'unknown', operationId };
  }

  async install({ recipePath, version, pnpmVersion, remoteRoot, dshHome, profileName = 'web', hostId, serviceName, port, operationId = randomUUID() } = {}) {
    validateSafePosixPath(remoteRoot, { field: 'remoteRoot', allowHome: false });
    validateSafePosixPath(dshHome, { field: 'dshHome', allowHome: false });
    safeId(profileName, 'profileName'); safeId(hostId, 'hostId'); safeId(serviceName, 'serviceName');
    if (!VERSION.test(version ?? '') || !VERSION.test(pnpmVersion ?? '') || !Number.isInteger(port) || port < 1024 || port > 65535) throw new DshRemoteError('DSH bootstrap identity is invalid', { code: 'DSH_BOOTSTRAP_CONFIG_INVALID' });
    const trusted = this.trustedCatalog[version];
    const info = await regular(recipePath, 'DSH recipe');
    await regular(this.installerPath, 'DSH installer');
    const recipeSha256 = await sha256File(recipePath);
    const installerSha256 = await sha256File(this.installerPath);
    if (!trusted || trusted.version !== version || trusted.name !== basename(recipePath) || trusted.sha256 !== recipeSha256 || trusted.size !== info.size || trusted.pnpmVersion !== pnpmVersion || trusted.installerSha256 !== installerSha256) throw new DshRemoteError('DSH recipe or installer is absent from the trusted catalog', { code: 'DSH_BOOTSTRAP_NOT_TRUSTED' });
    const safeOperation = safeOperationId(operationId);
    const staging = posix.join(remoteRoot, 'staging', safeOperation);
    const remoteInstaller = posix.join(staging, 'dsh-remote-dsh-installer.mjs');
    const remoteRecipe = posix.join(staging, basename(recipePath));
    const args = ['node', remoteInstaller, '--recipe', remoteRecipe, '--sha256', recipeSha256, '--version', version, '--pnpm-version', pnpmVersion, '--remote-root', remoteRoot, '--dsh-home', dshHome, '--profile', profileName, '--host-id', hostId, '--service-name', serviceName, '--port', String(port)];
    const plan = { operationId: safeOperation, staging, remoteInstaller, remoteRecipe, args, remoteRoot, dshHome, profileName, hostId, serviceName, port, version, pnpmVersion, recipeSha256, installerSha256 };
    this.statuses.set(safeOperation, { status: 'running', operationId: safeOperation, plan });
    try {
      await this.transport.execArgv(['mkdir', '-p', staging]);
      await this.transport.upload(this.installerPath, remoteInstaller, { sha256: installerSha256 });
      await this.transport.upload(recipePath, remoteRecipe, { sha256: recipeSha256, size: info.size });
      const remoteDigest = await this.transport.execArgv(['sha256sum', remoteInstaller]);
      if (String(remoteDigest.stdout ?? '').trim().split(/\s+/u)[0] !== installerSha256) throw new DshRemoteError('remote DSH installer digest mismatch', { code: 'DSH_BOOTSTRAP_INSTALLER_HASH_MISMATCH' });
      const result = JSON.parse((await this.transport.execArgv(args)).stdout ?? '{}');
      if (!['installed', 'reused'].includes(result.status) || result.version !== version || result.pnpmVersion !== pnpmVersion || result.serviceName !== serviceName || result.port !== port) throw new DshRemoteError('remote DSH installer returned an invalid receipt', { code: 'DSH_BOOTSTRAP_RECEIPT_INVALID' });
      await this.transport.execArgv(['rm', '-f', remoteRecipe, remoteInstaller]);
      await this.transport.execArgv(['rmdir', staging]);
      const completed = { status: 'completed', operationId: safeOperation, plan, result };
      this.statuses.set(safeOperation, completed);
      return completed;
    } catch (error) {
      const attention = new NeedsAttentionError('DSH bootstrap terminal state is unknown; reconcile before retrying', { operationId: safeOperation, plan, cause: error.message });
      this.statuses.set(safeOperation, { status: 'needs-attention', operationId: safeOperation, plan, error: attention.details });
      throw attention;
    }
  }

  async configure({ profileConfigPath, remoteRoot, dshHome, profileName = 'web', serviceName, port, operationId = randomUUID() } = {}) {
    validateSafePosixPath(remoteRoot, { field: 'remoteRoot', allowHome: false });
    validateSafePosixPath(dshHome, { field: 'dshHome', allowHome: false });
    safeId(profileName, 'profileName'); safeId(serviceName, 'serviceName');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new DshRemoteError('DSH profile port is invalid', { code: 'DSH_PROFILE_CONFIG_INVALID' });
    const info = await regular(profileConfigPath, 'DSH profile config');
    const sha256 = await sha256File(profileConfigPath);
    let profileConfig;
    try { profileConfig = JSON.parse(await readFile(profileConfigPath, 'utf8')); } catch (error) { throw new DshRemoteError('DSH profile config JSON is invalid', { code: 'DSH_PROFILE_CONFIG_INVALID', details: { message: error.message } }); }
    const safeOperation = safeOperationId(operationId);
    const staging = posix.join(remoteRoot, 'staging', safeOperation);
    const remoteInstaller = posix.join(staging, 'dsh-remote-dsh-installer.mjs');
    const remoteConfig = posix.join(staging, 'dsh-profile.json');
    const installerSha256 = await sha256File(this.installerPath);
    const trusted = this.trustedCatalog[profileConfig?.dshVersion];
    if (!trusted || trusted.installerSha256 !== installerSha256) throw new DshRemoteError('DSH profile installer is absent from the trusted catalog', { code: 'DSH_BOOTSTRAP_NOT_TRUSTED' });
    const args = ['node', remoteInstaller, '--configure', '--profile-config', remoteConfig, '--sha256', sha256, '--remote-root', remoteRoot, '--dsh-home', dshHome, '--profile', profileName, '--service-name', serviceName, '--port', String(port)];
    const plan = { operationId: safeOperation, staging, remoteInstaller, remoteConfig, args, remoteRoot, dshHome, profileName, serviceName, port, sha256, dshVersion: profileConfig.dshVersion, installerSha256 };
    this.statuses.set(safeOperation, { status: 'running', operationId: safeOperation, plan });
    try {
      await this.transport.execArgv(['mkdir', '-p', staging]);
      await this.transport.upload(this.installerPath, remoteInstaller, { sha256: installerSha256 });
      await this.transport.upload(profileConfigPath, remoteConfig, { sha256, size: info.size });
      const remoteDigest = await this.transport.execArgv(['sha256sum', remoteInstaller]);
      if (String(remoteDigest.stdout ?? '').trim().split(/\s+/u)[0] !== installerSha256) throw new DshRemoteError('remote DSH profile installer digest mismatch', { code: 'DSH_BOOTSTRAP_INSTALLER_HASH_MISMATCH' });
      const result = JSON.parse((await this.transport.execArgv(args)).stdout ?? '{}');
      if (result.status !== 'configured' || result.sha256 !== sha256 || result.serviceName !== serviceName || result.port !== port) throw new DshRemoteError('remote DSH profile installer returned an invalid receipt', { code: 'DSH_PROFILE_RECEIPT_INVALID' });
      await this.transport.execArgv(['rm', '-f', remoteConfig, remoteInstaller]);
      await this.transport.execArgv(['rmdir', staging]);
      const completed = { status: 'completed', operationId: safeOperation, plan, result };
      this.statuses.set(safeOperation, completed);
      return completed;
    } catch (error) {
      const attention = new NeedsAttentionError('DSH profile activation terminal state is unknown; reconcile before retrying', { operationId: safeOperation, plan, cause: error.message });
      this.statuses.set(safeOperation, { status: 'needs-attention', operationId: safeOperation, plan, error: attention.details });
      throw attention;
    }
  }

  async reconcile(plan) {
    const result = await this.transport.execArgv([
      'node', posix.join(plan.remoteRoot, 'dsh', 'bin', 'dsh-remote-dsh-installer.mjs'), '--status',
      '--remote-root', plan.remoteRoot,
      '--dsh-home', plan.dshHome,
      '--profile', plan.profileName,
      '--service-name', plan.serviceName,
      '--port', String(plan.port),
    ]).catch(() => null);
    if (!result) return { status: 'needs-attention', reconciled: false };
    const parsed = JSON.parse(result.stdout ?? '{}');
    const versionMatches = plan.version ? parsed.version === plan.version : parsed.version === plan.dshVersion;
    const profileMatches = plan.sha256 ? parsed.profile?.sha256 === plan.sha256 : true;
    return parsed.status === 'ready' && versionMatches && profileMatches
      ? { status: 'completed', reconciled: true, remote: parsed }
      : { status: 'needs-attention', reconciled: false, remote: parsed };
  }
}
