import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ErrorCodes, fail } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

function isDatabaseError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  // PGlite surfaces real PostgreSQL SQLSTATE codes (e.g. 23505 unique
  // violation, 57P01 admin shutdown) on its error objects.
  if (/^[0-9A-Z]{5}$/.test(code)) return true;
  // Embedded DB has no sockets, but keep the connection-level codes as a
  // safety net for any future client-level failure surfacing as plain Error.
  return /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND)$/.test(code);
}

/**
 * Central error mapping.
 *
 *  - AppError          → its code/status (safe, human-readable message)
 *  - database error    → 500 DATABASE_ERROR (details stay in the server log)
 *  - HTTPException     → Hono's own errors (e.g. malformed JSON bodies)
 *  - anything else     → 500 INTERNAL_ERROR, stack goes to the server log
 *
 * Clients NEVER receive stack traces or driver messages.
 */
export const errorHandler: ErrorHandler = (err, c) => {
  // Correlate with the request log — X-Request-Id is set by the requestLogger
  // middleware before the route handler ran.
  const requestId =
    c.res?.headers.get('x-request-id') ?? c.req.header('x-request-id') ?? undefined;
  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error('Application error', {
        requestId,
        code: err.code,
        message: err.message,
        details: err.details,
      });
    }
    return c.json(fail(err.code, err.message, err.details), err.status as 400);
  }

  if (isDatabaseError(err)) {
    logger.error('Database error', {
      requestId,
      code: (err as { code?: string }).code,
      message: err.message,
    });
    return c.json(
      fail(ErrorCodes.DATABASE_ERROR, 'A database error occurred. Please try again.'),
      500,
    );
  }

  if (err instanceof HTTPException) {
    const status = err.status;
    const code =
      status === 404
        ? ErrorCodes.NOT_FOUND
        : status === 400
          ? ErrorCodes.VALIDATION_ERROR
          : ErrorCodes.INTERNAL_ERROR;
    return c.json(fail(code, err.message || 'Request failed.'), status);
  }

  logger.error('Unhandled error', {
    requestId,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return c.json(fail(ErrorCodes.INTERNAL_ERROR, 'An unexpected error occurred.'), 500);
};

export const notFoundHandler: NotFoundHandler = (c) => {
  return c.json(fail(ErrorCodes.NOT_FOUND, 'The requested resource could not be found.'), 404);
};
