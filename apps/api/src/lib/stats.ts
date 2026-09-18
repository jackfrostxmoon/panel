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

export function recordSourceCacheHit(): void {
  runtimeStats.sourceCacheHits += 1;
}

export function recordSourceCacheMiss(): void {
  runtimeStats.sourceCacheMisses += 1;
}

export function recordRequest(): void {
  runtimeStats.requests += 1;
}