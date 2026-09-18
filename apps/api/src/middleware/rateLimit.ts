import type { MiddlewareHandler } from 'hono';
import { ErrorCodes, fail } from '@panel/shared';

/**
 * Tiny in-memory sliding-window rate limiter (per client IP).
 *
 * The API proxies an external website, so unbounded request rates would also
 * hammer the source. Single-process, single-user defaults are generous;
 * tighten via parameters when exposing the API more broadly.
 */
export function rateLimit(options: { windowMs: number; max: number }): MiddlewareHandler {
  const hits = new Map<string, number[]>();
  let lastSweep = Date.now();

  return async (c, next) => {
    const now = Date.now();

    // Periodic sweep so the map does not grow unboundedly.
    if (now - lastSweep > options.windowMs * 2) {
      for (const [key, timestamps] of hits) {
        const fresh = timestamps.filter((t) => now - t < options.windowMs);
        if (fresh.length === 0) hits.delete(key);
        else hits.set(key, fresh);
      }
      lastSweep = now;
    }

    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('x-real-ip') ??
      'local';

    const timestamps = (hits.get(ip) ?? []).filter((t) => now - t < options.windowMs);
    if (timestamps.length >= options.max) {
      // Tell well-behaved clients how long to back off (the details page
      // auto-retry and image reloads honor this instead of hammering).
      c.header('Retry-After', String(Math.ceil(options.windowMs / 1000)));
      return c.json(fail(ErrorCodes.RATE_LIMITED, 'Too many requests. Please slow down.'), 429);
    }
    timestamps.push(now);
    hits.set(ip, timestamps);

    await next();
  };
}
