import { DshRemoteError } from './errors.mjs';

/**
 * Boundary to the official dsh-session-control implementation on the target
 * DSH Host. The remote repository owns transport only; it does not implement
 * Session JSONL, SQLite, permissions, approvals or Schedule storage.
 */
export class SessionControlPort {
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
