import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, lstat, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DshRemoteError } from './errors.mjs';

const execFile = promisify(execFileCallback);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PACKAGE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RUNTIME_ID = /^(?:codex|claude-code|grok-build|acp\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u;
const SAFE_RELATIVE_EXECUTABLE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._+@-]+(?:\/[A-Za-z0-9._+@-]+)*$/u;
const SAFE_ENTRY = /^package(?:\/[A-Za-z0-9._/@+-]+)?\/?$/u;
const LIFECYCLE_SCRIPTS = new Set(['preinstall', 'install', 'postinstall', 'prepare']);

function fail(message, code = 'PLUGIN_INSTALL_FAILED', details) {
  throw new DshRemoteError(message, { code, details });
}

function kindDirectory(kind) {
  if (kind === 'plugin') return 'plugins';
  if (kind === 'skill') return 'skills';
  if (kind === 'runtime') return 'runtimes';
  fail('artifact kind is invalid', 'PLUGIN_KIND_INVALID');
}

function validId(kind, id) {
  return kind === 'runtime' ? RUNTIME_ID.test(id ?? '') : SAFE_ID.test(id ?? '');
}

function componentRootFor(root, kind, id) {
  return join(root, kindDirectory(kind), ...id.split('/'));
}

function validateInputs({ kind, id, version, expectedSha256, installRoot, packageName, executablePath }) {
  if (!['plugin', 'skill', 'runtime'].includes(kind) || !validId(kind, id) || !SEMVER.test(version ?? '') || !SHA256.test(expectedSha256 ?? '') || !PACKAGE_NAME.test(packageName ?? '')) fail('remote artifact installer inputs are invalid', 'PLUGIN_INSTALL_INPUT_INVALID');
  if (typeof installRoot !== 'string' || installRoot.length === 0 || installRoot.includes('\0') || /[\r\n]/u.test(installRoot)) fail('remote artifact install root is invalid', 'PLUGIN_INSTALL_ROOT_INVALID');
  if (kind === 'runtime' && (typeof executablePath !== 'string' || !SAFE_RELATIVE_EXECUTABLE.test(executablePath))) fail('runtime executable path is invalid', 'RUNTIME_EXECUTABLE_INVALID');
  return { kind, id, version, expectedSha256, installRoot: resolve(installRoot), packageName, ...(kind === 'runtime' ? { executablePath } : {}) };
}

async function regularFile(filePath) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) fail('artifact must be a regular non-symlink file', 'PLUGIN_ARTIFACT_FILE_INVALID');
  return info;
}

async function canonicalAncestor(value) {
  let current = resolve(value);
  const suffix = [];
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) fail('install root cannot traverse a symbolic link', 'PLUGIN_INSTALL_ROOT_ESCAPE');
      return join(await realpath(current), ...suffix.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) fail('install root has no canonical ancestor', 'PLUGIN_INSTALL_ROOT_INVALID');
      suffix.push(basename(current));
      current = parent;
    }
  }
}

function isWithinRoot(root, candidate) {
  const value = relative(root, candidate);
  return value === '' || (!value.startsWith('..') && !value.includes('..' + '\\') && !value.includes('../'));
}

async function safeTree(root) {
  const entries = await import('node:fs/promises').then(({ readdir }) => readdir(root, { withFileTypes: true }));
  for (const entry of entries) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail('installed artifact contains an unsafe entry', 'PLUGIN_INSTALL_TREE_INVALID', { entry: entry.name });
    if (entry.isDirectory()) await safeTree(join(root, entry.name));
  }
}

function validateListing(listing) {
  const entries = listing.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (!entries.includes('package/package.json')) fail('artifact package manifest is missing', 'PLUGIN_MANIFEST_INVALID');
  for (const entry of entries) {
    if (!SAFE_ENTRY.test(entry) || entry.split('/').includes('..') || entry.includes('\\')) fail('artifact archive entry is unsafe', 'PLUGIN_ARCHIVE_INVALID', { entry });
  }
  return entries;
}

async function readPackageJson(packageRoot) {
  try { return JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')); } catch (error) { fail('installed artifact package.json is invalid', 'PLUGIN_MANIFEST_INVALID', { message: error.message }); }
}

function validatePackage(packageJson, { kind, id, version, packageName, executablePath }) {
  if (packageJson.name !== packageName || packageJson.version !== version) fail('installed artifact package identity mismatch', 'PLUGIN_MANIFEST_MISMATCH');
  const scripts = packageJson.scripts;
  if (scripts !== undefined && (!scripts || typeof scripts !== 'object' || Array.isArray(scripts))) fail('installed artifact scripts field is invalid', 'PLUGIN_INSTALL_SCRIPT_FORBIDDEN');
  const lifecycle = scripts ? Object.keys(scripts).filter((key) => LIFECYCLE_SCRIPTS.has(key)) : [];
  if (lifecycle.length > 0) fail('ordinary project artifacts cannot provide lifecycle install scripts', 'PLUGIN_INSTALL_SCRIPT_FORBIDDEN', { scripts: lifecycle });
  if (kind === 'plugin') {
    const manifest = packageJson.dsh?.remote;
    if (!manifest || manifest.pluginId !== id || manifest.version !== version || !Array.isArray(manifest.placements)) fail('plugin remote manifest is missing or mismatched', 'PLUGIN_MANIFEST_MISMATCH');
  } else if (kind === 'skill') {
    const manifest = packageJson.dsh?.skill;
    if (!manifest || manifest.skillId !== id || manifest.version !== version) fail('skill manifest is missing or mismatched', 'SKILL_MANIFEST_MISMATCH');
  } else {
    const manifest = packageJson.dsh?.runtime;
    if (!manifest || manifest.runtimeId !== id || manifest.version !== version || manifest.target !== 'linux-x86_64' || manifest.executablePath !== executablePath || !/^(?:codex|claude-code|grok-build|acp)$/u.test(manifest.driver ?? '')) fail('runtime manifest is missing or mismatched', 'RUNTIME_MANIFEST_MISMATCH');
  }
}

async function validateRuntimeExecutable(packageRoot, executablePath) {
  if (!SAFE_RELATIVE_EXECUTABLE.test(executablePath ?? '')) fail('runtime executable path is invalid', 'RUNTIME_EXECUTABLE_INVALID');
  const executable = join(packageRoot, ...executablePath.split('/'));
  const info = await lstat(executable);
  if (!info.isFile() || info.isSymbolicLink()) fail('runtime executable must be a regular non-symlink file', 'RUNTIME_EXECUTABLE_INVALID');
  if (process.platform === 'linux' && (info.mode & 0o111) === 0) fail('runtime executable is not executable', 'RUNTIME_EXECUTABLE_INVALID');
  return executable;
}

async function currentVersion({ root, kind, id }) {
  const componentRoot = componentRootFor(root, kind, id);
  const current = join(componentRoot, 'current');
  try {
    const info = await lstat(current);
    if (!info.isSymbolicLink()) fail('current artifact pointer is not a symlink', 'PLUGIN_POINTER_INVALID');
    const target = await realpath(current);
    const rootReal = await realpath(componentRoot);
    if (!isWithinRoot(rootReal, target)) fail('current artifact pointer escapes install root', 'PLUGIN_INSTALL_ROOT_ESCAPE');
    const manifest = JSON.parse(await readFile(join(target, '..', 'manifest.json'), 'utf8'));
    return { status: 'installed', current, target, manifest };
  } catch (error) {
    if (error?.code === 'ENOENT' && !await exists(current)) return { status: 'missing', current };
    throw error;
  }
}

async function exists(filePath) {
  try { await lstat(filePath); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function validateManifest(manifest, { kind, id, expected = null } = {}) {
  if (!manifest || manifest.kind !== kind || manifest.id !== id || !SEMVER.test(manifest.version ?? '') || !SHA256.test(manifest.sha256 ?? '') || !Number.isSafeInteger(manifest.size) || manifest.size <= 0 || !PACKAGE_NAME.test(manifest.packageName ?? '') || !/^\d+\.\d+$/u.test(manifest.protocolVersion ?? '') || manifest.target !== 'linux-x86_64') fail('installed artifact manifest is invalid', 'PLUGIN_MANIFEST_INVALID');
  if (kind === 'runtime' && !SAFE_RELATIVE_EXECUTABLE.test(manifest.executablePath ?? '')) fail('installed runtime executable path is invalid', 'RUNTIME_EXECUTABLE_INVALID');
  if (expected) {
    if (expected.status !== 'installed' || manifest.version !== expected.version || manifest.sha256 !== expected.sha256 || manifest.size !== expected.size || manifest.packageName !== expected.packageName || manifest.protocolVersion !== expected.protocolVersion || manifest.target !== expected.target || (kind === 'runtime' && manifest.executablePath !== expected.executablePath)) fail('rollback target does not match the installed manifest', 'PLUGIN_ROLLBACK_TARGET_MISMATCH');
  }
  return manifest;
}

async function validateInstalledVersion({ root, kind, id, target }) {
  const componentRoot = componentRootFor(root, kind, id);
  const versionRoot = join(componentRoot, 'versions', target.version);
  await canonicalAncestor(root);
  await canonicalAncestor(componentRoot);
  await canonicalAncestor(join(componentRoot, 'versions'));
  await canonicalAncestor(versionRoot);
  let versionInfo;
  try { versionInfo = await lstat(versionRoot); } catch (error) { if (error?.code === 'ENOENT') fail('rollback target version is not installed', 'PLUGIN_ROLLBACK_TARGET_NOT_FOUND', { version: target.version }); throw error; }
  if (!versionInfo.isDirectory() || versionInfo.isSymbolicLink()) fail('rollback version directory is not a regular directory', 'PLUGIN_ROLLBACK_TARGET_INVALID');
  let manifest;
  try { manifest = validateManifest(JSON.parse(await readFile(join(versionRoot, 'manifest.json'), 'utf8')), { kind, id, expected: target }); } catch (error) { if (error instanceof DshRemoteError) throw error; fail('rollback target manifest is invalid', 'PLUGIN_ROLLBACK_TARGET_INVALID', { message: error.message }); }
  const packageRoot = join(versionRoot, 'package');
  const packageInfo = await lstat(packageRoot);
  if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink()) fail('rollback package directory is invalid', 'PLUGIN_ROLLBACK_TARGET_INVALID');
  await safeTree(packageRoot);
  validatePackage(await readPackageJson(packageRoot), { kind, id, version: manifest.version, packageName: manifest.packageName, executablePath: manifest.executablePath });
  if (kind === 'runtime') await validateRuntimeExecutable(packageRoot, manifest.executablePath);
  if (kind === 'skill') {
    try { await stat(join(packageRoot, 'SKILL.md')); } catch { fail('rollback Skill package is missing SKILL.md', 'PLUGIN_ROLLBACK_TARGET_INVALID'); }
  }
  return { componentRoot, versionRoot, packageRoot, manifest };
}

async function assertCurrentPointer({ componentRoot, current }) {
  try {
    const info = await lstat(current);
    if (!info.isSymbolicLink()) fail('current artifact pointer is not a symlink', 'PLUGIN_POINTER_INVALID');
    const target = await realpath(current);
    if (!isWithinRoot(await realpath(componentRoot), target)) fail('current artifact pointer escapes install root', 'PLUGIN_INSTALL_ROOT_ESCAPE');
    return target;
  } catch (error) {
    if (error?.code === 'ENOENT' && !await exists(current)) return null;
    throw error;
  }
}

async function switchCurrent({ componentRoot, version, linkType = 'dir' }) {
  const current = join(componentRoot, 'current');
  await assertCurrentPointer({ componentRoot, current });
  const nextLink = join(componentRoot, `.current-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const linkTarget = linkType === 'junction' ? join(componentRoot, 'versions', version, 'package') : join('versions', version, 'package');
  try {
    await symlink(linkTarget, nextLink, linkType);
    // Windows junctions cannot be atomically replaced by rename; this mode is
    // test/development-only. The production Linux CLI always uses symlink+rename.
    if (linkType === 'junction') await rm(current, { recursive: true, force: true });
    await rename(nextLink, current);
    return { status: 'switched', current };
  } finally {
    await rm(nextLink, { recursive: true, force: true }).catch(() => {});
  }
}

export async function inspectRemoteArtifact({ kind, id, installRoot } = {}) {
  if (!['plugin', 'skill', 'runtime'].includes(kind) || !validId(kind, id) || typeof installRoot !== 'string') fail('artifact status inputs are invalid', 'PLUGIN_STATUS_INPUT_INVALID');
  const root = resolve(installRoot);
  await canonicalAncestor(root);
  await canonicalAncestor(componentRootFor(root, kind, id));
  const current = await currentVersion({ root, kind, id });
  if (current.status === 'missing') return { status: 'missing', kind, id };
  const manifest = validateManifest(current.manifest, { kind, id });
  await safeTree(current.target);
  validatePackage(await readPackageJson(current.target), { kind, id, version: manifest.version, packageName: manifest.packageName, executablePath: manifest.executablePath });
  if (kind === 'skill') {
    try { await stat(join(current.target, 'SKILL.md')); } catch { fail('installed Skill package is missing SKILL.md', 'SKILL_MANIFEST_INVALID'); }
  }
  if (kind === 'runtime') await validateRuntimeExecutable(current.target, manifest.executablePath);
  return { status: 'installed', kind, id, version: manifest.version, sha256: manifest.sha256, size: manifest.size, packageName: manifest.packageName, target: manifest.target, protocolVersion: manifest.protocolVersion, ...(kind === 'runtime' ? { executablePath: manifest.executablePath, executable: join(current.target, ...manifest.executablePath.split('/')) } : {}) };
}

export async function installRemoteArtifact({ artifactPath, kind, id, version, expectedSha256, installRoot, packageName, executablePath, protocolVersion = '1.0', target = 'linux-x86_64', linkType = 'dir' } = {}) {
  const inputs = validateInputs({ kind, id, version, expectedSha256, installRoot, packageName, executablePath });
  if (!['dir', 'junction'].includes(linkType)) fail('remote artifact pointer type is invalid', 'PLUGIN_POINTER_INVALID');
  if (target !== 'linux-x86_64' || !/^\d+\.\d+$/u.test(protocolVersion)) fail('remote artifact target or protocol is invalid', 'PLUGIN_MANIFEST_INVALID');
  const info = await regularFile(artifactPath);
  const bytes = await readFile(artifactPath);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256) fail('artifact SHA-256 mismatch', 'PLUGIN_ARTIFACT_HASH_MISMATCH', { expected: expectedSha256, actual });
  const root = inputs.installRoot;
  await canonicalAncestor(root);
  const componentRoot = componentRootFor(root, kind, id);
  const versionsRoot = join(componentRoot, 'versions');
  await canonicalAncestor(componentRoot);
  await canonicalAncestor(versionsRoot);
  await mkdir(versionsRoot, { recursive: true, mode: 0o700 });
  const versionRoot = join(versionsRoot, version);
  const tempRoot = join(componentRoot, `.staging-${version}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  let moved = false;
  let nextLink = null;
  try {
    await canonicalAncestor(root);
    await canonicalAncestor(componentRoot);
    await canonicalAncestor(versionsRoot);
    let existingVersion = null;
    try { existingVersion = await lstat(versionRoot); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (existingVersion) {
      if (existingVersion.isSymbolicLink()) fail('version install path cannot be a symlink', 'PLUGIN_POINTER_INVALID');
      let existingManifest;
      try { existingManifest = JSON.parse(await readFile(join(versionRoot, 'manifest.json'), 'utf8')); } catch (error) { fail('existing artifact version is incomplete; refusing to overwrite it', 'PLUGIN_VERSION_CONFLICT', { message: error.message }); }
      if (existingManifest.kind !== kind || existingManifest.id !== id || existingManifest.version !== version || existingManifest.sha256 !== expectedSha256 || existingManifest.size !== info.size || existingManifest.packageName !== packageName || kind === 'runtime' && existingManifest.executablePath !== executablePath) fail('same version is already installed with a different artifact', 'PLUGIN_VERSION_CONFLICT');
      await safeTree(join(versionRoot, 'package'));
    } else {
      await mkdir(tempRoot, { recursive: true, mode: 0o700 });
      const { stdout: listing } = await execFile('tar', ['-tzf', artifactPath], { maxBuffer: 512 * 1024, windowsHide: true });
      validateListing(listing);
      await execFile('tar', ['-xzf', artifactPath, '-C', tempRoot, '--no-same-owner', '--no-same-permissions'], { maxBuffer: 256 * 1024, windowsHide: true });
      const packageRoot = join(tempRoot, 'package');
      const packageInfo = await stat(packageRoot);
      if (!packageInfo.isDirectory()) fail('artifact does not contain a package directory', 'PLUGIN_ARCHIVE_INVALID');
      await safeTree(packageRoot);
      const packageJson = await readPackageJson(packageRoot);
      validatePackage(packageJson, inputs);
      if (kind === 'runtime') await validateRuntimeExecutable(packageRoot, executablePath);
      if (kind === 'skill') {
        try { await stat(join(packageRoot, 'SKILL.md')); } catch { fail('Skill artifact is missing SKILL.md', 'SKILL_MANIFEST_INVALID'); }
      }
      await writeFile(join(tempRoot, 'manifest.json'), `${JSON.stringify({ kind, id, version, packageName, protocolVersion, target, sha256: expectedSha256, size: info.size, ...(kind === 'runtime' ? { executablePath } : {}) }, null, 2)}\n`, { mode: 0o600 });
      await rename(tempRoot, versionRoot);
      moved = true;
    }
    await switchCurrent({ componentRoot, version, linkType });
    return { status: moved ? 'installed' : 'already-installed', kind, id, version, sha256: expectedSha256, size: info.size, packageName, target, protocolVersion, ...(kind === 'runtime' ? { executablePath, executable: join(versionRoot, 'package', ...executablePath.split('/')) } : {}) };
  } finally {
    if (!moved) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    if (nextLink) await rm(nextLink, { recursive: true, force: true }).catch(() => {});
  }
}

export async function rollbackRemoteArtifact({ kind, id, installRoot, target, linkType = 'dir' } = {}) {
  if (!['dir', 'junction'].includes(linkType)) fail('remote artifact pointer type is invalid', 'PLUGIN_POINTER_INVALID');
  if (!['plugin', 'skill', 'runtime'].includes(kind) || !validId(kind, id) || typeof installRoot !== 'string') fail('rollback inputs are invalid', 'PLUGIN_ROLLBACK_TARGET_INVALID');
  const root = resolve(installRoot);
  const componentRoot = componentRootFor(root, kind, id);
  const current = join(componentRoot, 'current');
  await canonicalAncestor(root);
  await canonicalAncestor(componentRoot);
  if (!target || typeof target !== 'object' || Array.isArray(target)) fail('rollback target is required', 'PLUGIN_ROLLBACK_TARGET_INVALID');
  if (target.status === 'missing') {
    const currentTarget = await assertCurrentPointer({ componentRoot, current });
    if (!currentTarget) return { status: 'already-missing', kind, id };
    if (linkType === 'junction') await rm(current, { recursive: true, force: true });
    else await rm(current, { force: true });
    return { status: 'missing', kind, id };
  }
  if (target.status !== 'installed' || !SEMVER.test(target.version ?? '') || !SHA256.test(target.sha256 ?? '') || !Number.isSafeInteger(target.size) || target.size <= 0 || !PACKAGE_NAME.test(target.packageName ?? '') || target.target !== 'linux-x86_64' || !/^\d+\.\d+$/u.test(target.protocolVersion ?? '') || (kind === 'runtime' && !SAFE_RELATIVE_EXECUTABLE.test(target.executablePath ?? ''))) fail('rollback target receipt is invalid', 'PLUGIN_ROLLBACK_TARGET_INVALID');
  const validated = await validateInstalledVersion({ root, kind, id, target });
  const currentStatus = await inspectRemoteArtifact({ kind, id, installRoot: root });
  if (currentStatus.status === 'installed' && currentStatus.version === target.version && currentStatus.sha256 === target.sha256 && currentStatus.size === target.size && currentStatus.packageName === target.packageName && currentStatus.target === target.target && currentStatus.protocolVersion === target.protocolVersion && (kind !== 'runtime' || currentStatus.executablePath === target.executablePath)) return { ...target, status: 'already-current', kind, id };
  await switchCurrent({ componentRoot: validated.componentRoot, version: target.version, linkType });
  return { ...target, status: 'rolled-back', kind, id };
}
