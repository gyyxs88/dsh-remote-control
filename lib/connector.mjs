import { randomUUID } from 'node:crypto';
import { createClientHello, createOperationEnvelope, DEFAULT_CLIENT_CAPABILITIES, negotiateVersion, newIdempotencyKey, validateHostHello, sha256 } from './protocol.mjs';
import { DshRemoteError, NeedsAttentionError, TransportError, errorFromObject } from './errors.mjs';

export class MemoryConnectorCache {
  constructor(value = null) {
    this.value = value ? structuredClone(value) : null;
  }

  async load() {
    return this.value ? structuredClone(this.value) : null;
  }

  async save(value) {
    this.value = structuredClone(value);
  }
}

export class RemoteControlConnector {
  constructor({ transport, sourceHostId = `local-${randomUUID()}`, sourceSessionId = `session-${randomUUID()}`, cache = new MemoryConnectorCache(), capabilities = DEFAULT_CLIENT_CAPABILITIES } = {}) {
    if (!transport || typeof transport.request !== 'function') throw new DshRemoteError('connector requires a request transport', { code: 'CONNECTOR_CONFIG_ERROR' });
    this.transport = transport;
    this.sourceHostId = sourceHostId;
    this.sourceSessionId = sourceSessionId;
    this.cache = cache;
    this.capabilities = capabilities;
    this.connection = null;
    this.lastRevision = 0;
  }

  async connect() {
    const response = await this.#request(createClientHello({ sourceHostId: this.sourceHostId, sourceSessionId: this.sourceSessionId, capabilities: this.capabilities }));
    if (response.type !== 'host.hello.response') throw new DshRemoteError('remote did not return host hello response', { code: 'HANDSHAKE_INVALID' });
    validateHostHello(response.host);
    const previous = await this.cache.load();
    if (previous && previous.hostId === response.host.hostId && previous.incarnationId !== response.host.incarnationId) {
      this.connection = { status: 'needs-attention', reason: 'host-incarnation-changed', previous, current: response.host };
      throw new NeedsAttentionError('host incarnation changed; explicit re-adoption is required', this.connection);
    }
    if (previous && previous.hostId !== response.host.hostId) {
      this.connection = { status: 'needs-attention', reason: 'host-id-changed', previous, current: response.host };
      throw new NeedsAttentionError('host identity changed; explicit re-adoption is required', this.connection);
    }
    this.connection = { status: 'connected', host: response.host, negotiated: response.negotiated };
    this.lastRevision = Math.max(this.lastRevision, Number(response.revision ?? 0));
    await this.cache.save({ hostId: response.host.hostId, incarnationId: response.host.incarnationId, revision: this.lastRevision });
    return structuredClone(this.connection);
  }

  async openProject({ absolutePath, desiredState = { dshVersion: '0.1.0-rc.6', plugins: [], skills: [], runtimes: [], defaultPermission: 'workspace-write', modelRoute: 'local-gateway-required' }, displayName, schedule, idempotencyKey } = {}) {
    this.#assertConnected();
    const body = { absolutePath, desiredState, ...(displayName ? { displayName } : {}), ...(schedule ? { schedule } : {}) };
    const key = idempotencyKey ?? newIdempotencyKey('project.open', body);
    const envelope = createOperationEnvelope({
      type: 'project.open',
      operationId: randomUUID(),
      idempotencyKey: key,
      sourceHostId: this.sourceHostId,
      sourceSessionId: this.sourceSessionId,
      targetHostId: this.connection.host.hostId,
      body,
    });
    const response = await this.#request(envelope);
    return this.#operationResponse(response);
  }

  async getOperation(operationId) {
    this.#assertConnected();
    const response = await this.#request({
      type: 'operation.get',
      operationId,
      sourceHostId: this.sourceHostId,
      sourceSessionId: this.sourceSessionId,
      targetHostId: this.connection.host.hostId,
    });
    return this.#operationResponse(response);
  }

  async listOperations(limit = 50) {
    this.#assertConnected();
    const response = await this.#request({ type: 'operation.list', limit, sourceHostId: this.sourceHostId, sourceSessionId: this.sourceSessionId, targetHostId: this.connection.host.hostId });
    this.#acceptRevision(response);
    return response;
  }

  async reconcile() {
    this.#assertConnected();
    const response = await this.#request({ type: 'state.reconcile', hostId: this.connection.host.hostId, incarnationId: this.connection.host.incarnationId, sourceHostId: this.sourceHostId, sourceSessionId: this.sourceSessionId, knownRevision: this.lastRevision });
    if (response.status === 'stale-local') return { ...response, accepted: false };
    if (response.incarnationId !== this.connection.host.incarnationId) throw new NeedsAttentionError('reconcile returned a different incarnation', response);
    if (response.revision < this.lastRevision) return { ...response, accepted: false };
    this.lastRevision = response.revision;
    await this.cache.save({ hostId: response.hostId, incarnationId: response.incarnationId, revision: this.lastRevision });
    return { ...response, accepted: true };
  }

  async bootstrapStatus() {
    this.#assertConnected();
    const response = await this.#request({ type: 'bootstrap.status' });
    this.#acceptRevision(response);
    return response;
  }

  async bindGateway({ endpoint, expiresAt, token, idempotencyKey = newIdempotencyKey('gateway.bind', { endpoint, expiresAt }) } = {}) {
    this.#assertConnected();
    const body = { endpoint, expiresAt, token };
    const response = await this.#request(createOperationEnvelope({
      type: 'gateway.bind',
      idempotencyKey,
      sourceHostId: this.sourceHostId,
      sourceSessionId: this.sourceSessionId,
      targetHostId: this.connection.host.hostId,
      body,
    }));
    return this.#operationResponse(response);
  }

  #operationResponse(response) {
    if (response.type !== 'operation.result' || !response.operation) throw new DshRemoteError('invalid operation response', { code: 'OPERATION_RESPONSE_INVALID' });
    this.#acceptRevision(response.operation);
    return structuredClone(response.operation);
  }

  #acceptRevision(value) {
    const revision = Number(value?.revision ?? 0);
    if (revision < this.lastRevision) return false;
    this.lastRevision = revision;
    void this.cache.save({ hostId: this.connection.host.hostId, incarnationId: this.connection.host.incarnationId, revision: this.lastRevision });
    return true;
  }

  async #request(message) {
    try {
      const response = await this.transport.request(message);
      if (response?.type === 'error') throw errorFromObject(response.error);
      return response;
    } catch (error) {
      if (error instanceof DshRemoteError) throw error;
      throw new TransportError('remote request failed', { cause: error?.message ?? String(error), type: message?.type });
    }
  }

  #assertConnected() {
    if (!this.connection || this.connection.status !== 'connected') throw new DshRemoteError('connector is not connected', { code: 'NOT_CONNECTED' });
  }
}

export class FakeTransport {
  constructor(daemon) {
    this.daemon = daemon;
    this.dropNextResponse = false;
    this.requests = [];
  }

  async request(message) {
    this.requests.push(structuredClone(message));
    const response = await this.daemon.handle(message);
    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      throw new TransportError('fake transport dropped response after remote processing', { type: message.type });
    }
    return response;
  }
}

export function makeOperationIdempotencyDigest(request) {
  return sha256(request);
}
