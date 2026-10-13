import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { networkInterfaces } from 'node:os';
import { createSocket } from 'node:dgram';
import { ErrorCodes, ok, type ApiErrorCode, type PanelSource } from '@panel/shared';
import type { Database } from '../db/client.js';
import type { ImageCache } from '../lib/imageCache.js';
import { getVersionInfo } from '../lib/version.js';
import {
  imageStatSnapshot,
  runtimeStats,
  sourceStatSnapshot,
} from '../lib/stats.js';
import { AppError } from '../lib/errors.js';
import type { SourceRegistry } from '../sources/registry.js';

interface SourceStatWithMeta {
  name: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
  requests: number;
  errors: number;
  avgLatencyMs: number | null;
  lastLatencyMs: number | null;
  lastRequestAt: string | null;
  /** Proxied images served since boot (cache hits included). */
  imageAttempts: number;
  /** Image failures inside the rolling window. */
  imageErrors: number;
  /** Allowlist rejections inside the window — the signature of a CDN move. */
  imageBlocked: number;
  /** Newest image failure, or null when the window is clean. */
  imageLastFailureAt: string | null;
}

/** One row of the live source benchmark (`POST /api/health/benchmark`). */
export interface SourceBenchmarkResult {
  name: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
  /** True when the live `latest(1)` probe returned. Disabled sources are `ok: false`. */
  ok: boolean;
  /** Wall-clock ms for the probe, or null when it never ran (disabled). */
  latencyMs: number | null;
  /** Items on the probed latest page, or null when the probe failed. */
  items: number | null;
  errorCode: ApiErrorCode | null;
  errorMessage: string | null;
  checkedAt: string;
}

/**
 * Upper bound for one source's live probe. Adapters already enforce their
 * own request timeout + retries; this race guard only caps the tail so one
 * hung source can't hold the whole benchmark open.
 */
const BENCHMARK_TIMEOUT_MS = 20_000;

function benchmarkTimeout(name: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      clearTimeout(timer);
      reject(
        new AppError(
          ErrorCodes.SOURCE_TIMEOUT,
          `The benchmark for "${name}" timed out after ${BENCHMARK_TIMEOUT_MS / 1000}s.`,
        ),
      );
    }, BENCHMARK_TIMEOUT_MS);
  });
}

/**
 * Live fault check for one source: a direct `latest(1)` on the adapter,
 * deliberately bypassing the PanelService TTL cache so a cached listing
 * can't mask a down source.
 */
async function benchmarkOne(source: PanelSource): Promise<SourceBenchmarkResult> {
  const checkedAt = new Date().toISOString();
  const base = {
    name: source.name,
    label: source.label,
    baseUrl: source.baseUrl,
    enabled: source.enabled,
    checkedAt,
  };
  if (!source.enabled) {
    return {
      ...base,
      ok: false,
      latencyMs: null,
      items: null,
      errorCode: ErrorCodes.SOURCE_DISABLED,
      errorMessage: 'Source is disabled.',
    };
  }
  const startedAt = Date.now();
  try {
    const result = await Promise.race([source.latest(1), benchmarkTimeout(source.name)]);
    return {
      ...base,
      ok: true,
      latencyMs: Date.now() - startedAt,
      items: result.results.length,
      errorCode: null,
      errorMessage: null,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error instanceof AppError) {
      return { ...base, ok: false, latencyMs, items: null, errorCode: error.code, errorMessage: error.message };
    }
    return {
      ...base,
      ok: false,
      latencyMs,
      items: null,
      errorCode: ErrorCodes.INTERNAL_ERROR,
      errorMessage: error instanceof Error ? error.message : 'Benchmark failed.',
    };
  }
}
/** The local IPv4 address the OS would actually use to reach the internet —
    i.e. the real LAN adapter (Wi-Fi/Ethernet), not virtual ones. Works by
    opening a UDP socket towards a public address (no packets are sent; UDP
    "connect" just picks the outgoing interface) and reading its local address. */
function lanAddressViaRoute(): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    const done = (address: string | null) => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve(address);
    };
    socket.on('error', () => done(null));
    // Nothing is sent for a UDP connect — this only resolves the route.
    socket.connect(53, '8.8.8.8', () => {
      const address = socket.address();
      done(address && address.family === 'IPv4' ? address.address : null);
    });
  });
}

/** Fallback when the routing trick fails: the best non-internal IPv4 address
    by range (192.168.x.x, then 10.x.x.x, then 172.16–31.x.x). */
function lanAddressFallback(): string | null {
  const rank = (address: string): number => {
    if (address.startsWith('192.168.')) return 0;
    if (address.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
    return 3;
  };
  let best: { address: string; rank: number } | null = null;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      const candidate = { address: address.address, rank: rank(address.address) };
      if (!best || candidate.rank < best.rank) best = candidate;
    }
  }
  return best?.address ?? null;
}

/** Resolve the machine's shareable LAN address (see helpers above). An
    explicit SHARE_LAN_ADDRESS override always wins — virtual adapters
    (Docker/WSL/VMware) can otherwise shadow the real one. */
async function lanAddress(override?: string): Promise<string | null> {
  if (override) return override;
  return (await lanAddressViaRoute()) ?? lanAddressFallback();
}

/** Liveness/readiness: reports source configuration and DB connectivity. */
export function healthRoutes(
  db: Database,
  registry: SourceRegistry,
  imageCache?: ImageCache,
  shareLanAddressOverride?: string,
): Hono {
  const app = new Hono();
  const startedAt = Date.now();

  // GET /api/health
  app.get('/health', async (c) => {
    let database: 'up' | 'down' = 'up';
    try {
      await db.run(sql`SELECT 1`);
    } catch {
      database = 'down';
    }

    return c.json(
      ok({
        status: database === 'up' ? 'ok' : 'degraded',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        database,
        version: getVersionInfo(),
        lanAddress: await lanAddress(shareLanAddressOverride),
        sources: registry.list().map((s) => ({
          name: s.name,
          label: s.label,
          baseUrl: s.baseUrl,
          enabled: s.enabled,
        })),
      }),
      database === 'up' ? 200 : 503,
    );
  });

  // GET /api/health/detailed (T4-2): cache hit-rate, per-source latency, DB pool.
  app.get('/health/detailed', async (c) => {
    const dbStartedAt = Date.now();
    let database: 'up' | 'down' = 'up';
    let dbLatencyMs: number | null = null;
    let poolActive: number | null = null;
    try {
      await db.run(sql`SELECT 1`);
      dbLatencyMs = Date.now() - dbStartedAt;
    } catch {
      database = 'down';
    }
    if (database === 'up') {
      // No connection pool on the embedded SQLite database (single local
      // file, one writer) — active-connection diagnostics don't apply.
      // Diagnostics only — never fail the endpoint on this.
      poolActive = null;
    }

    // In-memory source TTL cache hit rate.
    const { sourceCacheHits, sourceCacheMisses, requests } = runtimeStats;
    const cacheTotal = sourceCacheHits + sourceCacheMisses;

    // Merge registry config with rolling latency stats.
    const statsByName = new Map(sourceStatSnapshot().map((s) => [s.name, s]));
    const imageByName = new Map(imageStatSnapshot().map((s) => [s.name, s]));
    const sources: SourceStatWithMeta[] = registry.list().map((s) => {
      const stat = statsByName.get(s.name);
      const image = imageByName.get(s.name);
      return {
        name: s.name,
        label: s.label,
        baseUrl: s.baseUrl,
        enabled: s.enabled,
        requests: stat?.requests ?? 0,
        errors: stat?.errors ?? 0,
        avgLatencyMs: stat && stat.requests > 0 ? Math.round(stat.totalMs / stat.requests) : null,
        lastLatencyMs: stat?.lastMs ?? null,
        lastRequestAt: stat && stat.lastAt > 0 ? new Date(stat.lastAt).toISOString() : null,
        imageAttempts: image?.attempts ?? 0,
        imageErrors: image?.recentErrors ?? 0,
        imageBlocked: image?.recentBlocked ?? 0,
        imageLastFailureAt:
          image?.lastFailureAt != null ? new Date(image.lastFailureAt).toISOString() : null,
      };
    });

    const memory = process.memoryUsage();
    // Sized concurrently (same memo as the cache endpoint) so a health
    // probe pays one walk latency instead of two back-to-back.
    const imageCacheInfo = imageCache
      ? await Promise.all([imageCache.sizeInfo('cover'), imageCache.sizeInfo('chapter')]).then(
          ([cover, chapter]) => ({ cover, chapter }),
        )
      : null;

    return c.json(
      ok({
        status: database === 'up' ? 'ok' : 'degraded',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        database: {
          status: database,
          latencyMs: dbLatencyMs,
          pool: {
            // Server-backed drivers expose their pool size on $client; the
            // embedded database is single-process, so this is null by design.
            max: (db.$client as { options?: { max?: number } } | undefined)?.options?.max ?? null,
            active: poolActive,
          },
        },
        memory: {
          rssBytes: memory.rss,
          heapTotalBytes: memory.heapTotal,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external,
          arrayBuffersBytes: memory.arrayBuffers,
        },
        requests: { total: requests },
        sourceCache: {
          hits: sourceCacheHits,
          misses: sourceCacheMisses,
          hitRate: cacheTotal > 0 ? Math.round((sourceCacheHits / cacheTotal) * 1000) / 1000 : null,
        },
        sources,
        imageCache: imageCacheInfo,
      }),
      database === 'up' ? 200 : 503,
    );
  });

  // POST /api/health/benchmark?source=mk — live fault check across sources.
  // Probes each enabled source with a direct `latest(1)` on the adapter
  // (bypassing the PanelService TTL cache so a warm listing can't mask a
  // down source) and reports per-source latency / item count / error.
  // `?source=` restricts the run to one source (per-row retry); unknown
  // codes are a client error. Manual trigger only — never polled.
  app.post('/health/benchmark', async (c) => {
    const raw = c.req.query('source')?.trim() ?? '';
    let targets = registry.list();
    if (raw) {
      const known = new Set(targets.map((s) => s.name));
      if (!known.has(raw)) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          `Unknown source: ${raw}. Known sources: ${[...known].join(', ')}.`,
          { sources: [raw] },
        );
      }
      targets = targets.filter((s) => s.name === raw);
    }
    const results = await Promise.all(targets.map((s) => benchmarkOne(s)));
    return c.json(ok({ checkedAt: new Date().toISOString(), results }));
  });

  return app;
}
