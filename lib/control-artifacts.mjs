import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createArtifactManifest, sha256File } from './bootstrap.mjs';
import { TrustedArtifactRegistry } from './desired-state-registry.mjs';
import { DshRemoteError, TimeoutError, TransportError } from './errors.mjs';

export const DEFAULT_DSH_VERSION = '0.1.1-rc.2';
export const DEFAULT_PNPM_VERSION = '11.19.0';
export const DEFAULT_API_VERSION = '1.0';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const require = createRequire(import.meta.url);

function defaultNpmPath() {
  if (process.platform !== 'win32') return 'npm';
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const entry of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (entry) candidates.push(path.join(entry, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? 'npm.cmd';
}

function run(command, args, { cwd, spawnImpl = spawn, timeoutMs = 120_000, maxOutputBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error && !child.killed) child.kill();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new TimeoutError('artifact preparation timed out', { command })), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxOutputBytes) finish(new DshRemoteError('artifact preparation stdout exceeded limit', { code: 'CONTROL_ARTIFACT_OUTPUT_TOO_LARGE' }));
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > maxOutputBytes) finish(new DshRemoteError('artifact preparation stderr exceeded limit', { code: 'CONTROL_ARTIFACT_OUTPUT_TOO_LARGE' }));
    });
    child.on('error', (error) => finish(new TransportError('artifact preparation process failed to start', { command, message: error.message })));
    child.on('exit', (code, signal) => code === 0
      ? finish(null, { code, signal, stdout, stderr })
      : finish(new TransportError('artifact preparation command failed', { command, code, signal, stderr })));
  });
}

async function regularDirectory(directory, label) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new DshRemoteError(`${label} must be an absolute path`, { code: 'CONTROL_ARTIFACT_SOURCE_INVALID' });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new DshRemoteError(`${label} must be a real directory`, { code: 'CONTROL_ARTIFACT_SOURCE_INVALID' });
  return directory;
}

async function parsePackage(directory, label) {
  await regularDirectory(directory, label);
  const packagePath = path.join(directory, 'package.json');
  const info = await lstat(packagePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new DshRemoteError(`${label} package.json must be a regular file`, { code: 'CONTROL_ARTIFACT_SOURCE_INVALID' });
  try {
    return JSON.parse(await readFile(packagePath, 'utf8'));
  } catch (error) {
    throw new DshRemoteError(`${label} package.json is invalid`, { code: 'CONTROL_ARTIFACT_SOURCE_INVALID', details: { message: error.message } });
  }
}

async function packNpmPackage(sourceRoot, outputDir, { npmPath = 'npm', spawnImpl = spawn } = {}) {
  const packageJson = await parsePackage(sourceRoot, 'npm package source');
  if (typeof packageJson.name !== 'string' || !VERSION.test(packageJson.version ?? '')) throw new DshRemoteError('npm package source identity is invalid', { code: 'CONTROL_ARTIFACT_SOURCE_INVALID' });
  const temp = await mkdtemp(path.join(outputDir, '.pack-'));
  try {
    const npmArgs = ['pack', '--ignore-scripts', '--json', '--pack-destination', temp, sourceRoot];
    const result = npmPath.endsWith('.js')
      ? await run(process.execPath, [npmPath, ...npmArgs], { spawnImpl, timeoutMs: 120_000 })
      : await run(npmPath, npmArgs, { spawnImpl, timeoutMs: 120_000 });
    let report;
    try { report = JSON.parse(result.stdout); } catch (error) { throw new DshRemoteError('npm pack returned invalid JSON', { code: 'CONTROL_ARTIFACT_PACK_INVALID', details: { message: error.message } }); }
    const filename = report?.[0]?.filename;
    if (typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(filename)) throw new DshRemoteError('npm pack returned an unsafe artifact name', { code: 'CONTROL_ARTIFACT_PACK_INVALID' });
    const source = path.join(temp, filename);
    const target = path.join(outputDir, filename);
    await rm(target, { force: true });
    await rename(source, target);
    await chmod(target, 0o600).catch((error) => { if (process.platform !== 'win32') throw error; });
    return { packageJson, artifactPath: target, size: (await stat(target)).size, sha256: await sha256File(target) };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export function validateDshRecipeLock(packageJson, packageLock, version) {
  const dependencies = packageJson?.dependencies ?? {};
  const dependencyNames = Object.keys(dependencies).sort();
  const lockedRoot = packageLock?.packages?.['']?.dependencies ?? {};
  const lockedNames = Object.keys(lockedRoot).sort();
  if (packageJson?.private !== true || dependencies['@deepseek-ai/dsh'] !== version || dependencyNames.length === 0 || dependencyNames.some((name) => !VERSION.test(dependencies[name] ?? ''))) throw new DshRemoteError('DSH recipe dependencies must be exact and bind the configured DSH version', { code: 'CONTROL_DSH_RECIPE_INVALID' });
  if (packageLock?.lockfileVersion !== 3 || JSON.stringify(dependencyNames) !== JSON.stringify(lockedNames) || dependencyNames.some((name) => lockedRoot[name] !== dependencies[name])) throw new DshRemoteError('DSH recipe lock root does not match package.json', { code: 'CONTROL_DSH_RECIPE_INVALID' });
  for (const name of dependencyNames) {
    if (packageLock.packages?.[`node_modules/${name}`]?.version !== dependencies[name]) throw new DshRemoteError(`DSH recipe lock does not bind exact root dependency ${name}`, { code: 'CONTROL_DSH_RECIPE_INVALID' });
  }
  for (const [packagePath, value] of Object.entries(packageLock.packages ?? {})) {
    for (const peer of Object.keys(value?.peerDependencies ?? {})) {
      if (value?.peerDependenciesMeta?.[peer]?.optional === true) continue;
      if (!VERSION.test(packageLock.packages?.[`node_modules/${peer}`]?.version ?? '')) throw new DshRemoteError(`DSH recipe is missing top-level peer closure ${peer} required by ${packagePath}`, { code: 'CONTROL_DSH_RECIPE_PEER_CLOSURE_INVALID' });
    }
  }
}

async function buildDshRecipe(sourceRoot, outputDir, version, { tarPath = 'tar', spawnImpl = spawn } = {}) {
  await regularDirectory(sourceRoot, 'DSH recipe source');
  const packageJson = await parsePackage(sourceRoot, 'DSH recipe source');
  const lockPath = path.join(sourceRoot, 'package-lock.json');
  const packageLock = JSON.parse(await readFile(lockPath, 'utf8'));
  validateDshRecipeLock(packageJson, packageLock, version);
  const temp = await mkdtemp(path.join(outputDir, '.recipe-'));
  try {
    const packageDir = path.join(temp, 'package');
    await mkdir(packageDir, { recursive: true, mode: 0o700 });
    await copyFile(path.join(sourceRoot, 'package.json'), path.join(packageDir, 'package.json'));
    await copyFile(lockPath, path.join(packageDir, 'package-lock.json'));
    const artifactPath = path.join(outputDir, `dsh-${version}-lock.tgz`);
    await rm(artifactPath, { force: true });
    await run(tarPath, ['-czf', artifactPath, '-C', temp, 'package'], { spawnImpl, timeoutMs: 60_000 });
    await chmod(artifactPath, 0o600).catch((error) => { if (process.platform !== 'win32') throw error; });
    return { artifactPath, size: (await stat(artifactPath)).size, sha256: await sha256File(artifactPath) };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function resolvedSessionControlRoot(configured) {
  if (configured) return configured;
  try { return path.dirname(require.resolve('dsh-session-control/package.json')); } catch (error) {
    throw new DshRemoteError('dsh-session-control must be installed beside the control plugin or configured explicitly', { code: 'SESSION_CONTROL_PACKAGE_REQUIRED', details: { message: error.message } });
  }
}

export class ControlArtifactProvider {
  constructor({ cacheDir, dshRecipeRoot = process.cwd(), sessionControlPackageRoot, packageRoot = PACKAGE_ROOT, dshVersion = DEFAULT_DSH_VERSION, pnpmVersion = DEFAULT_PNPM_VERSION, apiVersion = DEFAULT_API_VERSION, npmPath = defaultNpmPath(), tarPath = 'tar', spawnImpl = spawn } = {}) {
    if (typeof cacheDir !== 'string' || !path.isAbsolute(cacheDir) || !VERSION.test(dshVersion ?? '') || !VERSION.test(pnpmVersion ?? '') || !/^\d+\.\d+$/u.test(apiVersion ?? '')) throw new DshRemoteError('control artifact provider configuration is invalid', { code: 'CONTROL_ARTIFACT_CONFIG_INVALID' });
    this.cacheDir = cacheDir;
    this.dshRecipeRoot = path.resolve(dshRecipeRoot);
    this.sessionControlPackageRoot = sessionControlPackageRoot ? path.resolve(sessionControlPackageRoot) : null;
    this.packageRoot = path.resolve(packageRoot);
    this.dshVersion = dshVersion;
    this.pnpmVersion = pnpmVersion;
    this.apiVersion = apiVersion;
    this.npmPath = process.platform === 'win32' && ['npm', 'npm.cmd'].includes(npmPath) ? defaultNpmPath() : npmPath;
    this.tarPath = tarPath;
    this.spawnImpl = spawnImpl;
    this.preparing = null;
  }

  prepare() {
    this.preparing ??= this.#prepare().catch((error) => { this.preparing = null; throw error; });
    return this.preparing;
  }

  async #prepare() {
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const remoteHost = await packNpmPackage(this.packageRoot, this.cacheDir, this);
    if (remoteHost.packageJson.name !== 'dsh-remote-control') throw new DshRemoteError('control package identity is invalid', { code: 'CONTROL_ARTIFACT_SOURCE_INVALID' });
    const sessionControlRoot = resolvedSessionControlRoot(this.sessionControlPackageRoot);
    const sessionControl = await packNpmPackage(sessionControlRoot, this.cacheDir, this);
    if (sessionControl.packageJson.name !== 'dsh-session-control') throw new DshRemoteError('session-control package identity is invalid', { code: 'CONTROL_ARTIFACT_SOURCE_INVALID' });
    const remoteManifest = sessionControl.packageJson.dsh?.remote;
    if (!remoteManifest || remoteManifest.pluginId !== 'dsh-session-control' || remoteManifest.version !== sessionControl.packageJson.version || remoteManifest.protocolVersion !== '1.0' || !Array.isArray(remoteManifest.bundledSkills) || remoteManifest.bundledSkills.length < 1) throw new DshRemoteError('session-control remote manifest is invalid', { code: 'CONTROL_ARTIFACT_SOURCE_INVALID' });
    const recipe = await buildDshRecipe(this.dshRecipeRoot, this.cacheDir, this.dshVersion, this);
    const hostInstallerPath = fileURLToPath(new URL('../bin/dsh-remote-host-installer.mjs', import.meta.url));
    const dshInstallerPath = fileURLToPath(new URL('../bin/dsh-remote-dsh-installer.mjs', import.meta.url));
    const hostManifest = await createArtifactManifest({ filePath: remoteHost.artifactPath, version: remoteHost.packageJson.version });
    const compatibility = { dsh: { min: this.dshVersion, max: this.dshVersion }, api: { min: this.apiVersion, max: this.apiVersion } };
    const pluginRequirement = {
      id: 'dsh-session-control',
      version: sessionControl.packageJson.version,
      placement: 'remote',
      source: { registry: 'installed-control-packages', artifact: path.basename(sessionControl.artifactPath) },
      sha256: sessionControl.sha256,
      compatibility,
      requiredBy: ['control:dsh-remote-project'],
    };
    const skill = remoteManifest.bundledSkills[0];
    if (!VERSION.test(skill.version ?? '') || !SHA256.test(skill.sha256 ?? '')) throw new DshRemoteError('session-control bundled Skill identity is invalid', { code: 'CONTROL_ARTIFACT_SOURCE_INVALID' });
    const skillRequirement = {
      id: skill.id,
      version: skill.version,
      placement: 'remote',
      source: { registry: 'installed-control-packages', artifact: `${skill.id}-${skill.version}.tgz` },
      sha256: skill.sha256,
      compatibility,
      requiredBy: ['control:dsh-remote-project'],
      bundledWith: { pluginId: pluginRequirement.id, pluginVersion: pluginRequirement.version },
    };
    const registry = new TrustedArtifactRegistry([{
      kind: 'plugin',
      ...pluginRequirement,
      size: sessionControl.size,
      packageName: sessionControl.packageJson.name,
      protocolVersion: remoteManifest.protocolVersion,
      artifactPath: sessionControl.artifactPath,
      manifest: { protocolVersion: remoteManifest.protocolVersion },
    }]);
    return {
      dshVersion: this.dshVersion,
      pnpmVersion: this.pnpmVersion,
      apiVersion: this.apiVersion,
      dsh: {
        recipePath: recipe.artifactPath,
        catalog: {
          [this.dshVersion]: { version: this.dshVersion, name: path.basename(recipe.artifactPath), sha256: recipe.sha256, size: recipe.size, pnpmVersion: this.pnpmVersion, installerSha256: await sha256File(dshInstallerPath) },
        },
      },
      remoteHost: {
        artifactPath: remoteHost.artifactPath,
        version: remoteHost.packageJson.version,
        catalog: {
          [remoteHost.packageJson.version]: { ...hostManifest, installerSha256: await sha256File(hostInstallerPath) },
        },
      },
      sessionControl: {
        artifactPath: sessionControl.artifactPath,
        packageName: sessionControl.packageJson.name,
        version: sessionControl.packageJson.version,
        sha256: sessionControl.sha256,
        size: sessionControl.size,
        pluginRequirement,
        skillRequirement,
        registry,
      },
    };
  }
}
