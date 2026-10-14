/**
 * Small in-memory TTL cache with size-bounded, insertion-ordered eviction.
 *
 * Used to shield the external source from repeated identical requests
 * (search / panel / chapters / pages). It is deliberately simple — one
 * process, single-user local app — and can be swapped for Redis later
 * without touching call sites.
 */

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
  /** Rough heap bytes of `value` (0 when unknown) — for the byte budget. */
  sizeBytes: number;
}

export class TtlCache<V> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private maxEntries: number;
  private maxBytes: number;
  private bytes = 0;

  constructor(maxEntries = 500, maxBytes = Number.POSITIVE_INFINITY) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  /**
   * Resize the budgets at runtime (e.g. performance mode widens them,
   * standard mode restores them). Shrinking evicts oldest-first down to
   * the new budget immediately; growing never moves entries.
   */
  resize(maxEntries: number, maxBytes: number): void {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.evict();
  }

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      this.bytes -= entry.sizeBytes;
      return undefined;
    }
    // Refresh insertion order for LRU-ish eviction.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number, sizeBytes = 0): void {
    if (ttlMs <= 0) return;
    const prev = this.store.get(key);
    if (prev) this.bytes -= prev.sizeBytes;
    this.store.delete(key);
    const size = Number.isFinite(sizeBytes) && sizeBytes > 0 ? Math.floor(sizeBytes) : 0;
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs, sizeBytes: size });
    this.bytes += size;
    this.evict();
  }

  delete(key: string): void {
    const prev = this.store.get(key);
    if (prev) this.bytes -= prev.sizeBytes;
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.bytes = 0;
  }

  private evict(): void {
    while (this.store.size > this.maxEntries || (this.bytes > this.maxBytes && this.store.size > 0)) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      const entry = this.store.get(oldest.value);
      this.store.delete(oldest.value);
      if (entry) this.bytes -= entry.sizeBytes;
      // A single entry larger than the whole budget still gets served once
      // (it just evicted everything else) — drop it too rather than pin it.
      if (this.store.size === 0) this.bytes = 0;
    }
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * Request deduplication: concurrent calls for the same key share one
 * in-flight promise, so a slow source is only hit once.
 */
export class InFlight<V> {
  private readonly pending = new Map<string, Promise<V>>();

  async dedupe(key: string, factory: () => Promise<V>): Promise<V> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = factory().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  clear(): void {
    this.pending.clear();
  }
}
