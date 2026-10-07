import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ErrorCodes, fail } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

function isDatabaseError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  // The embedded SQLite driver surfaces SQLITE_* codes (e.g.
  // SQLITE_CONSTRAINT_UNIQUE) on its error objects; the legacy PostgreSQL
  // SQLSTATE shape (5-char, e.g. 23505) is still matched for old backups.
  if (/^[0-9A-Z]{5}$/.test(code)) return true;
  if (code.startsWith('SQLITE_')) return true;
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

  // The reader closed (or hopped chapters) mid-fetch: the image proxy
  // aborts the abandoned upstream fetch with the connection's signal.
  // The client is already gone, so there is nobody to answer — stay
  // quiet instead of logging an "unhandled" 500 for an intentional abort.
  if (err instanceof DOMException && err.name === 'AbortError') {
    logger.debug('Request aborted by client disconnect');
    return new Response(null, { status: 499 });
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
