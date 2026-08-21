#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, readdir, rename, rm, stat, lstat, symlink, writeFile } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';

// This entrypoint is intentionally self-contained: it is the only executable
// available before the first Remote Host package has been installed.
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const PROTOCOL = /^\d+\.\d+$/u;

function installerError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateInstallerInputs({ platform = process.platform, arch = process.arch, uid = typeof process.getuid === 'function' ? process.getuid() : null, version, protocolVersion, installRoot, artifact, expectedSha, atomic = false, noRoot = false } = {}) {
  if (platform !== 'linux' || arch !== 'x64') throw installerError('installer only supports Linux x86_64', 'INSTALLER_PLATFORM_UNSUPPORTED');
  if (uid === 0) throw installerError('installer refuses to run as root', 'INSTALLER_ROOT_FORBIDDEN');
  if (!VERSION.test(version ?? '')) throw installerError('version is not a supported semver value', 'INSTALLER_VERSION_INVALID');
  if (!PROTOCOL.test(protocolVersion ?? '')) throw installerError('protocol-version is invalid', 'INSTALLER_PROTOCOL_INVALID');
  if (typeof installRoot !== 'string' || !posix.isAbsolute(installRoot) || installRoot.split('/').includes('..') || /[\0\r\n]/u.test(installRoot)) throw installerError('install-root must be a safe absolute POSIX path', 'INSTALLER_PATH_INVALID');
  if (typeof artifact !== 'string' || !posix.isAbsolute(artifact) || artifact.split('/').includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(posix.basename(artifact)) || /[\0\r\n]/u.test(artifact)) throw installerError('artifact path is invalid', 'INSTALLER_ARTIFACT_INVALID');
  if (!/^[a-f0-9]{64}$/u.test(expectedSha ?? '')) throw installerError('artifact digest is invalid', 'INSTALLER_DIGEST_INVALID');
  if (atomic !== true || noRoot !== true) throw installerError('installer requires atomic and no-root policy', 'INSTALLER_POLICY_REQUIRED');
  return { version, protocolVersion, installRoot: posix.normalize(installRoot), artifact, expectedSha };
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function canonicalAncestor(value) {
  let current = value;
  const suffix = [];
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('install-root cannot traverse a symbolic link');
      const canonical = await realpath(current);
      return posix.join(canonical, ...suffix.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = posix.dirname(current);
      if (parent === current) throw new Error('install-root has no canonical ancestor');
      suffix.push(posix.basename(current));
      current = parent;
    }
  }
}

async function regularArtifact(value) {
  const info = await lstat(value);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('artifact must be a regular file');
  return info;
}

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function safeArchiveEntries(output) {
  for (const entry of output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
    if (entry.startsWith('/') || entry.split('/').includes('..') || entry.includes('\\') || !entry.startsWith('package/')) throw new Error(`archive entry is unsafe: ${entry}`);
  }
}

function validateInstallRoot(value) {
  if (typeof value !== 'string' || !posix.isAbsolute(value) || value.split('/').includes('..') || /[\0\r\n]/u.test(value)) throw new Error('install-root must be a safe absolute POSIX path');
  return posix.normalize(value);
}

function assertNonRootRuntime() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('installer only supports Linux x86_64');
  if (typeof process.getuid === 'function' && process.getuid() === 0) throw new Error('installer refuses to run as root');
}

function isWithinRoot(root, candidate) {
  const relative = posix.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !posix.isAbsolute(relative));
}

async function assertSafeTree(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(`installed package contains an unsafe entry: ${entry.name}`);
    if (entry.isDirectory()) await assertSafeTree(entryPath);
  }
}

async function status(installRoot) {
  assertNonRootRuntime();
  const root = validateInstallRoot(installRoot);
  const current = join(root, 'current');
  const currentInfo = await lstat(current);
  if (!currentInfo.isSymbolicLink()) throw new Error('current install pointer is not a symlink');
  const packageRoot = await realpath(current);
  const rootReal = await realpath(root);
  if (!isWithinRoot(rootReal, packageRoot)) throw new Error('current install pointer escapes install-root');
  await assertSafeTree(packageRoot);
  const manifest = JSON.parse(await readFile(join(packageRoot, 'manifest.json'), 'utf8'));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(manifest.name ?? '') || manifest.target !== 'linux-x86_64' || !/^\d+\.\d+$/.test(manifest.protocolVersion ?? '') || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? '') || !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '') || !Number.isSafeInteger(manifest.size) || manifest.size <= 0) throw new Error('installed manifest is invalid');
  return { status: 'installed', version: manifest.version, protocolVersion: manifest.protocolVersion, sha256: manifest.sha256, installRoot: root };
}

async function install() {
  assertNonRootRuntime();
  const artifact = option('artifact');
  const expectedSha = option('sha256');
  const inputs = validateInstallerInputs({ version: option('version'), protocolVersion: option('protocol-version'), installRoot: option('install-root'), artifact, expectedSha, atomic: process.argv.includes('--atomic'), noRoot: process.argv.includes('--no-root') });
  const { version, protocolVersion, installRoot } = inputs;
  await regularArtifact(artifact);
  const artifactBytes = await readFile(artifact);
  if (digest(artifactBytes) !== expectedSha) throw new Error('artifact SHA-256 mismatch');
  const versionsRoot = join(installRoot, 'versions');
  const versionRoot = join(versionsRoot, version);
  await canonicalAncestor(installRoot);
  await canonicalAncestor(versionsRoot);
  await mkdir(versionsRoot, { recursive: true, mode: 0o700 });
  await canonicalAncestor(versionsRoot);
  const tempRoot = join(installRoot, `.staging-${version}-${process.pid}-${randomUUID()}`);
  let nextLink;
  let moved = false;
  try {
    try {
      const existingVersion = await lstat(versionRoot);
      if (existingVersion.isSymbolicLink()) throw new Error('version install path cannot be a symlink');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const listing = execFileSync('tar', ['-tzf', artifact], { encoding: 'utf8', maxBuffer: 512 * 1024 });
    safeArchiveEntries(listing);
    execFileSync('tar', ['-xzf', artifact, '-C', tempRoot, '--no-same-owner', '--no-same-permissions'], { stdio: 'pipe' });
    const packageRoot = join(tempRoot, 'package');
    const packageInfo = await stat(packageRoot);
    if (!packageInfo.isDirectory()) throw new Error('artifact does not contain a package directory');
    await assertSafeTree(packageRoot);
    const executableEntries = [
      'dsh-remote-host.mjs',
      'dsh-remote-host-installer.mjs',
      'dsh-remote-artifact-installer.mjs',
      'dsh-model-gateway.mjs',
    ];
    for (const entry of executableEntries) {
      const entryPath = join(packageRoot, 'bin', entry);
      const entryInfo = await stat(entryPath);
      if (!entryInfo.isFile()) throw new Error(`installed bin entry is not a regular file: ${entry}`);
      const source = await readFile(entryPath, 'utf8');
      if (source.startsWith('#!/usr/bin/env node\r\n')) await writeFile(entryPath, source.replace(/^#!\/usr\/bin\/env node\r\n/u, '#!/usr/bin/env node\n'));
      await chmod(entryPath, 0o700);
    }
    await stat(join(packageRoot, 'lib', 'remote-host.mjs'));
    await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify({ name: basename(artifact), version, protocolVersion, target: 'linux-x86_64', sha256: expectedSha, size: artifactBytes.length }, null, 2)}\n`, { mode: 0o600 });
    try {
      const existing = JSON.parse(await readFile(join(versionRoot, 'package', 'manifest.json'), 'utf8'));
      if (existing.name !== basename(artifact) || existing.target !== 'linux-x86_64' || existing.protocolVersion !== protocolVersion || existing.sha256 !== expectedSha || existing.version !== version || existing.size !== artifactBytes.length) throw new Error('same version is already installed with a different artifact');
      await assertSafeTree(join(versionRoot, 'package'));
      await rm(tempRoot, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await rename(tempRoot, versionRoot);
      moved = true;
    }
    const currentLink = join(installRoot, 'current');
    try {
      const currentInfo = await lstat(currentLink);
      if (!currentInfo.isSymbolicLink()) throw new Error('current pointer is not a symlink');
      const currentTarget = await realpath(currentLink);
      const rootReal = await realpath(installRoot);
      if (!isWithinRoot(rootReal, currentTarget)) throw new Error('current pointer escapes install-root');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    nextLink = join(installRoot, `.current-${process.pid}-${randomUUID()}`);
    await symlink(`versions/${version}/package`, nextLink, 'dir');
    await rename(nextLink, currentLink);
    process.stdout.write(`${JSON.stringify({ status: 'installed', version, protocolVersion, sha256: expectedSha, installRoot })}\n`);
  } finally {
    if (!moved) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    if (nextLink) await rm(nextLink, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  if (process.argv.includes('--status')) return process.stdout.write(`${JSON.stringify(await status(validateInstallRoot(option('install-root'))))}\n`);
  return install();
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
