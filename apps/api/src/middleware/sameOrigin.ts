import type { MiddlewareHandler } from 'hono';
import { ErrorCodes, fail } from '@panel/shared';

/**
 * Cross-site write guard (CSRF backstop, independent of CORS).
 *
 * Browsers attach an `Origin` header to every cross-origin (and most
 * same-origin) mutating request — a malicious page cannot suppress or forge
 * it. Non-browser clients (curl, scripts, server-to-server) send no Origin
 * at all, so they pass. The check therefore blocks exactly the browser
 * drive-by scenario without touching programmatic callers:
 *
 *   - Origin/Referer whose HOSTNAME differs from the request's own Host → 403.
 *     Hostname-only comparison (port-insensitive) so the Vite dev proxy
 *     (Origin :5173 → API :3001) keeps working.
 *   - No Origin/Referer → allowed (non-browser client).
 *   - Safe methods (GET/HEAD/OPTIONS) are never blocked — they carry no
 *     state changes and can't be used to mutate anything.
 *
 * This complements, not replaces, the CORS policy: CORS stops a foreign
 * site from READING responses; this stops it from WRITING even when CORS
 * would be misconfigured.
 */
export function sameOriginGuard(): MiddlewareHandler {
  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();

    let requestHost: string;
    try {
      requestHost = new URL(c.req.url).hostname.toLowerCase();
    } catch {
      return next(); // No usable URL — nothing to compare against.
    }

    for (const header of ['origin', 'referer'] as const) {
      const value = c.req.header(header);
      if (!value) continue; // Absent (non-browser client) — allowed.
      if (value === 'null') {
        // Sandboxed/privacy contexts that send a literal `null` origin.
        return c.json(
          fail(ErrorCodes.VALIDATION_ERROR, 'Cross-site request rejected (null origin).'),
          403,
        );
      }
      try {
        const originHost = new URL(value).hostname.toLowerCase();
        if (originHost !== requestHost) {
          return c.json(
            fail(ErrorCodes.VALIDATION_ERROR, 'Cross-site request rejected.'),
            403,
          );
        }
      } catch {
        // Unparseable header value — reject rather than guess.
        return c.json(fail(ErrorCodes.VALIDATION_ERROR, 'Cross-site request rejected.'), 403);
      }
    }

    await next();
  };
}
