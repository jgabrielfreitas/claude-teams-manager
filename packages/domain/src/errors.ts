/**
 * Domain-level error taxonomy. Every failure that the UIs need to distinguish
 * has a stable `code`, so neither the TUI nor the Web layer has to string-match
 * error messages.
 */
export type DomainErrorCode =
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'illegal_state'
  | 'agent_failed'
  | 'task_failed'
  | 'provider_error'
  | 'tool_error'
  | 'timeout'
  | 'budget_exceeded'
  | 'permission_denied'
  | 'cycle_detected'
  | 'hop_limit_exceeded'
  | 'cancelled';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export const notFound = (what: string, id: string) =>
  new DomainError('not_found', `${what} not found: ${id}`, { id });

export const invalid = (message: string, details?: Record<string, unknown>) =>
  new DomainError('validation', message, details);

export const conflict = (message: string, details?: Record<string, unknown>) =>
  new DomainError('conflict', message, details);

export const illegalState = (message: string, details?: Record<string, unknown>) =>
  new DomainError('illegal_state', message, details);

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}

/** Normalises anything thrown into a DomainError so transports can serialise it. */
export function toDomainError(err: unknown, fallback: DomainErrorCode = 'provider_error'): DomainError {
  if (isDomainError(err)) return err;
  if (err instanceof Error) {
    const e = new DomainError(fallback, err.message, { stack: err.stack });
    return e;
  }
  return new DomainError(fallback, String(err));
}
