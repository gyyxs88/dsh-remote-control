import { connect } from 'node:net';
import { DshRemoteError, TimeoutError } from './errors.mjs';

const MAX_PORT_FRAME_BYTES = 128 * 1024;

/**
 * Boundary to the official dsh-session-control implementation on the target
 * DSH Host. The remote repository owns transport only; it does not implement
 * Session JSONL, SQLite, permissions, approvals or Schedule storage.
 */
export class SessionControlPort {
  constructor() {
    this.ready = false;
  }

  async openProject(_request, _context) {
    throw new DshRemoteError('SessionControlPort.openProject is not implemented', { code: 'SESSION_CONTROL_PORT_NOT_IMPLEMENTED' });
  }
}

export class DshSessionControlPort extends SessionControlPort {
  constructor(service) {
    super();
    if (!service || typeof service.openProject !== 'function') {
      throw new DshRemoteError('DshSessionControlPort requires an official openProject service', { code: 'SESSION_CONTROL_SERVICE_INVALID' });
    }
    this.service = service;
    this.ready = true;
  }

  async openProject(request, context) {
    const result = await this.service.openProject({
      absolutePath: request.absolutePath,
      idempotencyKey: request.idempotencyKey,
      desiredState: request.desiredState,
      displayName: request.displayName,
      permissionPreset: request.desiredState.defaultPermission,
      schedule: request.schedule ?? null,
    }, context);
    if (!result || !result.workspaceId || !result.sessionId) {
      throw new DshRemoteError('official session-control service returned incomplete project result', { code: 'SESSION_CONTROL_RESULT_INVALID' });
    }
    return {
      projectId: result.projectId ?? `project-${result.workspaceId}`,
      workspaceId: result.workspaceId,
      sessionId: result.sessionId,
      workspacePath: result.workspacePath ?? request.absolutePath,
      state: result.state ?? 'completed',
      permissionPreset: result.permissionPreset ?? request.desiredState.defaultPermission,
      scheduleState: result.scheduleState ?? null,
    };
  }
}

/** Test-only port used by protocol integration tests; it is not a DSH store. */
export class FakeSessionControlPort extends SessionControlPort {
  constructor({ hostId = 'fake-host' } = {}) {
    super();
    this.hostId = hostId;
    this.projects = new Map();
    this.calls = [];
    this.ready = true;
  }

  async openProject(request, context) {
    this.calls.push({ request: structuredClone(request), context: structuredClone(context) });
    const key = request.idempotencyKey ?? request.absolutePath;
    const previous = this.projects.get(key);
    if (previous) return structuredClone(previous);
    const result = {
      projectId: `project-${this.projects.size + 1}`,
      workspaceId: `workspace-${this.projects.size + 1}`,
      sessionId: `session-${this.projects.size + 1}`,
      workspacePath: request.absolutePath,
      state: 'completed',
      permissionPreset: request.desiredState.defaultPermission,
      scheduleState: request.schedule ?? null,
    };
    this.projects.set(key, result);
    return structuredClone(result);
  }
}

/** Production bridge to the dsh-session-control Unix-domain socket. */
export class UnixSocketSessionControlPort extends SessionControlPort {
  constructor({ socketPath, hostId, timeoutMs = 10_000 } = {}) {
    super();
    if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || socketPath.includes('..')) throw new DshRemoteError('session-control socket path must be an absolute safe POSIX path', { code: 'SESSION_CONTROL_SOCKET_INVALID' });
    if (!hostId) throw new DshRemoteError('session-control hostId is required', { code: 'SESSION_CONTROL_HOST_REQUIRED' });
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new DshRemoteError('session-control socket timeout is invalid', { code: 'SESSION_CONTROL_TIMEOUT_INVALID' });
    this.socketPath = socketPath;
    this.hostId = hostId;
    this.timeoutMs = timeoutMs;
    this.ready = true;
    this.queue = Promise.resolve();
  }

  async probe() {
    const response = await this.#request({ type: 'remote-project.ping', hostId: this.hostId });
    if (response.type !== 'remote-project.pong' || response.hostId !== this.hostId) throw new DshRemoteError('session-control bridge returned an invalid probe', { code: 'SESSION_CONTROL_PROBE_INVALID' });
    return response;
  }

  async openProject(request, context) {
    const response = await this.#request({
      type: 'remote-project.open',
      hostId: this.hostId,
      sourceHostId: context.sourceHostId,
      sourceSessionId: context.sourceSessionId,
      operationId: context.operationId,
      request: {
        absolutePath: request.absolutePath,
        idempotencyKey: request.idempotencyKey,
        desiredState: request.desiredState,
        displayName: request.displayName,
        schedule: request.schedule ?? null,
      },
    });
    if (response.type === 'error') throw new DshRemoteError(response.error?.message ?? 'session-control bridge rejected request', { code: response.error?.code ?? 'SESSION_CONTROL_REMOTE_ERROR', details: response.error?.details });
    if (response.type !== 'remote-project.result') throw new DshRemoteError('session-control bridge returned an invalid project response', { code: 'SESSION_CONTROL_RESPONSE_INVALID' });
    return response.result;
  }

  #request(message) {
    const run = this.queue.then(() => new Promise((resolve, reject) => {
      const socket = connect(this.socketPath);
      let buffer = '';
      let settled = false;
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error); else resolve(response);
      };
      const timer = setTimeout(() => finish(new TimeoutError('session-control socket request timed out', { type: message.type })), this.timeoutMs);
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, 'utf8') > MAX_PORT_FRAME_BYTES) {
          clearTimeout(timer);
          finish(new DshRemoteError('session-control response exceeded frame limit', { code: 'SESSION_CONTROL_FRAME_TOO_LARGE' }));
          return;
        }
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        const line = buffer.slice(0, index);
        clearTimeout(timer);
        try { finish(null, JSON.parse(line)); } catch (error) { finish(new DshRemoteError('session-control response is invalid JSON', { code: 'SESSION_CONTROL_FRAME_INVALID', details: { message: error.message } })); }
      });
      socket.on('error', (error) => { clearTimeout(timer); finish(new DshRemoteError('session-control socket is unavailable', { code: 'SESSION_CONTROL_UNAVAILABLE', details: { message: error.message }, retryable: true })); });
      socket.on('close', () => {
        clearTimeout(timer);
        if (!settled) finish(new DshRemoteError('session-control socket closed before a response', { code: 'SESSION_CONTROL_UNAVAILABLE', retryable: true }));
      });
    }));
    this.queue = run.catch(() => undefined);
    return run;
  }
}
