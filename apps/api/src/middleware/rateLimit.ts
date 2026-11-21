import type { MiddlewareHandler } from 'hono';
import { getConnInfo } from 'hono/bun';
import { ErrorCodes, fail } from '@panel/shared';

/**
 * Tiny in-memory sliding-window rate limiter (per client IP).
 *
 * The API proxies an external website, so unbounded request rates would also
 * hammer the source. Single-process, single-user defaults are generous;
 * tighten via parameters when exposing the API more broadly.
 *
 * Keying: by default the limiter uses the SOCKET's real peer address —
 * `X-Forwarded-For`/`X-Real-IP` are client-settable headers, so trusting
 * them on a direct connection would let any caller reset its own bucket
 * every request (and mint unlimited buckets for the map below). Set
 * `trustProxy: true` ONLY when a reverse proxy you control sits in front
 * of the API and overwrites those headers.
 *
 * The per-IP map is hard-capped: a flood of unique (fake) keys can no
 * longer grow it without bound between sweeps — expired buckets are
 * dropped first, then the oldest bucket, before a new key is accepted.
 */
export function rateLimit(options: { windowMs: number; max: number; trustProxy?: boolean }): MiddlewareHandler {
  /** Hard ceiling on tracked keys (memory-exhaustion guard). */
  const MAX_TRACKED_KEYS = 5_000;

  const hits = new Map<string, number[]>();
  let lastSweep = Date.now();

  const clientKey = (c: Parameters<MiddlewareHandler>[0]): string => {
    if (options.trustProxy) {
      const forwarded =
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
        c.req.header('x-real-ip');
      if (forwarded) return forwarded;
    }
    try {
      const remote = getConnInfo(c)?.remote?.address;
      if (remote) return remote;
    } catch {
      // No conn info (non-Bun runtime in tests) — fall through to 'local'.
    }
    return 'local';
  };

  /** Drop expired buckets, then the oldest key, until there is room. */
  const makeRoom = (now: number): void => {
    if (hits.size < MAX_TRACKED_KEYS) return;
    for (const [key, timestamps] of hits) {
      if (timestamps.every((t) => now - t >= options.windowMs)) hits.delete(key);
      if (hits.size < MAX_TRACKED_KEYS) return;
    }
    // All buckets are still live — evict the oldest key (insertion order).
    const oldest = hits.keys().next();
    if (!oldest.done) hits.delete(oldest.value);
  };

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

    const ip = clientKey(c);

    const timestamps = (hits.get(ip) ?? []).filter((t) => now - t < options.windowMs);
    if (timestamps.length >= options.max) {
      // Tell well-behaved clients how long to back off (the details page
      // auto-retry and image reloads honor this instead of hammering).
      c.header('Retry-After', String(Math.ceil(options.windowMs / 1000)));
      return c.json(fail(ErrorCodes.RATE_LIMITED, 'Too many requests. Please slow down.'), 429);
    }
    timestamps.push(now);
    makeRoom(now);
    hits.set(ip, timestamps);

    await next();
  };
}
