import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { ProtocolError } from './errors.mjs';

export const PROTOCOL_NAME = 'dsh-remote-control';
export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;
export const PROTOCOL_VERSION = `${PROTOCOL_MAJOR}.${PROTOCOL_MINOR}`;
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_PERMISSION_TTL_MS = 15 * 60_000;
export const MAX_GATEWAY_TOKEN_TTL_MS = 15 * 60_000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const OPERATION_STATES = Object.freeze([
  'pending',
  'running',
  'completed',
  'partial',
  'failed',
  'needs-attention',
]);

export const CAPABILITIES = Object.freeze({
  HOST_HELLO: 'host.hello',
  PROJECT_OPEN: 'project.open',
  OPERATION_GET: 'operation.get',
  OPERATION_LIST: 'operation.list',
  STATE_RECONCILE: 'state.reconcile',
  BOOTSTRAP_STATUS: 'bootstrap.status',
  GATEWAY_BIND: 'gateway.bind',
  GATEWAY_PROBE: 'gateway.probe',
  NATIVE_AGENT: 'agent.native',
  SESSION_CONTROL_PORT: 'session-control.port',
  SCHEDULE_PORT: 'schedule.port',
});

export const DEFAULT_HOST_CAPABILITIES = Object.freeze([
  CAPABILITIES.HOST_HELLO,
  CAPABILITIES.PROJECT_OPEN,
  CAPABILITIES.OPERATION_GET,
  CAPABILITIES.OPERATION_LIST,
  CAPABILITIES.STATE_RECONCILE,
  CAPABILITIES.BOOTSTRAP_STATUS,
  CAPABILITIES.GATEWAY_BIND,
  CAPABILITIES.GATEWAY_PROBE,
  CAPABILITIES.NATIVE_AGENT,
  CAPABILITIES.SESSION_CONTROL_PORT,
  CAPABILITIES.SCHEDULE_PORT,
]);

export const DEFAULT_CLIENT_CAPABILITIES = Object.freeze([
  CAPABILITIES.HOST_HELLO,
  CAPABILITIES.PROJECT_OPEN,
  CAPABILITIES.OPERATION_GET,
  CAPABILITIES.OPERATION_LIST,
  CAPABILITIES.STATE_RECONCILE,
  CAPABILITIES.BOOTSTRAP_STATUS,
  CAPABILITIES.GATEWAY_BIND,
  CAPABILITIES.GATEWAY_PROBE,
  CAPABILITIES.NATIVE_AGENT,
]);

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  const input = typeof value === 'string' ? value : stableJson(value);
  return createHash('sha256').update(input).digest('hex');
}

export function newIdempotencyKey(namespace, body) {
  return `${namespace}:${sha256(body).slice(0, 32)}`;
}

export function negotiateVersion({ client, host }) {
  const clientVersion = parseVersion(client?.protocolVersion ?? client);
  const hostVersion = parseVersion(host?.protocolVersion ?? host);
  if (clientVersion.major !== hostVersion.major) {
    throw new ProtocolError('protocol major version is incompatible', { client: clientVersion, host: hostVersion });
  }
  return {
    name: PROTOCOL_NAME,
    major: clientVersion.major,
    minor: Math.min(clientVersion.minor, hostVersion.minor),
    version: `${clientVersion.major}.${Math.min(clientVersion.minor, hostVersion.minor)}`,
  };
}

export function parseVersion(value) {
  if (typeof value === 'number') return { major: value, minor: 0 };
  if (typeof value !== 'string' || !/^\d+\.\d+$/.test(value)) {
    throw new ProtocolError('protocol version must be major.minor', { value });
  }
  const [major, minor] = value.split('.').map(Number);
  return { major, minor };
}

export function createClientHello({ sourceHostId, sourceSessionId, capabilities = DEFAULT_CLIENT_CAPABILITIES } = {}) {
  if (!sourceHostId || !sourceSessionId) throw new ProtocolError('client hello requires sourceHostId and sourceSessionId');
  return {
    type: CAPABILITIES.HOST_HELLO,
    protocol: { name: PROTOCOL_NAME, major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR, version: PROTOCOL_VERSION },
    sourceHostId,
    sourceSessionId,
    capabilities: [...new Set(capabilities)],
  };
}

export function createOperationEnvelope({ type, operationId = randomUUID(), idempotencyKey, sourceHostId, sourceSessionId, targetHostId, targetSessionId, body, permissionSnapshot } = {}) {
  if (!type || !type.includes('.')) throw new ProtocolError('operation type is required', { type });
  if (!operationId || !idempotencyKey || !sourceHostId || !sourceSessionId || !targetHostId) {
    throw new ProtocolError('operation identity fields are required');
  }
  const now = new Date();
  return {
    type,
    operationId,
    idempotencyKey,
    sourceHostId,
    sourceSessionId,
    targetHostId,
    ...(targetSessionId ? { targetSessionId } : {}),
    body,
    bodySha256: sha256(body),
    permissionSnapshot: permissionSnapshot ?? {
      preset: 'workspace-write',
      capturedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + MAX_PERMISSION_TTL_MS).toISOString(),
    },
  };
}

export function validateHostHello(message) {
  if (!message || message.type !== CAPABILITIES.HOST_HELLO) throw new ProtocolError('invalid host hello message');
  const protocol = message.protocol;
  if (protocol?.name !== PROTOCOL_NAME) throw new ProtocolError('host hello protocol name is invalid');
  parseVersion(protocol?.version ?? `${protocol?.major}.${protocol?.minor}`);
  if (!message.hostId || !message.incarnationId || !Array.isArray(message.capabilities)) {
    throw new ProtocolError('host hello is missing identity or capabilities');
  }
  if (message.platform !== 'linux' || message.arch !== 'x86_64') {
    throw new ProtocolError('remote host is outside Stage A target platform', { platform: message.platform, arch: message.arch });
  }
  return message;
}

export function validateOperationEnvelope(message) {
  if (!message?.operationId || !message?.idempotencyKey || !message?.sourceHostId || !message?.sourceSessionId || !message?.targetHostId) {
    throw new ProtocolError('operation envelope is missing identity fields');
  }
  if (message.bodySha256 !== sha256(message.body)) {
    throw new ProtocolError('operation body hash mismatch', { operationId: message.operationId });
  }
  validatePermissionSnapshot(message.permissionSnapshot);
  return message;
}

export function validatePermissionSnapshot(snapshot, { now = Date.now(), maxTtlMs = MAX_PERMISSION_TTL_MS } = {}) {
  const allowed = ['read-only', 'workspace-write', 'danger-full-access'];
  if (!snapshot || !allowed.includes(snapshot.preset)) throw new ProtocolError('permission snapshot preset is invalid');
  const capturedAt = ISO_TIMESTAMP.test(snapshot.capturedAt ?? '') ? Date.parse(snapshot.capturedAt) : Number.NaN;
  const expiresAt = ISO_TIMESTAMP.test(snapshot.expiresAt ?? '') ? Date.parse(snapshot.expiresAt) : Number.NaN;
  if (!Number.isFinite(capturedAt) || !Number.isFinite(expiresAt) || capturedAt > now || expiresAt <= capturedAt) {
    throw new ProtocolError('permission snapshot timestamps are invalid');
  }
  if (expiresAt - capturedAt > maxTtlMs) throw new ProtocolError('permission snapshot TTL is too long', { maxTtlMs });
  if (expiresAt <= now) throw new ProtocolError('permission snapshot has expired');
  return { preset: snapshot.preset, capturedAt: new Date(capturedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() };
}

export function validateGatewayBinding(binding = {}, { now = Date.now(), maxTtlMs = MAX_GATEWAY_TOKEN_TTL_MS } = {}) {
  const { endpoint, expiresAt, token } = binding ?? {};
  if (typeof endpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(endpoint)) throw new ProtocolError('gateway endpoint must be loopback HTTP');
  const port = Number(endpoint.slice(endpoint.lastIndexOf(':') + 1));
  if (port < 1 || port > 65535) throw new ProtocolError('gateway endpoint port is invalid');
  if (typeof token !== 'string' || !/^dshgw_[A-Za-z0-9_-]{32,}$/.test(token)) throw new ProtocolError('gateway token format is invalid');
  const expiry = ISO_TIMESTAMP.test(expiresAt ?? '') ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(expiry) || expiry <= now || expiry - now > maxTtlMs) throw new ProtocolError('gateway token expiry is invalid', { maxTtlMs });
  return { endpoint, expiresAt: new Date(expiry).toISOString(), token };
}

export function validateProjectOpenBody(body) {
  if (!body || typeof body !== 'object') throw new ProtocolError('project.open body is required');
  const absolutePath = body.absolutePath;
  if (typeof absolutePath !== 'string' || !posix.isAbsolute(absolutePath) || !absolutePath.startsWith('/')) {
    throw new ProtocolError('remote project path must be a POSIX absolute path', { absolutePath });
  }
  const normalizedPath = posix.normalize(absolutePath);
  if (absolutePath.split('/').includes('..')) {
    throw new ProtocolError('remote project path cannot contain traversal segments', { absolutePath });
  }
  const desired = body.desiredState ?? {};
  if (typeof desired.dshVersion !== 'string' || !desired.dshVersion) throw new ProtocolError('desiredState.dshVersion is required');
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(desired.defaultPermission)) {
    throw new ProtocolError('desiredState.defaultPermission is invalid');
  }
  if (!['local-gateway-required', 'remote-autonomous'].includes(desired.modelRoute)) {
    throw new ProtocolError('desiredState.modelRoute is invalid');
  }
  for (const listKey of ['plugins', 'skills', 'runtimes']) {
    if (!Array.isArray(desired[listKey] ?? [])) throw new ProtocolError(`desiredState.${listKey} must be an array`);
  }
  return { ...body, absolutePath: normalizedPath, desiredState: { ...desired, plugins: desired.plugins ?? [], skills: desired.skills ?? [], runtimes: desired.runtimes ?? [] } };
}

export function createHostHello({ hostId, incarnationId, dshVersion = '0.1.0-rc.6', capabilities = DEFAULT_HOST_CAPABILITIES, gateway = null } = {}) {
  if (!hostId || !incarnationId) throw new ProtocolError('host hello requires hostId and incarnationId');
  return {
    type: CAPABILITIES.HOST_HELLO,
    protocol: { name: PROTOCOL_NAME, major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR, version: PROTOCOL_VERSION },
    hostId,
    incarnationId,
    platform: 'linux',
    arch: 'x86_64',
    dshVersion,
    capabilities: [...new Set(capabilities)],
    gateway,
  };
}

export function createOperationRecord(envelope, { state = 'pending', revision = 0 } = {}) {
  return {
    operationId: envelope.operationId,
    idempotencyKey: envelope.idempotencyKey,
    type: envelope.type,
    sourceHostId: envelope.sourceHostId,
    sourceSessionId: envelope.sourceSessionId,
    targetHostId: envelope.targetHostId,
    targetSessionId: envelope.targetSessionId,
    bodySha256: envelope.bodySha256,
    permissionSnapshot: envelope.permissionSnapshot,
    state,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision,
    result: null,
    error: null,
  };
}
