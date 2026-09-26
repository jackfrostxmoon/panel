/**
 * Process-wide runtime counters (T4-2).
 *
 * A tiny mutable singleton the health/detailed endpoint reads to report
 * things like the in-memory source-cache hit rate. Values only ever
 * increase monotonically; the endpoint derives ratios from them.
 */

export const runtimeStats = {
  /** Cached responses served from the in-memory TTL cache. */
  sourceCacheHits: 0,
  /** Loader calls that actually fetched (dedupe collapses concurrent ones). */
  sourceCacheMisses: 0,
  /** Total HTTP requests handled (incremented by the request logger). */
  requests: 0,
};

/** Rolling per-source outbound-request statistics (T4-2). */
export interface SourceStat {
  /** Outbound requests (each HTTP attempt counted once per logical call). */
  requests: number;
  /** Requests that ended in any error (non-2xx, timeout, network). */
  errors: number;
  /** Sum of wall-clock durations in ms (for averages). */
  totalMs: number;
  /** Duration of the most recent request in ms. */
  lastMs: number;
  /** Timestamp (Date.now) of the most recent request. */
  lastAt: number;
}

const sourceStats = new Map<string, SourceStat>();

/** Record one logical outbound source request (retries included in the duration). */
export function recordSourceRequest(sourceName: string, durationMs: number, ok: boolean): void {
  let stat = sourceStats.get(sourceName);
  if (!stat) {
    stat = { requests: 0, errors: 0, totalMs: 0, lastMs: 0, lastAt: 0 };
    sourceStats.set(sourceName, stat);
  }
  stat.requests += 1;
  if (!ok) stat.errors += 1;
  stat.totalMs += durationMs;
  stat.lastMs = durationMs;
  stat.lastAt = Date.now();
}

/** Snapshot of the per-source stats map (insertion order = first-seen order). */
export function sourceStatSnapshot(): Array<SourceStat & { name: string }> {
  return [...sourceStats.entries()].map(([name, stat]) => ({ name, ...stat }));
}

/**
 * Rolling per-source image-proxy statistics (source future-proofing
 * telemetry). Every proxied image (covers + chapter pages, all sources)
 * records here, so a CDN move or a dead image host shows up as a per-source
 * failure signal instead of a silent reader full of broken images.
 *
 * Only failure timestamps are kept (capped), inside a 30-minute rolling
 * window — attempts stay monotonic like the counters above.
 */
export interface ImageStatSnapshot {
  name: string;
  /** Proxied image requests since boot (cache hits included). */
  attempts: number;
  /** Failures inside the rolling window. */
  recentErrors: number;
  /** Allowlist rejections inside the window — the signature of a CDN move. */
  recentBlocked: number;
  /** Newest failure timestamp (Date.now), or null when the window is clean. */
  lastFailureAt: number | null;
}

const IMAGE_WINDOW_MS = 30 * 60_000;
const IMAGE_TS_CAP = 100;

interface ImageStatInner {
  attempts: number;
  errors: number[];
  blocked: number[];
}

const imageStats = new Map<string, ImageStatInner>();

function pushCapped(list: number[], at: number): void {
  list.push(at);
  if (list.length > IMAGE_TS_CAP) list.splice(0, list.length - IMAGE_TS_CAP);
}

/** Record one proxied-image outcome for a source. */
export function recordImageResult(sourceName: string, ok: boolean, blocked: boolean): void {
  let stat = imageStats.get(sourceName);
  if (!stat) {
    stat = { attempts: 0, errors: [], blocked: [] };
    imageStats.set(sourceName, stat);
  }
  stat.attempts += 1;
  if (!ok) {
    const at = Date.now();
    pushCapped(stat.errors, at);
    if (blocked) pushCapped(stat.blocked, at);
  }
}

/** Windowed snapshot of the per-source image stats (registry order agnostic). */
export function imageStatSnapshot(): ImageStatSnapshot[] {
  const cutoff = Date.now() - IMAGE_WINDOW_MS;
  return [...imageStats.entries()].map(([name, stat]) => {
    const errors = stat.errors.filter((at) => at >= cutoff);
    const blocked = stat.blocked.filter((at) => at >= cutoff);
    return {
      name,
      attempts: stat.attempts,
      recentErrors: errors.length,
      recentBlocked: blocked.length,
      lastFailureAt: errors.length > 0 ? Math.max(...errors) : null,
    };
  });
}

export function recordSourceCacheHit(): void {
  runtimeStats.sourceCacheHits += 1;
}

export function recordSourceCacheMiss(): void {
  runtimeStats.sourceCacheMisses += 1;
}

export function recordRequest(): void {
  runtimeStats.requests += 1;
}