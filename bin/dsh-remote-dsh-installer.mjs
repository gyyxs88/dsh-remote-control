#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, posix } from 'node:path';

// Cold-host entrypoint: keep this file self-contained and limited to Node built-ins.
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SESSION_ID = /^session-[A-Za-z0-9-]{8,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PORTABLE_PATH = /^\/[A-Za-z0-9._/-]+$/u;
const TRUSTED_INSTALL_SCRIPTS = new Map([
  ['node_modules/@deepseek-ai/dsh-subprocess-local', '0.1.0-rc.8'],
  ['node_modules/@google/genai', '1.52.0'],
  ['node_modules/koffi', '3.1.6'],
  ['node_modules/node-pty', '1.2.0-beta.15'],
  ['node_modules/protobufjs', '7.6.5'],
]);

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function required(name) {
  const value = option(name);
  if (typeof value !== 'string' || value.length === 0) fail(`--${name} is required`, 'DSH_INSTALLER_ARGUMENT_REQUIRED');
  return value;
}

function safePath(value, label, { withinHome = true } = {}) {
  if (typeof value !== 'string' || !PORTABLE_PATH.test(value) || !posix.isAbsolute(value) || value.split('/').includes('..') || value.includes('//')) fail(`${label} must be a portable absolute POSIX path`, 'DSH_INSTALLER_PATH_INVALID');
  const normalized = posix.normalize(value);
  if (withinHome) {
    const home = posix.normalize(homedir());
    const relative = posix.relative(home, normalized);
    if (relative === '' || relative.startsWith('..') || posix.isAbsolute(relative)) fail(`${label} must be below the remote user home`, 'DSH_INSTALLER_PATH_INVALID');
  }
  return normalized;
}

function safeId(value, label) {
  if (!ID.test(value ?? '')) fail(`${label} is invalid`, 'DSH_INSTALLER_ID_INVALID');
  return value;
}

function assertPlatform() {
  if (process.platform !== 'linux' || process.arch !== 'x64') fail('DSH Host installer only supports Linux x86_64', 'DSH_INSTALLER_PLATFORM_UNSUPPORTED');
  if (typeof process.getuid === 'function' && process.getuid() === 0) fail('DSH Host installer refuses to run as root', 'DSH_INSTALLER_ROOT_FORBIDDEN');
}

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function regularFile(filePath, label) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`, 'DSH_INSTALLER_FILE_INVALID');
  return info;
}

async function canonicalBelowHome(value) {
  let cursor = value;
  const suffix = [];
  while (true) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) fail('installation path cannot traverse a symbolic link', 'DSH_INSTALLER_PATH_INVALID');
      const resolved = await realpath(cursor);
      const home = await realpath(homedir());
      const relative = posix.relative(home, posix.join(resolved, ...suffix.reverse()));
      if (relative === '' || relative.startsWith('..') || posix.isAbsolute(relative)) fail('installation path escapes the remote user home', 'DSH_INSTALLER_PATH_INVALID');
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = posix.dirname(cursor);
      if (parent === cursor) fail('installation path has no canonical ancestor', 'DSH_INSTALLER_PATH_INVALID');
      suffix.push(posix.basename(cursor));
      cursor = parent;
    }
  }
}

function safeRecipeEntries(output) {
  const allowed = new Set(['package/', 'package/package.json', 'package/package-lock.json']);
  const entries = output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (!entries.includes('package/package.json') || !entries.includes('package/package-lock.json')) fail('DSH recipe is missing package manifests', 'DSH_RECIPE_INVALID');
  for (const entry of entries) {
    if (!allowed.has(entry) || entry.startsWith('/') || entry.includes('\\') || entry.split('/').includes('..')) fail(`DSH recipe entry is not allowed: ${entry}`, 'DSH_RECIPE_INVALID');
  }
}

function validateLockedRecipe(packageJson, packageLock, version) {
  const dependencies = packageJson?.dependencies ?? {};
  const dependencyNames = Object.keys(dependencies).sort();
  const lockedRoot = packageLock?.packages?.['']?.dependencies ?? {};
  const lockedNames = Object.keys(lockedRoot).sort();
  if (packageJson?.private !== true || dependencies['@deepseek-ai/dsh'] !== version || dependencyNames.length === 0 || dependencyNames.some((name) => !VERSION.test(dependencies[name] ?? ''))) fail('DSH recipe dependencies must be exact and bind the requested DSH version', 'DSH_RECIPE_INVALID');
  if (packageLock?.lockfileVersion !== 3 || JSON.stringify(dependencyNames) !== JSON.stringify(lockedNames) || dependencyNames.some((name) => lockedRoot[name] !== dependencies[name])) fail('DSH recipe lock root does not match package.json', 'DSH_RECIPE_INVALID');
  for (const name of dependencyNames) {
    if (packageLock.packages?.[`node_modules/${name}`]?.version !== dependencies[name]) fail(`DSH recipe lock does not bind exact root dependency ${name}`, 'DSH_RECIPE_INVALID');
  }
  for (const [packagePath, value] of Object.entries(packageLock.packages ?? {})) {
    const topLevel = packagePath.slice('node_modules/'.length);
    if (packagePath.startsWith('node_modules/@deepseek-ai/dsh') && !topLevel.includes('/node_modules/') && value?.version !== version) fail(`DSH recipe contains a drifting DSH package: ${packagePath}`, 'DSH_RECIPE_DRIFT');
    for (const peer of Object.keys(value?.peerDependencies ?? {})) {
      if (value?.peerDependenciesMeta?.[peer]?.optional === true) continue;
      if (!VERSION.test(packageLock.packages?.[`node_modules/${peer}`]?.version ?? '')) fail(`DSH recipe is missing top-level peer closure ${peer} required by ${packagePath}`, 'DSH_RECIPE_PEER_CLOSURE_INVALID');
    }
    if (value?.hasInstallScript === true && TRUSTED_INSTALL_SCRIPTS.get(packagePath) !== value.version) fail(`DSH recipe contains an unapproved lifecycle script: ${packagePath}`, 'DSH_RECIPE_LIFECYCLE_NOT_TRUSTED');
  }
  const actualInstallScripts = Object.entries(packageLock.packages ?? {}).filter(([, value]) => value?.hasInstallScript === true).map(([packagePath]) => packagePath).sort();
  const expectedInstallScripts = [...TRUSTED_INSTALL_SCRIPTS.keys()].sort();
  if (actualInstallScripts.length !== expectedInstallScripts.length || actualInstallScripts.some((value, index) => value !== expectedInstallScripts[index])) fail('DSH recipe lifecycle allowlist is incomplete or has drifted', 'DSH_RECIPE_LIFECYCLE_NOT_TRUSTED');
  const approvedScripts = packageJson?.allowScripts ?? {};
  const expectedApprovals = [...TRUSTED_INSTALL_SCRIPTS].map(([packagePath, scriptVersion]) => `${packagePath.slice('node_modules/'.length)}@${scriptVersion}`).sort();
  const actualApprovals = Object.entries(approvedScripts).filter(([, approved]) => approved === true).map(([identity]) => identity).sort();
  if (Object.keys(approvedScripts).length !== actualApprovals.length || actualApprovals.length !== expectedApprovals.length || actualApprovals.some((value, index) => value !== expectedApprovals[index])) fail('DSH recipe lifecycle approvals are incomplete or have drifted', 'DSH_RECIPE_LIFECYCLE_NOT_TRUSTED');
}

function probeDshInstall(packageRoot, version) {
  const actual = command(join(packageRoot, 'node_modules', '.bin', 'dsh'), ['--version']).trim();
  if (actual !== version) fail('installed DSH binary failed the exact version probe', 'DSH_INSTALLER_VERSION_DRIFT');
  command('node', ['-e', "require('node-pty'); require('koffi')"], { cwd: packageRoot });
}

function command(name, args, options = {}) {
  return execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, ...options });
}

async function atomicCurrent(installRoot, versionRoot) {
  const current = join(installRoot, 'current');
  try {
    const info = await lstat(current);
    if (!info.isSymbolicLink()) fail('DSH current pointer is not a symbolic link', 'DSH_INSTALLER_CURRENT_INVALID');
    const resolved = await realpath(current);
    const root = await realpath(installRoot);
    const relative = posix.relative(root, resolved);
    if (relative.startsWith('..') || posix.isAbsolute(relative)) fail('DSH current pointer escapes install root', 'DSH_INSTALLER_CURRENT_INVALID');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const next = join(installRoot, `.current-${process.pid}-${randomUUID()}`);
  try {
    await symlink(posix.relative(installRoot, versionRoot), next, 'dir');
    await rename(next, current);
  } finally {
    await rm(next, { force: true }).catch(() => {});
  }
}

async function installPnpm(remoteRoot, version) {
  if (!VERSION.test(version ?? '')) fail('pnpm version is invalid', 'DSH_INSTALLER_PNPM_VERSION_INVALID');
  const corepackHome = join(remoteRoot, 'corepack');
  const binRoot = join(remoteRoot, 'bin');
  await mkdir(corepackHome, { recursive: true, mode: 0o700 });
  await mkdir(binRoot, { recursive: true, mode: 0o700 });
  const env = { ...process.env, COREPACK_HOME: corepackHome };
  command('corepack', ['install', '--global', `pnpm@${version}`], { env });
  const wrapper = join(binRoot, 'pnpm');
  const source = `#!/usr/bin/env node\nimport { spawnSync } from 'node:child_process';\nconst result = spawnSync('corepack', ['pnpm', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, COREPACK_HOME: ${JSON.stringify(corepackHome)} } });\nprocess.exit(result.status ?? 1);\n`;
  await writeFile(wrapper, source, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  const actual = command(wrapper, ['--version'], { env }).trim();
  if (actual !== version) fail('Corepack did not activate the requested pnpm version', 'DSH_INSTALLER_PNPM_PROBE_FAILED');
  return { corepackHome, wrapper };
}

function serviceUnit({ serviceName, hostId, dshBin, dshHome, corepackHome, binRoot, port }) {
  return `[Unit]\nDescription=DSH Remote Host ${hostId}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nEnvironment=DSH_HOME=${dshHome}\nEnvironment=COREPACK_HOME=${corepackHome}\nEnvironment=PATH=${binRoot}:/usr/local/bin:/usr/bin:/bin\nExecStart=${dshBin} web --host 127.0.0.1 --port ${port}\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`;
}

async function waitForHealth(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not started';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`DSH loopback health check failed: ${lastError}`, 'DSH_SERVICE_HEALTH_FAILED');
}

async function writeService({ remoteRoot, dshHome, hostId, serviceName, port, version }) {
  safeId(serviceName, 'service name');
  if (!serviceName.endsWith('.service')) fail('service name must end in .service', 'DSH_INSTALLER_SERVICE_INVALID');
  const installRoot = join(remoteRoot, 'dsh');
  const dshBin = join(installRoot, 'current', 'node_modules', '.bin', 'dsh');
  const unitRoot = join(homedir(), '.config', 'systemd', 'user');
  const unitPath = join(unitRoot, serviceName);
  const linger = command('loginctl', ['show-user', String(process.getuid()), '-p', 'Linger', '--value']).trim();
  if (linger !== 'yes') fail('systemd user linger is required for an autonomous Remote Host; an administrator must enable linger for this user', 'DSH_SERVICE_LINGER_REQUIRED');
  await mkdir(unitRoot, { recursive: true, mode: 0o700 });
  await writeFile(unitPath, serviceUnit({ serviceName, hostId, dshBin, dshHome, corepackHome: join(remoteRoot, 'corepack'), binRoot: join(remoteRoot, 'bin'), port }), { mode: 0o600 });
  command('systemctl', ['--user', 'daemon-reload']);
  command('systemctl', ['--user', 'enable', '--now', serviceName]);
  await waitForHealth(port);
  return { serviceName, unitPath, dshBin, version, port };
}

async function install() {
  assertPlatform();
  const recipe = safePath(required('recipe'), 'recipe', { withinHome: true });
  const expectedSha = required('sha256');
  const version = required('version');
  const pnpmVersion = required('pnpm-version');
  const remoteRoot = safePath(required('remote-root'), 'remote root');
  const dshHome = safePath(required('dsh-home'), 'DSH home');
  const profileName = safeId(required('profile'), 'profile');
  const hostId = safeId(required('host-id'), 'Host id');
  const serviceName = safeId(required('service-name'), 'service name');
  const port = Number(required('port'));
  if (!SHA256.test(expectedSha) || !VERSION.test(version) || !VERSION.test(pnpmVersion) || !Number.isInteger(port) || port < 1024 || port > 65535) fail('DSH install identity is invalid', 'DSH_INSTALLER_ARGUMENT_INVALID');
  await canonicalBelowHome(remoteRoot);
  await canonicalBelowHome(dshHome);
  await mkdir(remoteRoot, { recursive: true, mode: 0o700 });
  const remoteRootInfo = await lstat(remoteRoot);
  if (!remoteRootInfo.isDirectory() || remoteRootInfo.isSymbolicLink() || (typeof process.getuid === 'function' && remoteRootInfo.uid !== process.getuid())) fail('remote root must be an owned non-symlink directory', 'DSH_INSTALLER_PATH_INVALID');
  await chmod(remoteRoot, 0o700);
  const recipeInfo = await regularFile(recipe, 'DSH recipe');
  const bytes = await readFile(recipe);
  if (digest(bytes) !== expectedSha) fail('DSH recipe digest mismatch', 'DSH_RECIPE_DIGEST_MISMATCH');
  const installRoot = join(remoteRoot, 'dsh');
  const versionsRoot = join(installRoot, 'versions');
  const versionRoot = join(versionsRoot, version);
  const manifestPath = join(versionRoot, 'dsh-install-manifest.json');
  let reused = false;
  let replaceInvalid = false;
  let invalidVersionRoot = null;
  let installedManifest = null;
  try {
    installedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const existing = await lstat(versionRoot).catch(() => null);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw error;
      replaceInvalid = true;
    }
  }
  if (installedManifest) {
    if (installedManifest.version !== version || installedManifest.sha256 !== expectedSha || installedManifest.size !== recipeInfo.size || installedManifest.pnpmVersion !== pnpmVersion) fail('installed DSH version has a different trusted recipe', 'DSH_INSTALLER_VERSION_CONFLICT');
    try {
      probeDshInstall(versionRoot, version);
      reused = true;
    } catch {
      replaceInvalid = true;
    }
  }
  if (!reused) {
    await mkdir(versionsRoot, { recursive: true, mode: 0o700 });
    const staging = join(installRoot, `.staging-${version}-${process.pid}-${randomUUID()}`);
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 });
      const listing = command('tar', ['-tzf', recipe]);
      safeRecipeEntries(listing);
      command('tar', ['-xzf', recipe, '-C', staging, '--no-same-owner', '--no-same-permissions']);
      const packageRoot = join(staging, 'package');
      const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
      const packageLock = JSON.parse(await readFile(join(packageRoot, 'package-lock.json'), 'utf8'));
      validateLockedRecipe(packageJson, packageLock, version);
      command('npm', ['ci', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund'], {
        cwd: packageRoot,
        env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' },
      });
      probeDshInstall(packageRoot, version);
      await writeFile(join(packageRoot, 'dsh-install-manifest.json'), `${JSON.stringify({ version, sha256: expectedSha, size: recipeInfo.size, pnpmVersion }, null, 2)}\n`, { mode: 0o600 });
      if (replaceInvalid) {
        invalidVersionRoot = `${versionRoot}.invalid-${Date.now()}-${randomUUID()}`;
        await rename(versionRoot, invalidVersionRoot);
        try {
          await rename(packageRoot, versionRoot);
        } catch (error) {
          await rename(invalidVersionRoot, versionRoot).catch(() => {});
          throw error;
        }
      } else {
        await rename(packageRoot, versionRoot);
      }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }
  await atomicCurrent(installRoot, versionRoot);
  const stableInstallerRoot = join(installRoot, 'bin');
  const stableInstaller = join(stableInstallerRoot, 'dsh-remote-dsh-installer.mjs');
  await mkdir(stableInstallerRoot, { recursive: true, mode: 0o700 });
  await writeFile(stableInstaller, await readFile(process.argv[1]), { mode: 0o700 });
  await chmod(stableInstaller, 0o700);
  const pnpm = await installPnpm(remoteRoot, pnpmVersion);
  await mkdir(join(dshHome, 'profiles', profileName), { recursive: true, mode: 0o700 });
  const service = await writeService({ remoteRoot, dshHome, hostId, serviceName, port, version });
  process.stdout.write(`${JSON.stringify({ status: reused ? 'reused' : 'installed', version, pnpmVersion, remoteRoot, dshHome, profileName, stableInstaller, ...pnpm, ...service })}\n`);
}

function yamlScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(String(value));
}

function yamlLines(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) return value.flatMap((item) => {
    if (item && typeof item === 'object') {
      const entries = Object.entries(item);
      const [firstKey, firstValue] = entries[0];
      const lines = [`${pad}- ${firstKey}: ${firstValue && typeof firstValue === 'object' ? '' : yamlScalar(firstValue)}`];
      if (firstValue && typeof firstValue === 'object') lines.push(...yamlLines(firstValue, indent + 4));
      for (const [key, nested] of entries.slice(1)) {
        lines.push(`${' '.repeat(indent + 2)}${key}:${nested && typeof nested === 'object' ? '' : ` ${yamlScalar(nested)}`}`);
        if (nested && typeof nested === 'object') lines.push(...yamlLines(nested, indent + 4));
      }
      return lines;
    }
    return [`${pad}- ${yamlScalar(item)}`];
  });
  return Object.entries(value).flatMap(([key, nested]) => {
    const line = `${pad}${key}:${nested && typeof nested === 'object' ? '' : ` ${yamlScalar(nested)}`}`;
    return nested && typeof nested === 'object' ? [line, ...yamlLines(nested, indent + 2)] : [line];
  });
}

async function validateProfileConfig(config, remoteRoot, dshHome, profileName) {
  if (config?.schemaVersion !== '1.0' || config.profileName !== profileName || !VERSION.test(config.dshVersion ?? '') || !Array.isArray(config.plugins) || config.plugins.length === 0) fail('DSH profile config is invalid', 'DSH_PROFILE_CONFIG_INVALID');
  const dependencies = {};
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
  for (const plugin of config.plugins) {
    const id = safeId(plugin.id, 'plugin id');
    const packageName = safeId(plugin.packageName, 'plugin package name');
    if (!VERSION.test(plugin.version ?? '') || !SHA256.test(plugin.sha256 ?? '')) fail('plugin identity is invalid', 'DSH_PROFILE_PLUGIN_INVALID');
    const packagePath = safePath(plugin.packagePath, 'plugin package path');
    const expectedRoot = join(remoteRoot, 'plugins', id, 'versions', plugin.version);
    if (packagePath !== join(expectedRoot, 'package')) fail('plugin package path is not an immutable managed version', 'DSH_PROFILE_PLUGIN_INVALID');
    const manifest = JSON.parse(await readFile(join(expectedRoot, 'manifest.json'), 'utf8'));
    const packageJson = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
    if (manifest.kind !== 'plugin' || manifest.id !== id || manifest.version !== plugin.version || manifest.packageName !== packageName || manifest.sha256 !== plugin.sha256 || packageJson.name !== packageName || packageJson.version !== plugin.version) fail('plugin package does not match its trusted install receipt', 'DSH_PROFILE_PLUGIN_INVALID');
    dependencies[packageName] = `file:${packagePath}`;
    bundles.push(packageName);
  }
  if (!dependencies['dsh-session-control']) fail('remote profile requires dsh-session-control', 'DSH_PROFILE_SESSION_CONTROL_REQUIRED');
  const session = config.sessionControl;
  if (!session || !SESSION_ID.test(session.controllerSessionId ?? '') || session.controllerSessionId !== session.source?.controllerSessionId || !ID.test(session.hostId ?? '') || !ID.test(session.source?.sourceHostId ?? '') || !ID.test(session.source?.sourceSessionId ?? '') || session.sameWorkspaceOnly !== false) fail('session-control registration is invalid', 'DSH_PROFILE_SESSION_CONTROL_INVALID');
  const stateDir = safePath(session.stateDir, 'session-control state directory');
  const socketPath = safePath(session.socketPath, 'session-control socket', { withinHome: false });
  const patches = [{
    id: 'authorized-session-control',
    config: {
      controllerSessionIds: [session.controllerSessionId],
      stateDir,
      sameWorkspaceOnly: false,
      maxPendingPerTarget: 3,
      maxPendingPerSource: 10,
      rateLimitPerMinute: 30,
      maxOperations: 500,
      approvalDelegationTimeoutMs: 900000,
      remoteProjectSocket: socketPath,
      remoteProjectHostId: session.hostId,
      remoteProjectSourceAllowlist: [session.source],
    },
  }];
  if (config.runtimeManager !== undefined) {
    const runtime = config.runtimeManager;
    if (!dependencies['dsh-subagent-code-agents'] || !Array.isArray(runtime.channels) || runtime.channels.some((value) => !['codex', 'claude-code', 'grok-build'].includes(value))) fail('runtime manager profile config is invalid', 'DSH_PROFILE_RUNTIME_INVALID');
    const runtimeConfig = {
      runtimeManagerSocket: safePath(runtime.socketPath, 'runtime manager socket', { withinHome: false }),
      runtimeManagerHostId: safeId(runtime.hostId, 'runtime manager Host id'),
      runtimeManagerSourceHostId: safeId(runtime.sourceHostId, 'runtime manager source Host id'),
      runtimeManagerSourceSessionId: safeId(runtime.sourceSessionId, 'runtime manager source Session id'),
      runtimeManagerCapabilityTokenFile: safePath(runtime.tokenFile, 'runtime manager token file'),
    };
    const ids = { codex: 'coding-agent-codex', 'claude-code': 'coding-agent-claude-code', 'grok-build': 'coding-agent-grok-build' };
    for (const channel of [...new Set(runtime.channels)]) patches.push({ id: ids[channel], config: runtimeConfig });
  }
  const profileRoot = join(dshHome, 'profiles', profileName);
  return { dependencies, bundles, patches, profileRoot };
}

async function configure() {
  assertPlatform();
  const configPath = safePath(required('profile-config'), 'profile config');
  const expectedSha = required('sha256');
  const remoteRoot = safePath(required('remote-root'), 'remote root');
  const dshHome = safePath(required('dsh-home'), 'DSH home');
  const profileName = safeId(required('profile'), 'profile');
  const serviceName = safeId(required('service-name'), 'service name');
  const port = Number(required('port'));
  if (!SHA256.test(expectedSha) || !Number.isInteger(port) || port < 1024 || port > 65535) fail('profile activation identity is invalid', 'DSH_PROFILE_CONFIG_INVALID');
  await regularFile(configPath, 'profile config');
  const bytes = await readFile(configPath);
  if (digest(bytes) !== expectedSha) fail('profile config digest mismatch', 'DSH_PROFILE_CONFIG_DIGEST_MISMATCH');
  const config = JSON.parse(bytes.toString('utf8'));
  const validated = await validateProfileConfig(config, remoteRoot, dshHome, profileName);
  await mkdir(validated.profileRoot, { recursive: true, mode: 0o700 });
  const packageJson = {
    name: `dsh-profile-${profileName}`,
    private: true,
    dependencies: validated.dependencies,
    dsh: { profile: { bundles: validated.bundles } },
  };
  await writeFile(join(validated.profileRoot, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(validated.profileRoot, 'cordis.patch.yml'), `${yamlLines(validated.patches).join('\n')}\n`, { mode: 0o600 });
  const pnpm = join(remoteRoot, 'bin', 'pnpm');
  const env = { ...process.env, COREPACK_HOME: join(remoteRoot, 'corepack'), PATH: `${join(remoteRoot, 'bin')}:/usr/local/bin:/usr/bin:/bin` };
  command(pnpm, ['install', '--ignore-scripts', '--no-frozen-lockfile', '--config.auto-install-peers=false'], { cwd: validated.profileRoot, env });
  await writeFile(join(validated.profileRoot, 'dsh-remote-profile-manifest.json'), `${JSON.stringify({ sha256: expectedSha, dshVersion: config.dshVersion, plugins: config.plugins, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  command('systemctl', ['--user', 'restart', serviceName]);
  await waitForHealth(port);
  process.stdout.write(`${JSON.stringify({ status: 'configured', profileName, sha256: expectedSha, plugins: config.plugins.map(({ id, version, sha256 }) => ({ id, version, sha256 })), serviceName, port })}\n`);
}

async function status() {
  assertPlatform();
  const remoteRoot = safePath(required('remote-root'), 'remote root');
  const dshHome = safePath(required('dsh-home'), 'DSH home');
  const profileName = safeId(required('profile'), 'profile');
  const serviceName = safeId(required('service-name'), 'service name');
  const port = Number(required('port'));
  const current = await realpath(join(remoteRoot, 'dsh', 'current'));
  const manifest = JSON.parse(await readFile(join(current, 'dsh-install-manifest.json'), 'utf8'));
  const actualVersion = command(join(current, 'node_modules', '.bin', 'dsh'), ['--version']).trim();
  const serviceState = command('systemctl', ['--user', 'is-active', serviceName]).trim();
  await waitForHealth(port, 5_000);
  let profile = null;
  try { profile = JSON.parse(await readFile(join(dshHome, 'profiles', profileName, 'dsh-remote-profile-manifest.json'), 'utf8')); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (actualVersion !== manifest.version || serviceState !== 'active') fail('DSH Host status probe failed', 'DSH_SERVICE_STATUS_INVALID');
  process.stdout.write(`${JSON.stringify({ status: 'ready', version: actualVersion, pnpmVersion: manifest.pnpmVersion, serviceState, port, profile })}\n`);
}

async function main() {
  if (process.argv.includes('--probe')) return process.stdout.write(`${JSON.stringify({ status: 'ok', component: 'dsh-remote-dsh-installer', platform: process.platform, arch: process.arch })}\n`);
  if (process.argv.includes('--configure')) return configure();
  if (process.argv.includes('--status')) return status();
  return install();
}

main().catch((error) => {
  process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.stack ?? error}\n`);
  process.exitCode = 1;
});
