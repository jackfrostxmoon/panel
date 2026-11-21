import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { logger } from '../lib/logger.js';
import { recordRequest } from '../lib/stats.js';

/**
 * Compact request log: method, path, status, duration + a per-request id (T4-3).
 *
 * The id is returned to the client as `X-Request-Id` and echoed in the log
 * line, so a user-visible error can be correlated with its server-side log
 * entry. An incoming `X-Request-Id` (e.g. from a reverse proxy) is honoured.
 */
export const requestLogger: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  // An incoming X-Request-Id (e.g. from a reverse proxy) is honoured, but only
  // when it is a safe token: bounded length, no CR/LF or separator characters —
  // the value is echoed back as a response header and embedded in log lines.
  const incoming = c.req.header('x-request-id');
  const requestId =
    incoming && /^[A-Za-z0-9_.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  c.header('X-Request-Id', requestId);
  recordRequest();
  await next();
  logger.debug('request', {
    requestId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - start,
  });
};
