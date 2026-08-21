import { ProtocolError } from './errors.mjs';

export const DESIRED_STATE_PROTOCOL_VERSION = '1.0';
export const DESIRED_STATE_API_VERSION = '1.0';
export const PLACEMENTS = Object.freeze(['control', 'remote', 'both']);
export const REQUIREMENT_KINDS = Object.freeze(['plugin', 'skill']);
export const RUNTIME_TARGET = 'linux-x86_64';
export const RUNTIME_DRIVERS = Object.freeze(['codex', 'claude-code', 'grok-build', 'acp']);
export const RUNTIME_AUTH_POLICIES = Object.freeze(['remote-user', 'api-key', 'driver-defined']);

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
const API_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PACKAGE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REQUIRED_BY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const RUNTIME_ID = /^(?:codex|claude-code|grok-build|acp\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u;
const SAFE_RELATIVE_EXECUTABLE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._+@-]+(?:\/[A-Za-z0-9._+@-]+)*$/u;
const CAPABILITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

function fail(message, details) {
  throw new ProtocolError(message, details);
}

function requiredString(value, field, pattern = null) {
  if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) {
    fail(`${field} is invalid`, { field });
  }
  return value;
}

export function parseSemver(value, field = 'version') {
  requiredString(value, field, SEMVER);
  const match = SEMVER.exec(value);
  const core = value.split('+', 1)[0].split('-', 1)[0].split('.').map(Number);
  const prerelease = match?.[1]?.split('.').map((part) => /^\d+$/u.test(part) ? Number(part) : part) ?? [];
  return { value, major: core[0], minor: core[1], patch: core[2], prerelease };
}

export function compareSemver(left, right) {
  const a = typeof left === 'string' ? parseSemver(left) : left;
  const b = typeof right === 'string' ? parseSemver(right) : right;
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    if (index >= a.prerelease.length) return -1;
    if (index >= b.prerelease.length) return 1;
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === bv) continue;
    if (typeof av === 'number' && typeof bv === 'string') return -1;
    if (typeof av === 'string' && typeof bv === 'number') return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function validateCompatibility(value, field, parser) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} compatibility is required`, { field });
  const min = parser(value.min, `${field}.min`);
  const max = parser(value.max, `${field}.max`);
  if (compareSemver(min, max) > 0) fail(`${field} compatibility range is reversed`, { field });
  return { min: min.value, max: max.value };
}

function validateSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) fail('requirement source is required');
  const registry = requiredString(source.registry, 'source.registry', SOURCE_ID);
  const artifact = requiredString(source.artifact, 'source.artifact', /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u);
  return { registry, artifact };
}

function validateRequiredBy(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) fail('requiredBy must be a non-empty array');
  const result = [...new Set(value.map((item) => requiredString(item, 'requiredBy item', REQUIRED_BY)))];
  if (result.length !== value.length) fail('requiredBy must not contain duplicates');
  return result;
}

function validateRequirement(input, kind) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`${kind} requirement must be an object`);
  const id = requiredString(input.id, `${kind}.id`, ID);
  const version = parseSemver(input.version, `${kind}.version`).value;
  if (!PLACEMENTS.includes(input.placement)) fail(`${kind}.placement is invalid`, { placement: input.placement });
  const source = validateSource(input.source);
  const sha256 = requiredString(input.sha256, `${kind}.sha256`, SHA256);
  const dsh = validateCompatibility(input.compatibility?.dsh, `${kind}.compatibility.dsh`, parseSemver);
  const api = validateCompatibility(input.compatibility?.api, `${kind}.compatibility.api`, parseApiVersion);
  const requiredBy = validateRequiredBy(input.requiredBy);
  const result = {
    id,
    version,
    placement: input.placement,
    source,
    sha256,
    compatibility: { dsh, api },
    requiredBy,
  };
  if (kind === 'skill' && input.bundledWith !== undefined && input.bundledWith !== null) {
    if (!input.bundledWith || typeof input.bundledWith !== 'object') fail('skill.bundledWith is invalid');
    result.bundledWith = {
      pluginId: requiredString(input.bundledWith.pluginId, 'skill.bundledWith.pluginId', ID),
      pluginVersion: parseSemver(input.bundledWith.pluginVersion, 'skill.bundledWith.pluginVersion').value,
    };
  }
  return result;
}

export function validatePluginRequirement(input) {
  return validateRequirement(input, 'plugin');
}

export function validateSkillRequirement(input) {
  return validateRequirement(input, 'skill');
}

export function validateRuntimeRequirement(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('runtime requirement must be an object');
  const id = requiredString(input.id, 'runtime.id', RUNTIME_ID);
  const version = parseSemver(input.version, 'runtime.version').value;
  if (input.placement !== 'remote') fail('runtime.placement must be remote', { placement: input.placement });
  const source = validateSource(input.source);
  const sha256 = requiredString(input.sha256, 'runtime.sha256', SHA256);
  if (!Number.isSafeInteger(input.size) || input.size <= 0) fail('runtime.size is invalid');
  const target = requiredString(input.target, 'runtime.target');
  if (target !== RUNTIME_TARGET) fail('runtime.target is unsupported', { target });
  const packageName = requiredString(input.packageName, 'runtime.packageName', PACKAGE_NAME);
  const executablePath = requiredString(input.executablePath, 'runtime.executablePath', SAFE_RELATIVE_EXECUTABLE);
  const protocolVersion = requiredString(input.protocolVersion ?? DESIRED_STATE_PROTOCOL_VERSION, 'runtime.protocolVersion', /^\d+\.\d+$/u);
  const driver = requiredString(input.driver, 'runtime.driver');
  if (!RUNTIME_DRIVERS.includes(driver)) fail('runtime.driver is invalid', { driver });
  const authPolicy = requiredString(input.authPolicy, 'runtime.authPolicy');
  if (!RUNTIME_AUTH_POLICIES.includes(authPolicy)) fail('runtime.authPolicy is invalid', { authPolicy });
  const dsh = validateCompatibility(input.compatibility?.dsh, 'runtime.compatibility.dsh', parseSemver);
  const api = validateCompatibility(input.compatibility?.api, 'runtime.compatibility.api', parseApiVersion);
  const requiredBy = validateRequiredBy(input.requiredBy);
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0 || input.capabilities.length > 64) fail('runtime.capabilities must be a non-empty array');
  const capabilities = [...new Set(input.capabilities.map((value) => requiredString(value, 'runtime.capability', CAPABILITY_ID)))];
  if (capabilities.length !== input.capabilities.length) fail('runtime.capabilities must not contain duplicates');
  return { id, version, placement: 'remote', source, sha256, size: input.size, target, packageName, executablePath, protocolVersion, driver, authPolicy, capabilities, compatibility: { dsh, api }, requiredBy };
}

export function isRemotePlacement(placement) {
  return placement === 'remote' || placement === 'both';
}

export function validateDesiredState(input, { allowRuntimes = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('desiredState must be an object');
  const dshVersion = parseSemver(input.dshVersion, 'desiredState.dshVersion').value;
  const apiVersion = requiredString(input.apiVersion ?? DESIRED_STATE_API_VERSION, 'desiredState.apiVersion', API_VERSION);
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(input.defaultPermission)) fail('desiredState.defaultPermission is invalid');
  if (!['local-gateway-required', 'remote-autonomous'].includes(input.modelRoute)) fail('desiredState.modelRoute is invalid');
  if (!Array.isArray(input.plugins ?? [])) fail('desiredState.plugins must be an array');
  if (!Array.isArray(input.skills ?? [])) fail('desiredState.skills must be an array');
  if (allowRuntimes && !Array.isArray(input.runtimes ?? [])) fail('desiredState.runtimes must be an array');
  const plugins = (input.plugins ?? []).map(validatePluginRequirement);
  const skills = (input.skills ?? []).map(validateSkillRequirement);
  const runtimes = allowRuntimes ? (input.runtimes ?? []).map(validateRuntimeRequirement) : [];
  const seen = new Set();
  for (const requirement of [...plugins, ...skills, ...runtimes]) {
    const key = `${requirement.id}\u0000${requirement.version}\u0000${requirement.placement}`;
    if (seen.has(key)) fail('desiredState contains a duplicate requirement', { id: requirement.id, version: requirement.version });
    seen.add(key);
  }
  return {
    dshVersion,
    apiVersion,
    plugins,
    skills,
    runtimes,
    defaultPermission: input.defaultPermission,
    modelRoute: input.modelRoute,
  };
}

export function requirementIsCompatible(requirement, { dshVersion, apiVersion } = {}) {
  const dsh = parseSemver(dshVersion, 'current dshVersion');
  const api = requiredString(apiVersion, 'current apiVersion', API_VERSION);
  const dshRange = requirement.compatibility.dsh;
  const apiRange = requirement.compatibility.api;
  const dshOk = compareSemver(dsh, dshRange.min) >= 0 && compareSemver(dsh, dshRange.max) <= 0;
  const apiOk = compareSemver({ ...apiVersionParts(api), prerelease: [] }, { ...apiVersionParts(apiRange.min), prerelease: [] }) >= 0
    && compareSemver({ ...apiVersionParts(api), prerelease: [] }, { ...apiVersionParts(apiRange.max), prerelease: [] }) <= 0;
  return { ok: dshOk && apiOk, dshOk, apiOk };
}

function apiVersionParts(value) {
  const [major, minor] = value.split('.').map(Number);
  return { value, major, minor, patch: 0, prerelease: [] };
}

function parseApiVersion(value, field) {
  requiredString(value, field, API_VERSION);
  return apiVersionParts(value);
}

export function remoteRequirements(desiredState) {
  const state = validateDesiredState(desiredState);
  return [
    ...state.plugins.filter((requirement) => isRemotePlacement(requirement.placement)).map((requirement) => ({ kind: 'plugin', requirement })),
    ...state.skills.filter((requirement) => isRemotePlacement(requirement.placement) && !requirement.bundledWith).map((requirement) => ({ kind: 'skill', requirement })),
  ];
}

export function runtimeRequirements(desiredState) {
  return validateDesiredState(desiredState).runtimes.map((requirement) => ({ kind: 'runtime', requirement }));
}

export function validateSyncReceipt(receipt, desiredState) {
  const state = validateDesiredState(desiredState);
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail('pluginSync receipt is required');
  if (!['completed', 'partial', 'incompatible', 'needs-attention', 'persistence-unknown'].includes(receipt.status)) fail('pluginSync status is invalid');
  if (typeof receipt.desiredStateSha256 !== 'string' || !SHA256.test(receipt.desiredStateSha256)) fail('pluginSync desiredStateSha256 is invalid');
  if (!Array.isArray(receipt.items)) fail('pluginSync items must be an array');
  const required = remoteRequirements(state);
  const expected = new Map(required.map(({ kind, requirement }) => [`${kind}:${requirement.id}@${requirement.version}`, requirement]));
  const seen = new Set();
  for (const item of receipt.items) {
    const allowedStatuses = receipt.status === 'completed' ? ['installed', 'reused', 'verified'] : ['installed', 'reused', 'verified', 'unknown', 'not-current'];
    if (!item || typeof item !== 'object' || typeof item.key !== 'string' || typeof item.version !== 'string' || !SHA256.test(item.sha256 ?? '') || !allowedStatuses.includes(item.status)) fail('pluginSync item is not a valid artifact result');
    const requirement = expected.get(item.key);
    if (!requirement || seen.has(item.key) || item.version !== requirement.version || item.sha256 !== requirement.sha256) fail('pluginSync item does not bind to a required artifact', { key: item.key });
    seen.add(item.key);
  }
  if (receipt.status === 'completed' && seen.size !== required.length) fail('completed pluginSync receipt is missing a required artifact');
  const rollback = validateRollbackReceipt(receipt.rollback, expected);
  return { ...receipt, ...(rollback ? { rollback } : {}), requiredRemoteCount: required.length };
}

function validateRollbackReceipt(value, expected) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.attempted !== 'boolean' || !['not-attempted', 'completed', 'failed', 'unknown'].includes(value.status) || !Array.isArray(value.items)) fail('pluginSync rollback receipt is invalid');
  if (!value.attempted && (value.status !== 'not-attempted' || value.items.length > 0)) fail('non-attempted rollback receipt is inconsistent');
  if (value.attempted && value.status === 'not-attempted') fail('attempted rollback receipt has no terminal status');
  const seen = new Set();
  const items = value.items.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.key !== 'string' || !['completed', 'failed', 'unknown'].includes(item.status) || seen.has(item.key) || !expected.has(item.key)) fail('pluginSync rollback item is not bound to a required artifact');
    seen.add(item.key);
    const target = item.target;
    if (!target || typeof target !== 'object' || Array.isArray(target) || !['missing', 'installed'].includes(target.status)) fail('pluginSync rollback target is invalid');
    if (target.status === 'installed' && (!SEMVER.test(target.version ?? '') || !SHA256.test(target.sha256 ?? '') || !Number.isSafeInteger(target.size) || target.size <= 0 || !PACKAGE_NAME.test(target.packageName ?? '') || target.target !== 'linux-x86_64' || !/^\d+\.\d+$/u.test(target.protocolVersion ?? ''))) fail('pluginSync rollback installed target is invalid');
    return { ...item, target: structuredClone(target) };
  });
  if (value.status === 'completed' && items.some((item) => item.status !== 'completed')) fail('completed rollback receipt contains a non-completed item');
  if (value.status === 'unknown' && !items.some((item) => item.status === 'unknown')) fail('unknown rollback receipt has no unknown item');
  return { ...value, items };
}

export function validateRuntimeSyncReceipt(receipt, desiredState) {
  const state = validateDesiredState(desiredState);
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail('runtimeSync receipt is required');
  if (!['completed', 'partial', 'incompatible', 'needs-attention', 'persistence-unknown'].includes(receipt.status)) fail('runtimeSync status is invalid');
  if (typeof receipt.desiredStateSha256 !== 'string' || !SHA256.test(receipt.desiredStateSha256)) fail('runtimeSync desiredStateSha256 is invalid');
  if (!Array.isArray(receipt.items)) fail('runtimeSync items must be an array');
  const required = state.runtimes;
  const expected = new Map(required.map((requirement) => [`runtime:${requirement.id}@${requirement.version}`, requirement]));
  const seen = new Set();
  for (const item of receipt.items) {
    const allowedStatuses = receipt.status === 'completed' ? ['installed', 'reused', 'verified'] : ['installed', 'reused', 'verified', 'unknown', 'not-current'];
    if (!item || typeof item !== 'object' || typeof item.key !== 'string' || !allowedStatuses.includes(item.status) || item.version === undefined || !SHA256.test(item.sha256 ?? '') || !Number.isSafeInteger(item.size) || item.size <= 0 || item.target !== RUNTIME_TARGET || typeof item.packageName !== 'string' || !PACKAGE_NAME.test(item.packageName) || typeof item.executablePath !== 'string' || !SAFE_RELATIVE_EXECUTABLE.test(item.executablePath)) fail('runtimeSync item is invalid');
    const requirement = expected.get(item.key);
    if (!requirement || seen.has(item.key) || item.version !== requirement.version || item.sha256 !== requirement.sha256 || item.size !== requirement.size || item.packageName !== requirement.packageName || item.executablePath !== requirement.executablePath || item.protocolVersion !== requirement.protocolVersion) fail('runtimeSync item does not bind to a required runtime', { key: item.key });
    seen.add(item.key);
  }
  if (receipt.status === 'completed' && seen.size !== required.length) fail('completed runtimeSync receipt is missing a required runtime');
  const rollback = receipt.rollback;
  if (rollback !== undefined && rollback !== null) {
    if (!rollback || typeof rollback !== 'object' || typeof rollback.attempted !== 'boolean' || !['not-attempted', 'completed', 'failed', 'unknown'].includes(rollback.status) || !Array.isArray(rollback.items)) fail('runtimeSync rollback receipt is invalid');
    const rollbackSeen = new Set();
    for (const item of rollback.items) {
      if (!item || typeof item !== 'object' || typeof item.key !== 'string' || !['completed', 'failed', 'unknown'].includes(item.status) || rollbackSeen.has(item.key) || !expected.has(item.key)) fail('runtimeSync rollback item is not bound to a required runtime');
      rollbackSeen.add(item.key);
      const target = item.target;
      if (!target || typeof target !== 'object' || !['missing', 'installed'].includes(target.status)) fail('runtimeSync rollback target is invalid');
      if (target.status === 'installed' && (!SEMVER.test(target.version ?? '') || !SHA256.test(target.sha256 ?? '') || !Number.isSafeInteger(target.size) || target.size <= 0 || target.target !== RUNTIME_TARGET || !PACKAGE_NAME.test(target.packageName ?? '') || !SAFE_RELATIVE_EXECUTABLE.test(target.executablePath ?? '') || !/^\d+\.\d+$/u.test(target.protocolVersion ?? ''))) fail('runtimeSync rollback installed target is invalid');
    }
    if (!rollback.attempted && (rollback.status !== 'not-attempted' || rollback.items.length > 0)) fail('runtimeSync non-attempted rollback receipt is inconsistent');
    if (rollback.attempted && rollback.status === 'not-attempted') fail('runtimeSync attempted rollback has no terminal status');
    if (rollback.status === 'completed' && rollback.items.some((item) => item.status !== 'completed')) fail('runtimeSync completed rollback contains a non-completed item');
    if (rollback.status === 'unknown' && !rollback.items.some((item) => item.status === 'unknown')) fail('runtimeSync unknown rollback has no unknown item');
  }
  return { ...receipt, requiredRuntimeCount: required.length };
}
