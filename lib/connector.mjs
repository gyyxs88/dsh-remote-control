import { randomUUID } from 'node:crypto';
import { createClientHello, createOperationEnvelope, DEFAULT_CLIENT_CAPABILITIES, negotiateVersion, newIdempotencyKey, validateHostHello, sha256 } from './protocol.mjs';
import { DshRemoteError, NeedsAttentionError, TransportError, errorFromObject } from './errors.mjs';
import { remoteRequirements, runtimeRequirements, validateDesiredState } from './desired-state.mjs';
import { loadOrCreateConnectorIdentity } from './connector-identity.mjs';

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
  constructor({ transport, sourceHostId, sourceSessionId, identity, cache = new MemoryConnectorCache(), capabilities = DEFAULT_CLIENT_CAPABILITIES, desiredStateSynchronizer = null, runtimeSynchronizer = null } = {}) {
    if (!transport || typeof transport.request !== 'function') throw new DshRemoteError('connector requires a request transport', { code: 'CONNECTOR_CONFIG_ERROR' });
    if (identity) {
      sourceHostId ??= identity.sourceHostId;
      sourceSessionId ??= identity.sourceSessionId;
    }
    if (typeof sourceHostId !== 'string' || typeof sourceSessionId !== 'string' || sourceHostId.length === 0 || sourceSessionId.length === 0) {
      throw new DshRemoteError('connector requires a persistent source identity; register its exact sourceHostId/sourceSessionId with the target Host', { code: 'CONNECTOR_IDENTITY_REQUIRED', details: { needsAttention: true } });
    }
    this.transport = transport;
    this.sourceHostId = sourceHostId;
    this.sourceSessionId = sourceSessionId;
    this.cache = cache;
    this.capabilities = capabilities;
    this.desiredStateSynchronizer = desiredStateSynchronizer;
    this.runtimeSynchronizer = runtimeSynchronizer;
    this.connection = null;
    this.lastRevision = 0;
  }

  static async create({ identityFile, ...options } = {}) {
    const identity = await loadOrCreateConnectorIdentity(identityFile);
    return new RemoteControlConnector({ ...options, identity });
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

  async openProject({ absolutePath, desiredState = { dshVersion: '0.1.1-rc.2', plugins: [], skills: [], runtimes: [], defaultPermission: 'workspace-write', modelRoute: 'local-gateway-required' }, displayName, schedule, targetSessionId, runtimeAuthTickets, idempotencyKey } = {}) {
    this.#assertConnected();
    const operationId = randomUUID();
    const normalizedDesiredState = validateDesiredState(desiredState);
    const syncResult = this.desiredStateSynchronizer
      ? await this.desiredStateSynchronizer.sync({ desiredState: normalizedDesiredState, operationId })
      : {
        status: remoteRequirements(normalizedDesiredState).length === 0 ? 'completed' : 'needs-attention',
        operationId,
        desiredStateSha256: sha256(normalizedDesiredState),
        items: [],
        ...(remoteRequirements(normalizedDesiredState).length === 0 ? {} : { error: { code: 'PLUGIN_SYNC_NOT_CONFIGURED', message: 'remote requirements require a configured Desired State synchronizer' } }),
      };
    const runtimeSyncResult = this.runtimeSynchronizer
      ? await this.runtimeSynchronizer.sync({ desiredState: normalizedDesiredState, operationId: `${operationId}:runtime` })
      : {
        status: runtimeRequirements(normalizedDesiredState).length === 0 ? 'completed' : 'needs-attention',
        operationId: `${operationId}:runtime`,
        desiredStateSha256: sha256(normalizedDesiredState),
        items: [],
        rollback: { attempted: false, status: 'not-attempted', items: [] },
        ...(runtimeRequirements(normalizedDesiredState).length === 0 ? {} : { error: { code: 'RUNTIME_SYNC_NOT_CONFIGURED', message: 'runtime requirements require a configured Runtime Synchronizer' } }),
      };
    const { operationId: _syncOperationId, ...pluginSync } = syncResult;
    const { operationId: _runtimeSyncOperationId, ...runtimeSync } = runtimeSyncResult;
    const body = { absolutePath, desiredState: normalizedDesiredState, pluginSync, runtimeSync, ...(targetSessionId ? { targetSessionId } : {}), ...(runtimeAuthTickets ? { runtimeAuthTickets } : {}), ...(displayName ? { displayName } : {}), ...(schedule ? { schedule } : {}) };
    const idempotencyBody = { absolutePath, desiredState: normalizedDesiredState, ...(targetSessionId ? { targetSessionId } : {}), ...(runtimeAuthTickets ? { runtimeAuthTickets } : {}), ...(displayName ? { displayName } : {}), ...(schedule ? { schedule } : {}) };
    const key = idempotencyKey ?? newIdempotencyKey('project.open', idempotencyBody);
    const envelope = createOperationEnvelope({
      type: 'project.open',
      operationId,
      idempotencyKey: key,
      sourceHostId: this.sourceHostId,
      sourceSessionId: this.sourceSessionId,
      targetHostId: this.connection.host.hostId,
      body,
      idempotencyBody,
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
    const response = await this.#request({ type: 'state.reconcile', hostId: this.connection.host.hostId, incarnationId: this.connection.host.incarnationId, sourceHostId: this.sourceHostId, sourceSessionId: this.sourceSessionId, targetHostId: this.connection.host.hostId, knownRevision: this.lastRevision });
    if (response.status === 'stale-local') return { ...response, accepted: false };
    if (response.incarnationId !== this.connection.host.incarnationId) throw new NeedsAttentionError('reconcile returned a different incarnation', response);
    if (response.revision < this.lastRevision) return { ...response, accepted: false };
    this.lastRevision = response.revision;
    await this.cache.save({ hostId: response.hostId, incarnationId: response.incarnationId, revision: this.lastRevision });
    return { ...response, accepted: true };
  }

  async bootstrapStatus() {
    this.#assertConnected();
    const response = await this.#request({ type: 'bootstrap.status', sourceHostId: this.sourceHostId, sourceSessionId: this.sourceSessionId, targetHostId: this.connection.host.hostId });
    this.#acceptRevision(response);
    return response;
  }

  async runtimeStatus(requirements = []) {
    this.#assertConnected();
    if (!Array.isArray(requirements)) throw new DshRemoteError('runtime requirements must be an array', { code: 'RUNTIME_REQUIREMENTS_INVALID' });
    const response = await this.#request({ type: 'runtime.status', requirements, sourceHostId: this.sourceHostId, sourceSessionId: this.sourceSessionId, targetHostId: this.connection.host.hostId });
    this.#acceptRevision(response);
    return response;
  }

  async runtimeAuthChallenge(requirement, { timeoutMs } = {}) {
    this.#assertConnected();
    const response = await this.#request({ type: 'runtime.auth.challenge', requirement, ...(Number.isSafeInteger(timeoutMs) ? { timeoutMs } : {}), sourceHostId: this.sourceHostId, sourceSessionId: this.sourceSessionId, targetHostId: this.connection.host.hostId });
    this.#acceptRevision(response);
    return response;
  }

  async runtimeAuthChallengeStatus(challengeId) {
    this.#assertConnected();
    const response = await this.#request({ type: 'runtime.auth.status', challengeId, sourceHostId: this.sourceHostId, sourceSessionId: this.sourceSessionId, targetHostId: this.connection.host.hostId });
    this.#acceptRevision(response);
    return response;
  }

  async runtimeAuthChallengeCancel(challengeId) {
    this.#assertConnected();
    const response = await this.#request({ type: 'runtime.auth.cancel', challengeId, sourceHostId: this.sourceHostId, sourceSessionId: this.sourceSessionId, targetHostId: this.connection.host.hostId });
    this.#acceptRevision(response);
    return response;
  }

  async beginRuntimeAuth(requirement, targetSessionId = undefined) {
    this.#assertConnected();
    const response = await this.#request({ type: 'runtime.auth.begin', requirement, ...(targetSessionId === undefined ? {} : { targetSessionId }), sourceHostId: this.sourceHostId, sourceSessionId: this.sourceSessionId, targetHostId: this.connection.host.hostId });
    this.#acceptRevision(response);
    return response;
  }

  async confirmRuntimeAuth({ challengeId, nonce, targetSessionId } = {}) {
    this.#assertConnected();
    const response = await this.#request({ type: 'runtime.auth.confirm', challengeId, nonce, ...(targetSessionId === undefined ? {} : { targetSessionId }), sourceHostId: this.sourceHostId, sourceSessionId: this.sourceSessionId, targetHostId: this.connection.host.hostId });
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

  async deleteSchedule({ targetSessionId, scheduleId, idempotencyKey = newIdempotencyKey('schedule.delete', { targetSessionId, scheduleId }) } = {}) {
    this.#assertConnected();
    const body = { targetSessionId, scheduleId };
    const response = await this.#request(createOperationEnvelope({
      type: 'schedule.delete',
      idempotencyKey,
      sourceHostId: this.sourceHostId,
      sourceSessionId: this.sourceSessionId,
      targetHostId: this.connection.host.hostId,
      targetSessionId,
      body,
    }));
    return this.#operationResponse(response);
  }

  async createSchedule({ targetSessionId, schedule, idempotencyKey = newIdempotencyKey('schedule.create', { targetSessionId, schedule }) } = {}) {
    this.#assertConnected();
    const body = { targetSessionId, schedule };
    const response = await this.#request(createOperationEnvelope({
      type: 'schedule.create',
      idempotencyKey,
      sourceHostId: this.sourceHostId,
      sourceSessionId: this.sourceSessionId,
      targetHostId: this.connection.host.hostId,
      targetSessionId,
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
