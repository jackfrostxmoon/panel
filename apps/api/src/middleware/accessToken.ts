import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { getConnInfo } from 'hono/bun';
import { ErrorCodes, fail } from '@panel/shared';

/**
 * Access-token gate for non-localhost callers (see `ACCESS_TOKEN` in
 * config.ts). When a token is configured:
 *
 *   - requests from a loopback peer (the host PC itself) pass freely;
 *   - every other caller must present the token, via the `X-Panel-Token`
 *     header (fetches) or the `?token=` query parameter (browser `<img>`
 *     tags cannot set custom headers, so the image proxy URLs carry it).
 *
 * Unset token = the gate is off and the server should bind loopback
 * (see `BIND_ALL` in index.ts) — this middleware simply passes through.
 *
 * Comparison is length-checked + constant-time so the check itself can't
 * be used as a timing oracle for the token.
 */
export function accessTokenGate(token: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    if (!token) return next();

    if (isLoopbackPeer(c)) return next();

    const headerToken = c.req.header('x-panel-token');
    // Check every `token` query value — persisted payloads can carry a
    // stale pairing, and the first-match semantics of `query()` would
    // otherwise hide a valid later value.
    const queryTokens = c.req.queries('token') ?? [];
    if (matchesAny(headerToken, queryTokens, token)) return next();

    return c.json(
      fail(ErrorCodes.VALIDATION_ERROR, 'Unauthorized — a valid access token is required.'),
      403,
    );
  };
}

/** True when the TCP peer is this machine (loopback address on IPv4/IPv6). */
function isLoopbackPeer(c: Parameters<MiddlewareHandler>[0]): boolean {
  try {
    const address = getConnInfo(c)?.remote?.address;
    if (!address) return false;
    const normalized = address.replace(/^::ffff:/, '');
    return normalized === '127.0.0.1' || normalized === '::1';
  } catch {
    // No conn info available — treat as remote (fail closed when a token is set).
    return false;
  }
}

function matchesAny(headerToken: string | undefined, queryTokens: string[], expected: string): boolean {
  const candidates = [headerToken, ...queryTokens].filter((v): v is string => typeof v === 'string');
  const expectedBuf = Buffer.from(expected, 'utf8');
  return candidates.some((candidate) => {
    const a = Buffer.from(candidate, 'utf8');
    if (a.length !== expectedBuf.length) return false;
    return timingSafeEqual(a, expectedBuf);
  });
}
