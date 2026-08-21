import { randomUUID } from 'node:crypto';
import { CAPABILITIES, DEFAULT_HOST_CAPABILITIES, createHostHello, createOperationRecord, negotiateVersion, validateGatewayBinding, validateHostHello, validateOperationEnvelope, validateProjectOpenBody, sha256 } from './protocol.mjs';
import { errorToObject, DshRemoteError, NeedsAttentionError, ProtocolError } from './errors.mjs';
import { JsonStateStore, MemoryStateStore, createInitialHostState } from './state-store.mjs';
import { StageARuntimeManager } from './runtime-manager.mjs';
import { SessionControlPort } from './session-control-port.mjs';
import { RemoteGatewayModelAdapter } from './gateway.mjs';
import { assertWithinAllowedRoot } from './path-safety.mjs';
import { remoteRequirements, runtimeRequirements, validateRuntimeRequirement } from './desired-state.mjs';

export class RemoteHostDaemon {
  constructor({ store, sessionControl, runtimeManager = new StageARuntimeManager(), dshVersion = '0.1.0-rc.6', allowedRoot = null, capabilities = DEFAULT_HOST_CAPABILITIES } = {}) {
    if (!store) throw new DshRemoteError('RemoteHostDaemon requires a state store', { code: 'HOST_CONFIG_ERROR' });
    if (!(sessionControl instanceof SessionControlPort) && typeof sessionControl?.openProject !== 'function') {
      throw new DshRemoteError('RemoteHostDaemon requires a SessionControlPort', { code: 'HOST_CONFIG_ERROR' });
    }
    if (sessionControl.ready !== true) throw new DshRemoteError('RemoteHostDaemon requires a ready SessionControlPort; refusing to advertise session capability', { code: 'SESSION_CONTROL_REQUIRED' });
    this.store = store;
    this.sessionControl = sessionControl;
    this.runtimeManager = runtimeManager;
    this.dshVersion = dshVersion;
    this.allowedRoot = allowedRoot;
    this.capabilities = [...new Set(capabilities)];
    this.requestQueue = Promise.resolve();
    this.handshakes = new Map();
    this.gatewayAdapter = null;
  }

  static async create({ dataDir, store: suppliedStore = null, sessionControl, runtimeManager, dshVersion, allowedRoot, hostId, incarnationId } = {}) {
    const initial = createInitialHostState({ hostId, incarnationId, dshVersion });
    const store = suppliedStore ?? (dataDir ? await JsonStateStore.open({ dataDir, initialState: initial }) : new MemoryStateStore(initial));
    try {
      if (typeof sessionControl?.probe === 'function') await sessionControl.probe();
      await store.update((state) => {
        const interrupted = Object.values(state.operations).filter((operation) => operation.state === 'pending' || operation.state === 'running');
        if (interrupted.length > 0) {
          state.revision += 1;
          for (const operation of interrupted) {
            operation.state = 'needs-attention';
            operation.error = { code: 'HOST_RESTART_INTERRUPTED', message: 'host restarted before the operation reached a durable terminal state' };
            operation.revision = state.revision;
            operation.updatedAt = new Date().toISOString();
          }
        }
      });
      return new RemoteHostDaemon({ store, sessionControl, runtimeManager, dshVersion, allowedRoot });
    } catch (error) {
      await store.close?.();
      throw error;
    }
  }

  get hostState() {
    return this.store.snapshot();
  }

  async close() {
    await this.store.close?.();
  }

  async handle(message) {
    const run = this.requestQueue.then(() => this.#handle(message));
    this.requestQueue = run.catch(() => undefined);
    return run;
  }

  async #handle(message) {
    try {
      if (!message || typeof message.type !== 'string') throw new ProtocolError('request type is required');
      switch (message.type) {
        case CAPABILITIES.HOST_HELLO:
          return this.#hello(message);
        case 'project.open':
          return this.#openProject(message);
        case CAPABILITIES.OPERATION_GET:
          return this.#getOperation(message);
        case CAPABILITIES.OPERATION_LIST:
          return this.#listOperations(message);
        case CAPABILITIES.STATE_RECONCILE:
          return this.#reconcile(message);
        case CAPABILITIES.BOOTSTRAP_STATUS:
          return this.#bootstrapStatus(message);
        case CAPABILITIES.GATEWAY_BIND:
          return this.#bindGateway(message);
        case CAPABILITIES.GATEWAY_PROBE:
          return this.#probeGateway(message);
        case CAPABILITIES.RUNTIME_STATUS:
          return this.#runtimeStatus(message);
        case CAPABILITIES.RUNTIME_AUTH_CHALLENGE:
          return this.#runtimeAuthChallenge(message);
        default:
          throw new ProtocolError('unsupported request type', { type: message.type });
      }
    } catch (error) {
      return {
        type: 'error',
        requestType: message?.type ?? null,
        operationId: message?.operationId ?? null,
        error: errorToObject(error),
      };
    }
  }

  #hello(message) {
    if (message.hostId) validateHostHello(message);
    if (!message.sourceHostId || !message.sourceSessionId) throw new ProtocolError('client hello requires source identity');
    const negotiated = negotiateVersion({ client: message.protocol?.version ?? `${message.protocol?.major}.${message.protocol?.minor}`, host: `1.0` });
    const state = this.hostState;
    this.handshakes.set(this.#sourceKey(message), { sourceHostId: message.sourceHostId, sourceSessionId: message.sourceSessionId, hostId: state.host.hostId });
    return {
      type: 'host.hello.response',
      negotiated,
      host: createHostHello({
        hostId: state.host.hostId,
        incarnationId: state.host.incarnationId,
        dshVersion: state.host.dshVersion ?? this.dshVersion,
        capabilities: this.capabilities,
        gateway: state.gateway ? { endpoint: state.gateway.endpoint, expiresAt: state.gateway.expiresAt } : null,
      }),
      revision: state.revision,
    };
  }

  async #openProject(message) {
    validateOperationEnvelope(message);
    this.#assertHandshake(message);
    this.#assertTarget(message);
    this.#assertPermissionSnapshot(message);
    const body = validateProjectOpenBody(message.body);
    await this.#assertAllowedPath(body.absolutePath);
    const existing = this.#findExistingOperation(message);
    if (existing) return { type: 'operation.result', operation: existing };

    const created = await this.store.update((state) => {
      const operation = createOperationRecord(message, { state: 'running', revision: state.revision + 1 });
      state.revision += 1;
      operation.revision = state.revision;
      state.operations[operation.operationId] = operation;
      return operation;
    });

    const requiredRemote = remoteRequirements(body.desiredState).length;
    if (requiredRemote > 0 && body.pluginSync?.status !== 'completed') {
      const status = body.pluginSync?.status ?? 'needs-attention';
      const code = status === 'incompatible' ? 'PLUGIN_SYNC_INCOMPATIBLE'
        : status === 'partial' ? 'PLUGIN_SYNC_PARTIAL'
          : status === 'persistence-unknown' ? 'PLUGIN_SYNC_PERSISTENCE_UNKNOWN'
            : 'PLUGIN_SYNC_NEEDS_ATTENTION';
      return this.#finishOperation(created.operationId, 'needs-attention', { pluginSync: body.pluginSync, requiredRemote }, {
        code,
        message: 'remote project cannot open until every required plugin and Skill has a verified completed sync',
        details: { status, requiredRemote },
      });
    }
    const requiredRuntimes = runtimeRequirements(body.desiredState).length;
    if (requiredRuntimes > 0 && body.runtimeSync?.status !== 'completed') {
      const status = body.runtimeSync?.status ?? 'needs-attention';
      const code = status === 'incompatible' ? 'RUNTIME_SYNC_INCOMPATIBLE'
        : status === 'persistence-unknown' ? 'RUNTIME_SYNC_PERSISTENCE_UNKNOWN'
          : 'RUNTIME_SYNC_NEEDS_ATTENTION';
      return this.#finishOperation(created.operationId, 'needs-attention', { runtimeSync: body.runtimeSync, requiredRuntimes }, {
        code,
        message: 'remote project cannot open until every required runtime has a verified completed sync',
        details: { status, requiredRuntimes },
      });
    }

    const runtime = await this.runtimeManager.ensure(body.desiredState.runtimes, { runtimeSync: body.runtimeSync });
    if (!runtime.ok) {
      return this.#finishOperation(created.operationId, 'needs-attention', { runtimeSync: body.runtimeSync, runtimeStates: runtime.states }, {
        code: runtime.states.some((item) => item.state === 'auth-required') ? 'RUNTIME_AUTH_REQUIRED' : 'RUNTIME_REQUIREMENT_UNSATISFIED',
        message: 'external runtime is missing, incompatible, degraded, or requires authentication',
        details: runtime.states,
      });
    }

    try {
      const result = await this.sessionControl.openProject({ ...body, idempotencyKey: message.idempotencyKey }, {
        operationId: message.operationId,
        sourceHostId: message.sourceHostId,
        sourceSessionId: message.sourceSessionId,
        permissionSnapshot: message.permissionSnapshot,
      });
      if (!result?.workspaceId || !result?.sessionId) {
        throw new DshRemoteError('session-control returned no workspace/session identity', { code: 'SESSION_CONTROL_RESULT_INVALID' });
      }
      const project = {
        projectId: result.projectId ?? `project-${sha256(body.absolutePath).slice(0, 16)}`,
        operationId: message.operationId,
        sourceHostId: message.sourceHostId,
        sourceSessionId: message.sourceSessionId,
        targetHostId: message.targetHostId,
        absolutePath: body.absolutePath,
        workspaceId: result.workspaceId,
        sessionId: result.sessionId,
        permissionPreset: result.permissionPreset ?? body.desiredState.defaultPermission,
        modelRoute: body.desiredState.modelRoute,
        nativeAgent: true,
        runtimeStates: runtime.states,
        runtimeSync: body.runtimeSync ?? { status: 'completed', items: [], requiredRuntimeCount: 0 },
        pluginSync: body.pluginSync ?? { status: 'completed', items: [], requiredRemote: 0 },
        scheduleState: result.scheduleState ?? null,
        updatedAt: new Date().toISOString(),
      };
      await this.store.update((state) => {
        state.projects[project.projectId] = project;
        state.revision += 1;
        const operation = state.operations[message.operationId];
        operation.state = result.state === 'partial' ? 'partial' : 'completed';
        operation.result = project;
        operation.error = null;
        operation.revision = state.revision;
        operation.updatedAt = new Date().toISOString();
        return operation;
      });
      return { type: 'operation.result', operation: this.store.snapshot().operations[message.operationId] };
    } catch (error) {
      const state = ['TRANSPORT_ERROR', 'UNKNOWN_TERMINAL_STATE', 'SESSION_CONTROL_UNAVAILABLE', 'SESSION_CONTROL_FRAME_INVALID', 'TIMEOUT'].includes(error?.code) ? 'needs-attention' : 'failed';
      return this.#finishOperation(message.operationId, state, null, errorToObject(error));
    }
  }

  #findExistingOperation(message) {
    const state = this.hostState;
    const byId = state.operations[message.operationId];
    if (byId && !this.#operationMatchesSource(byId, message)) throw new DshRemoteError('operation is not owned by this source session', { code: 'OPERATION_NOT_FOUND' });
    const byKey = Object.values(state.operations).find((operation) => this.#operationMatchesSource(operation, message) && operation.idempotencyKey === message.idempotencyKey && operation.type === message.type);
    const existing = byId ?? byKey;
    if (!existing) return null;
    if (existing.bodySha256 !== message.bodySha256 || existing.type !== message.type) {
      throw new ProtocolError('idempotency key is already bound to a different request', { idempotencyKey: message.idempotencyKey });
    }
    return existing;
  }

  async #finishOperation(operationId, stateName, result, error) {
    const operation = await this.store.update((state) => {
      const current = state.operations[operationId];
      if (!current) throw new DshRemoteError('operation not found while finishing', { code: 'OPERATION_NOT_FOUND' });
      state.revision += 1;
      current.state = stateName;
      current.result = result;
      current.error = error;
      current.revision = state.revision;
      current.updatedAt = new Date().toISOString();
      return current;
    });
    return { type: 'operation.result', operation };
  }

  #getOperation(message) {
    this.#assertHandshake(message);
    this.#assertTarget(message);
    const operation = this.hostState.operations[message.operationId];
    if (!operation) throw new DshRemoteError('operation not found', { code: 'OPERATION_NOT_FOUND', details: { operationId: message.operationId } });
    if (!this.#operationMatchesSource(operation, message)) throw new DshRemoteError('operation is not owned by this source session', { code: 'OPERATION_NOT_FOUND' });
    return { type: 'operation.result', operation };
  }

  #listOperations(message) {
    this.#assertHandshake(message);
    this.#assertTarget(message);
    const state = this.hostState;
    const limit = Number(message.limit ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ProtocolError('operation list limit is invalid');
    const operations = Object.values(state.operations).filter((operation) => operation.sourceHostId === message.sourceHostId && operation.sourceSessionId === message.sourceSessionId).slice(-limit);
    return { type: 'operation.list.result', hostId: state.host.hostId, incarnationId: state.host.incarnationId, revision: state.revision, operations };
  }

  #reconcile(message) {
    this.#assertHandshake(message);
    this.#assertTarget(message);
    const state = this.hostState;
    if (message.hostId && message.hostId !== state.host.hostId) throw new NeedsAttentionError('host identity changed', { expected: message.hostId, actual: state.host.hostId });
    if (message.incarnationId && message.incarnationId !== state.host.incarnationId) {
      throw new NeedsAttentionError('host incarnation changed; refusing blind reconciliation', { expected: message.incarnationId, actual: state.host.incarnationId });
    }
    const knownRevision = Number(message.knownRevision ?? 0);
    if (knownRevision > state.revision) {
      return { type: 'state.reconcile.result', status: 'stale-local', hostId: state.host.hostId, incarnationId: state.host.incarnationId, revision: state.revision };
    }
    return {
      type: 'state.reconcile.result',
      status: 'confirmed',
      hostId: state.host.hostId,
      incarnationId: state.host.incarnationId,
      revision: state.revision,
      projects: Object.values(state.projects).filter((project) => project.sourceHostId === message.sourceHostId && project.sourceSessionId === message.sourceSessionId && project.targetHostId === message.targetHostId),
      operations: Object.values(state.operations).filter((operation) => !message.sourceHostId || (operation.sourceHostId === message.sourceHostId && operation.sourceSessionId === message.sourceSessionId)),
    };
  }

  #bootstrapStatus(message) {
    this.#assertHandshake(message);
    this.#assertTarget(message);
    const state = this.hostState;
    return {
      type: 'bootstrap.status.result',
      hostId: state.host.hostId,
      incarnationId: state.host.incarnationId,
      protocolVersion: '1.0',
      platform: 'linux',
      arch: 'x86_64',
      dshVersion: state.host.dshVersion ?? this.dshVersion,
      revision: state.revision,
      installed: true,
    };
  }

  async #bindGateway(message) {
    validateOperationEnvelope(message);
    this.#assertHandshake(message);
    this.#assertTarget(message);
    this.#assertPermissionSnapshot(message);
    const body = validateGatewayBinding(message.body);
    const existing = this.#findExistingOperation(message);
    if (existing) {
      if (existing.state === 'completed') this.gatewayAdapter = new RemoteGatewayModelAdapter({ endpoint: body.endpoint, token: body.token });
      return { type: 'operation.result', operation: existing };
    }
    await this.store.update((state) => {
      const operation = createOperationRecord(message, { state: 'running', revision: state.revision + 1 });
      state.gateway = {
        endpoint: body.endpoint,
        expiresAt: body.expiresAt,
        hostId: state.host.hostId,
        tokenSha256: sha256(body.token),
      };
      state.revision += 1;
      operation.revision = state.revision;
      state.operations[operation.operationId] = operation;
    });
    const result = await this.store.update((state) => {
      state.revision += 1;
      const operation = state.operations[message.operationId];
      operation.state = 'completed';
      operation.result = { endpoint: state.gateway.endpoint, expiresAt: state.gateway.expiresAt };
      operation.revision = state.revision;
      operation.updatedAt = new Date().toISOString();
      return operation;
    });
    this.gatewayAdapter = new RemoteGatewayModelAdapter({ endpoint: body.endpoint, token: body.token });
    return { type: 'operation.result', operation: result };
  }

  #probeGateway(message) {
    this.#assertHandshake(message);
    this.#assertTarget(message);
    const state = this.hostState;
    return { type: 'gateway.probe.result', configured: Boolean(state.gateway), inMemoryAuthorized: this.gatewayAdapter !== null, gateway: state.gateway ? { endpoint: state.gateway.endpoint, expiresAt: state.gateway.expiresAt } : null, revision: state.revision };
  }

  async #runtimeStatus(message) {
    this.#assertHandshake(message);
    this.#assertTarget(message);
    if (!Array.isArray(message.requirements)) throw new ProtocolError('runtime status requirements must be an array');
    const requirements = message.requirements.map(validateRuntimeRequirement);
    const result = await this.runtimeManager.inspect(requirements);
    return { type: 'runtime.status.result', hostId: this.hostState.host.hostId, incarnationId: this.hostState.host.incarnationId, revision: this.hostState.revision, states: result };
  }

  async #runtimeAuthChallenge(message) {
    this.#assertHandshake(message);
    this.#assertTarget(message);
    const requirement = validateRuntimeRequirement(message.requirement);
    const result = await this.runtimeManager.authChallenge(requirement, { output: typeof message.output === 'string' ? message.output : null });
    return { type: 'runtime.auth.challenge.result', hostId: this.hostState.host.hostId, incarnationId: this.hostState.host.incarnationId, revision: this.hostState.revision, result };
  }

  async nativeModelRequest({ model, prompt, ...options } = {}) {
    if (!this.gatewayAdapter) throw new DshRemoteError('native model request is waiting for the local Gateway binding', { code: 'WAITING_FOR_GATEWAY', retryable: true });
    return this.gatewayAdapter.generate({ model, prompt, ...options });
  }

  #assertTarget(message) {
    const state = this.hostState;
    if (!message.targetHostId || message.targetHostId !== state.host.hostId) throw new ProtocolError('control request must target this host', { targetHostId: message.targetHostId ?? null });
  }

  #assertPermissionSnapshot(message) {
    if (Date.parse(message.permissionSnapshot.expiresAt) <= Date.now()) throw new NeedsAttentionError('permission snapshot has expired; obtain a fresh authorization before retrying', { operationId: message.operationId });
  }

  async #assertAllowedPath(absolutePath) {
    await assertWithinAllowedRoot(absolutePath, this.allowedRoot);
  }

  #sourceKey(message) {
    return `${message.sourceHostId}\u0000${message.sourceSessionId}`;
  }

  #assertHandshake(message) {
    if (!message?.sourceHostId || !message?.sourceSessionId || !this.handshakes.has(this.#sourceKey(message))) throw new ProtocolError('handshake source is required before control/read requests');
  }

  #operationMatchesSource(operation, message) {
    return operation.sourceHostId === message.sourceHostId
      && operation.sourceSessionId === message.sourceSessionId
      && operation.targetHostId === message.targetHostId;
  }
}
