import { ProtocolError } from './errors.mjs';
import {
  DESIRED_STATE_API_VERSION,
  RUNTIME_AUTH_POLICIES,
  RUNTIME_DRIVERS,
  RUNTIME_TARGET,
  compareSemver,
  parseSemver,
  requirementIsCompatible,
  validateDesiredState,
  validateRuntimeRequirement,
} from './desired-state.mjs';

// A channel declaration is not an artifact identity. It contains the stable
// runtime contract a channel needs; an administrator catalog supplies the
// vendor version, bytes, source and executable layout later.
export const CHANNEL_RUNTIME_DECLARATION_VERSION = '1.0';

const ID = /^(?:codex|claude-code|grok-build|acp\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u;
const CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

function fail(message, details) { throw new ProtocolError(message, details); }
function text(value, field, pattern) { if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) fail(`${field} is invalid`, { field }); return value; }
function compatibility(value, field, api = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} is required`);
  const parser = api ? (v, f) => text(v, f, /^\d+\.\d+$/u) : (v, f) => parseSemver(v, f).value;
  const min = parser(value.min, `${field}.min`); const max = parser(value.max, `${field}.max`);
  if (api ? min.localeCompare(max, undefined, { numeric: true }) > 0 : compareSemver(min, max) > 0) fail(`${field} range is reversed`);
  return { min, max };
}

export function validateChannelRuntimeDeclaration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('channel runtime declaration is required');
  const runtimeId = text(input.runtimeId ?? input.id, 'channelRuntime.runtimeId', ID);
  const driver = text(input.driver, 'channelRuntime.driver');
  if (!RUNTIME_DRIVERS.includes(driver)) fail('channelRuntime.driver is invalid', { driver });
  if (input.placement !== 'remote') fail('channelRuntime.placement must be remote');
  const protocolVersion = text(input.protocolVersion, 'channelRuntime.protocolVersion', /^\d+\.\d+$/u);
  const authPolicy = text(input.authPolicy, 'channelRuntime.authPolicy');
  if (!RUNTIME_AUTH_POLICIES.includes(authPolicy)) fail('channelRuntime.authPolicy is invalid');
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) fail('channelRuntime.capabilities must be non-empty');
  const capabilities = [...new Set(input.capabilities.map((value) => text(value, 'channelRuntime.capability', CAPABILITY)))];
  if (capabilities.length !== input.capabilities.length) fail('channelRuntime.capabilities must not contain duplicates');
  const dsh = compatibility(input.compatibility?.dsh, 'channelRuntime.compatibility.dsh');
  const api = compatibility(input.compatibility?.api, 'channelRuntime.compatibility.api', true);
  return { schemaVersion: input.schemaVersion ?? CHANNEL_RUNTIME_DECLARATION_VERSION, runtimeId, driver, placement: 'remote', protocolVersion, authPolicy, capabilities, compatibility: { dsh, api } };
}

function declarationFromSelection(selection) {
  const declaration = selection?.declaration ?? selection?.manifest?.dsh?.remote?.channelRuntime;
  if (!declaration) fail('selected channel is missing dsh.remote.channelRuntime', { channel: selection?.channelId ?? selection?.id });
  return validateChannelRuntimeDeclaration(declaration);
}

function catalogCandidates(catalog, declaration, { dshVersion, apiVersion, pin }) {
  const entries = Array.isArray(catalog) ? catalog : Array.isArray(catalog?.runtimeArtifacts) ? catalog.runtimeArtifacts : [];
  return entries.filter((entry) => {
    if (!entry || entry.kind !== 'runtime' || entry.id !== declaration.runtimeId || entry.driver !== declaration.driver || entry.protocolVersion !== declaration.protocolVersion || entry.target !== RUNTIME_TARGET || entry.placement !== 'remote') return false;
    if (!Array.isArray(entry.capabilities) || declaration.capabilities.some((capability) => !entry.capabilities.includes(capability))) return false;
    if (pin && (entry.version !== pin.version || entry.sha256 !== pin.sha256)) return false;
    return requirementIsCompatible({ compatibility: entry.compatibility }, { dshVersion, apiVersion }).ok;
  });
}

/** Resolve channel declarations to exact trusted artifact requirements. */
export function deriveRuntimeRequirements({ channels = [], trustedCatalog, channelPins = {}, dshVersion, apiVersion } = {}) {
  if (!Array.isArray(channels)) fail('selected channels must be an array');
  const result = [];
  const seen = new Set();
  for (const selection of channels) {
    const declaration = declarationFromSelection(selection);
    const pin = channelPins?.[selection.channelId ?? declaration.runtimeId] ?? channelPins?.[declaration.runtimeId];
    if (pin !== undefined && (!pin || typeof pin !== 'object' || !parseSemver(pin.version, 'channelPins.version') || !/^[a-f0-9]{64}$/u.test(pin.sha256 ?? ''))) fail('channel runtime pin is invalid', { runtimeId: declaration.runtimeId });
    const candidates = catalogCandidates(trustedCatalog, declaration, { dshVersion, apiVersion, pin });
    if (candidates.length === 0) fail('selected channel runtime is absent or incompatible in the trusted catalog', { runtimeId: declaration.runtimeId, driver: declaration.driver });
    if (candidates.length !== 1) fail('trusted catalog has more than one artifact for a channel runtime; administrator pin is required', { runtimeId: declaration.runtimeId });
    const entry = candidates[0];
    const requiredBy = [...new Set([
      ...(Array.isArray(selection.requiredBy) ? selection.requiredBy : []),
      ...(selection.pluginId ? [`plugin:${selection.pluginId}`] : []),
      `channel:${selection.channelId ?? declaration.runtimeId}`,
    ])];
    const requirement = validateRuntimeRequirement({ ...entry, id: declaration.runtimeId, placement: 'remote', requiredBy });
    const key = `${requirement.id}\u0000${requirement.version}`;
    if (!seen.has(key)) { result.push(requirement); seen.add(key); }
    else {
      const existing = result.find((item) => `${item.id}\u0000${item.version}` === key);
      existing.requiredBy = [...new Set([...existing.requiredBy, ...requiredBy])];
    }
  }
  return result;
}

/** Build Desired State from selected plugins/channels without hand-written runtimes. */
export function buildDesiredState({ dshVersion, apiVersion = DESIRED_STATE_API_VERSION, plugins = [], skills = [], channels = [], trustedCatalog, channelPins = {}, defaultPermission, modelRoute, runtimes } = {}) {
  if (runtimes !== undefined && channels.length > 0) fail('runtime requirements are derived from selected channels; do not provide them manually');
  return validateDesiredState({ dshVersion, apiVersion, plugins, skills, runtimes: runtimes ?? deriveRuntimeRequirements({ channels, trustedCatalog, channelPins, dshVersion, apiVersion }), defaultPermission, modelRoute });
}
