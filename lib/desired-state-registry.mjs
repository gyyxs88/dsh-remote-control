import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { DshRemoteError, ProtocolError } from './errors.mjs';
import { compareSemver, parseSemver, remoteRequirements, runtimeRequirements, requirementIsCompatible, validatePluginRequirement, validateRuntimeRequirement, validateSkillRequirement } from './desired-state.mjs';

const execFile = promisify(execFileCallback);
const SAFE_ARCHIVE_ENTRY = /^package(?:\/[A-Za-z0-9._/@+-]+)?\/?$/u;
const LIFECYCLE_SCRIPTS = new Set(['preinstall', 'install', 'postinstall', 'prepare']);
const PACKAGE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function registryKey(kind, id, version, source) {
  return `${kind}\u0000${id}\u0000${version}\u0000${source.registry}\u0000${source.artifact}`;
}

function invalid(message, details) {
  throw new ProtocolError(message, details);
}

function validateCatalogEntry(entry) {
  if (!entry || typeof entry !== 'object' || !['plugin', 'skill', 'runtime'].includes(entry.kind)) invalid('trusted artifact registry entry is invalid');
  const requirement = entry.kind === 'plugin' ? validatePluginRequirement({
    id: entry.id,
    version: entry.version,
    placement: entry.placement ?? 'remote',
    source: entry.source,
    sha256: entry.sha256,
    compatibility: entry.compatibility,
    requiredBy: entry.requiredBy ?? ['registry'],
  }) : entry.kind === 'skill' ? validateSkillRequirement({
    id: entry.id,
    version: entry.version,
    placement: entry.placement ?? 'remote',
    source: entry.source,
    sha256: entry.sha256,
    compatibility: entry.compatibility,
    requiredBy: entry.requiredBy ?? ['registry'],
  }) : validateRuntimeRequirement({
    id: entry.id,
    version: entry.version,
    placement: entry.placement ?? 'remote',
    source: entry.source,
    sha256: entry.sha256,
    size: entry.size,
    target: entry.target,
    packageName: entry.packageName,
    executablePath: entry.executablePath,
    protocolVersion: entry.protocolVersion,
    driver: entry.driver,
    authPolicy: entry.authPolicy,
    capabilities: entry.capabilities,
    compatibility: entry.compatibility,
    requiredBy: entry.requiredBy ?? ['registry'],
  });
  if (typeof entry.artifactPath !== 'string' || !isAbsolute(entry.artifactPath)) invalid('trusted artifact path must be absolute');
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0) invalid('trusted artifact size is invalid');
  if (entry.kind !== 'runtime' && (typeof entry.packageName !== 'string' || !PACKAGE_NAME.test(entry.packageName))) invalid('trusted packageName is invalid');
  if (entry.kind === 'runtime' && entry.packageName !== requirement.packageName) invalid('trusted runtime packageName does not match requirement');
  if (entry.manifest !== undefined && (!entry.manifest || typeof entry.manifest !== 'object' || Array.isArray(entry.manifest))) invalid('trusted artifact manifest is invalid');
  return { ...entry, ...requirement, key: registryKey(entry.kind, requirement.id, requirement.version, requirement.source) };
}

async function regularFile(filePath) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new DshRemoteError('trusted artifact must be a regular non-symlink file', { code: 'PLUGIN_ARTIFACT_FILE_INVALID' });
  return info;
}

function validateArchiveListing(listing) {
  const entries = listing.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (entries.length === 0) throw new DshRemoteError('plugin artifact archive is empty', { code: 'PLUGIN_ARCHIVE_INVALID' });
  for (const entry of entries) {
    if (!SAFE_ARCHIVE_ENTRY.test(entry) || entry.split('/').includes('..') || entry.includes('\\')) throw new DshRemoteError('plugin artifact contains an unsafe archive entry', { code: 'PLUGIN_ARCHIVE_INVALID', details: { entry } });
  }
  return entries;
}

async function readPackageJson(filePath) {
  try {
    const { stdout } = await execFile('tar', ['-xOzf', filePath, 'package/package.json'], { maxBuffer: 256 * 1024, windowsHide: true });
    return JSON.parse(stdout);
  } catch (error) {
    throw new DshRemoteError('plugin artifact package.json is missing or invalid', { code: 'PLUGIN_MANIFEST_INVALID', details: { message: error.message } });
  }
}

function assertNoLifecycleScripts(packageJson) {
  const scripts = packageJson?.scripts;
  if (scripts === undefined) return;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) throw new DshRemoteError('plugin artifact scripts field is invalid', { code: 'PLUGIN_INSTALL_SCRIPT_FORBIDDEN' });
  const found = Object.keys(scripts).filter((key) => LIFECYCLE_SCRIPTS.has(key));
  if (found.length > 0) throw new DshRemoteError('ordinary project artifacts cannot provide lifecycle install scripts', { code: 'PLUGIN_INSTALL_SCRIPT_FORBIDDEN', details: { scripts: found } });
}

function assertManifestMatches(entry, packageJson) {
  if (packageJson.name !== entry.packageName || packageJson.version !== entry.version) throw new DshRemoteError('plugin artifact package identity does not match trusted registry', { code: 'PLUGIN_MANIFEST_MISMATCH' });
  assertNoLifecycleScripts(packageJson);
  if (entry.kind === 'plugin') {
    const manifest = packageJson.dsh?.remote;
    if (!manifest || manifest.pluginId !== entry.id || manifest.version !== entry.version || !Array.isArray(manifest.placements) || !manifest.placements.includes(entry.placement)) throw new DshRemoteError('plugin remote manifest does not match trusted registry', { code: 'PLUGIN_MANIFEST_MISMATCH' });
    if (entry.manifest?.protocolVersion && manifest.protocolVersion !== entry.manifest.protocolVersion) throw new DshRemoteError('plugin protocol manifest does not match trusted registry', { code: 'PLUGIN_MANIFEST_MISMATCH' });
  } else if (entry.kind === 'skill') {
    const manifest = packageJson.dsh?.skill;
    if (!manifest || manifest.skillId !== entry.id || manifest.version !== entry.version) throw new DshRemoteError('skill manifest does not match trusted registry', { code: 'SKILL_MANIFEST_MISMATCH' });
  } else {
    const manifest = packageJson.dsh?.runtime;
    if (!manifest || manifest.runtimeId !== entry.id || manifest.version !== entry.version || manifest.target !== entry.target || manifest.executablePath !== entry.executablePath || manifest.protocolVersion !== entry.protocolVersion || manifest.driver !== entry.driver) throw new DshRemoteError('runtime manifest does not match trusted registry', { code: 'RUNTIME_MANIFEST_MISMATCH' });
    if (entry.manifest && (entry.manifest.target !== undefined && entry.manifest.target !== manifest.target || entry.manifest.executablePath !== undefined && entry.manifest.executablePath !== manifest.executablePath || entry.manifest.protocolVersion !== undefined && entry.manifest.protocolVersion !== manifest.protocolVersion)) throw new DshRemoteError('runtime protocol manifest does not match trusted registry', { code: 'RUNTIME_MANIFEST_MISMATCH' });
  }
}

export class TrustedArtifactRegistry {
  constructor(entries = []) {
    if (!Array.isArray(entries)) throw new ProtocolError('trusted artifact registry entries must be an array');
    this.entries = new Map();
    for (const entry of entries) {
      const normalized = validateCatalogEntry(entry);
      if (this.entries.has(normalized.key)) throw new ProtocolError('trusted artifact registry contains a duplicate entry', { key: normalized.key });
      this.entries.set(normalized.key, normalized);
    }
  }

  get size() {
    return this.entries.size;
  }

  async resolve(requirement, { dshVersion, apiVersion } = {}) {
    const normalized = requirement.kind === 'skill' ? validateSkillRequirement(requirement) : requirement.kind === 'runtime' ? validateRuntimeRequirement(requirement) : validatePluginRequirement(requirement);
    const compatibility = requirementIsCompatible(normalized, { dshVersion, apiVersion });
    if (!compatibility.ok) throw new DshRemoteError('desired state requirement is incompatible with the target DSH/API', { code: 'PLUGIN_INCOMPATIBLE', details: { id: normalized.id, version: normalized.version, dsh: compatibility.dshOk, api: compatibility.apiOk } });
    const key = registryKey(requirement.kind, normalized.id, normalized.version, normalized.source);
    const entry = this.entries.get(key);
    if (!entry) throw new DshRemoteError('desired state artifact is absent from the trusted allowlist', { code: 'PLUGIN_NOT_ALLOWLISTED', details: { id: normalized.id, version: normalized.version, source: normalized.source } });
    if (entry.sha256 !== normalized.sha256 || entry.version !== normalized.version || entry.id !== normalized.id || entry.kind !== requirement.kind) throw new DshRemoteError('desired state digest or version does not match the trusted allowlist', { code: 'PLUGIN_TRUST_MISMATCH', details: { id: normalized.id, version: normalized.version } });
    if (requirement.kind === 'runtime' && (entry.size !== normalized.size || entry.target !== normalized.target || entry.packageName !== normalized.packageName || entry.executablePath !== normalized.executablePath || entry.protocolVersion !== normalized.protocolVersion)) throw new DshRemoteError('runtime desired state does not match the trusted allowlist', { code: 'RUNTIME_TRUST_MISMATCH', details: { id: normalized.id, version: normalized.version } });
    const info = await regularFile(entry.artifactPath);
    if (info.size !== entry.size) throw new DshRemoteError('trusted artifact size does not match catalog', { code: 'PLUGIN_ARTIFACT_SIZE_MISMATCH', details: { id: normalized.id, version: normalized.version } });
    const bytes = await readFile(entry.artifactPath);
    const actual = digest(bytes);
    if (actual !== entry.sha256 || actual !== normalized.sha256) throw new DshRemoteError('trusted artifact SHA-256 does not match catalog or desired state', { code: 'PLUGIN_ARTIFACT_HASH_MISMATCH', details: { id: normalized.id, version: normalized.version } });
    if (basename(entry.artifactPath) !== normalized.source.artifact) throw new DshRemoteError('trusted artifact filename does not match its source identity', { code: 'PLUGIN_SOURCE_MISMATCH' });
    const { stdout: listing } = await execFile('tar', ['-tzf', entry.artifactPath], { maxBuffer: 512 * 1024, windowsHide: true });
    const entries = validateArchiveListing(listing);
    if (!entries.includes('package/package.json')) throw new DshRemoteError('trusted artifact has no package manifest', { code: 'PLUGIN_MANIFEST_INVALID' });
    if (requirement.kind === 'skill' && !entries.some((name) => /^package\/SKILL\.md$/u.test(name))) throw new DshRemoteError('project Skill artifact must include package/SKILL.md', { code: 'SKILL_MANIFEST_INVALID' });
    const packageJson = await readPackageJson(entry.artifactPath);
    assertManifestMatches(entry, packageJson);
    return { ...entry, requirement: normalized, archiveEntries: entries, packageJson, verified: true };
  }

  async resolveDesiredState(desiredState) {
    const results = [];
    for (const { kind, requirement } of [...remoteRequirements(desiredState), ...runtimeRequirements(desiredState)]) results.push(await this.resolve({ kind, ...requirement }, desiredState));
    return results;
  }
}

export function artifactRegistryKey(kind, id, version, source) {
  return registryKey(kind, id, version, source);
}

export function validateTrustedArtifactEntry(entry) {
  return validateCatalogEntry(entry);
}

export function compareTrustedVersion(left, right) {
  return compareSemver(parseSemver(left), parseSemver(right));
}
