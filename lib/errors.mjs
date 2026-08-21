export class DshRemoteError extends Error {
  constructor(message, { code = 'DSH_REMOTE_ERROR', details, retryable = false } = {}) {
    super(message);
    this.name = 'DshRemoteError';
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

export class ProtocolError extends DshRemoteError {
  constructor(message, details) {
    super(message, { code: 'PROTOCOL_ERROR', details });
    this.name = 'ProtocolError';
  }
}

export class NeedsAttentionError extends DshRemoteError {
  constructor(message, details) {
    super(message, { code: 'NEEDS_ATTENTION', details });
    this.name = 'NeedsAttentionError';
  }
}

export class TransportError extends DshRemoteError {
  constructor(message, details) {
    super(message, { code: 'TRANSPORT_ERROR', details, retryable: true });
    this.name = 'TransportError';
  }
}

export function errorToObject(error) {
  if (error instanceof DshRemoteError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
      retryable: error.retryable,
    };
  }
  return { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) };
}

export function errorFromObject(value) {
  const error = new DshRemoteError(value?.message ?? 'remote operation failed', {
    code: value?.code ?? 'REMOTE_ERROR',
    details: value?.details,
    retryable: value?.retryable === true,
  });
  if (error.code === 'NEEDS_ATTENTION') error.name = 'NeedsAttentionError';
  return error;
}
