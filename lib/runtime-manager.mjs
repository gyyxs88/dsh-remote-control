import { DshRemoteError } from './errors.mjs';

export const RUNTIME_STATES = Object.freeze([
  'not-required',
  'missing',
  'installing',
  'auth-required',
  'ready',
  'update-required',
  'incompatible',
  'degraded',
]);

export class RuntimeManagerPort {
  async inspect(_requirements) {
    throw new DshRemoteError('RuntimeManagerPort.inspect is not implemented', { code: 'RUNTIME_PORT_NOT_IMPLEMENTED' });
  }

  async ensure(_requirements) {
    throw new DshRemoteError('RuntimeManagerPort.ensure is not implemented', { code: 'RUNTIME_PORT_NOT_IMPLEMENTED' });
  }
}

/**
 * Stage A deliberately has no third-party runtime installer. It reports the
 * explicit state instead of guessing from PATH or pretending authentication.
 */
export class StageARuntimeManager extends RuntimeManagerPort {
  async inspect(requirements = []) {
    if (!Array.isArray(requirements)) throw new DshRemoteError('runtime requirements must be an array', { code: 'RUNTIME_REQUIREMENTS_INVALID' });
    return requirements.map((requirement) => ({
      id: requirement.id,
      version: requirement.version,
      state: 'missing',
      reason: 'stage-a-runtime-installers-not-implemented',
      executable: null,
    }));
  }

  async ensure(requirements = []) {
    const inspected = await this.inspect(requirements);
    return {
      ok: inspected.length === 0,
      states: inspected,
      requiresAttention: inspected.length > 0,
    };
  }
}

export function assertRuntimeState(value) {
  if (!RUNTIME_STATES.includes(value)) throw new DshRemoteError(`invalid runtime state: ${value}`, { code: 'RUNTIME_STATE_INVALID' });
}
