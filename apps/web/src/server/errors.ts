import { isDomainError, type DomainErrorCode } from '@claude-team/domain';
import type { ApiErrorBody } from '@claude-team/protocol';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * The single place where a failure becomes an HTTP response.
 *
 * Handlers never catch: they call the core, and whatever the core throws is
 * translated here from its stable `DomainError.code` into a status. No handler
 * decides what "not found" means (ADR-001).
 */

const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  not_found: 404,
  validation: 400,
  conflict: 409,
  illegal_state: 409,
  permission_denied: 403,
  budget_exceeded: 429,
  agent_failed: 500,
  task_failed: 500,
  provider_error: 500,
  tool_error: 500,
  timeout: 504,
  cycle_detected: 409,
  hop_limit_exceeded: 409,
  cancelled: 499,
};

interface ZodIssueLike {
  message: string;
  path?: Array<string | number>;
}

interface ZodErrorLike {
  name: string;
  issues: ZodIssueLike[];
}

/** Structural check — the web app does not depend on zod itself. */
function isZodError(err: unknown): err is ZodErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'ZodError' &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

export function toApiError(err: unknown): { status: number; body: ApiErrorBody } {
  if (isZodError(err)) {
    const first = err.issues[0];
    const path = first?.path?.length ? first.path.join('.') : undefined;
    return {
      status: 400,
      body: {
        error: {
          code: 'validation',
          message: path ? `${path}: ${first?.message}` : (first?.message ?? 'Invalid request body'),
          details: { issues: err.issues },
        },
      },
    };
  }

  if (isDomainError(err)) {
    return {
      status: STATUS_BY_CODE[err.code] ?? 500,
      body: { error: { code: err.code, message: err.message, details: err.details } },
    };
  }

  if (err instanceof SyntaxError) {
    return { status: 400, body: { error: { code: 'validation', message: 'Malformed JSON body' } } };
  }

  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: { code: 'internal_error', message } } };
}

export function respondWithError(c: Context, err: unknown): Response {
  const { status, body } = toApiError(err);
  return c.json(body, status as ContentfulStatusCode);
}
