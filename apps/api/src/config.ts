import { z } from 'zod';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BackupExportScope, SourceConfig } from '@panel/shared';

/**
 * Centralised, validated environment configuration.
 * Every value has a safe local-development default; production deployments
 * override through real environment variables (see .env.example).
 */

const boolFromString = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  /**
   * Local SQLite file holding the embedded database (Bun's built-in
   * `bun:sqlite` — no server, no install).
   * Relative paths resolve against the repo root, so every entry point
   * (`bun run dev`, `bun run db:migrate`, …) uses the same file no
   * matter which working directory it was launched from. The parent
   * directory is created on first start; back it up or delete it like any file.
   */
  DATABASE_URL: z.string().default('data/panel.db'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * Override the LAN address reported by /api/health for shareable links.
   * Set this when auto-detection picks the wrong adapter (Docker/WSL/VPN
   * often expose virtual interfaces, e.g. 172.x or 192.168.x VMware NICs).
   * Must be an IPv4 address when provided.
   */
  SHARE_LAN_ADDRESS: z.ipv4().optional(),

  SOURCE_MANGAKATANA_BASE_URL: z.url().default('https://mangakatana.com'),
  SOURCE_MANGAKATANA_ENABLED: boolFromString(true),
  SOURCE_NIHONKUNI_BASE_URL: z.url().default('https://nihonkuni.com'),
  SOURCE_NIHONKUNI_ENABLED: boolFromString(true),
  SOURCE_RAWKUMA_BASE_URL: z.url().default('https://rawkuma.net'),
  SOURCE_RAWKUMA_ENABLED: boolFromString(true),
  SOURCE_RAWSAKURA_BASE_URL: z.url().default('https://rawsakura.org'),
  SOURCE_RAWSAKURA_ENABLED: boolFromString(true),
  SOURCE_HIPERDEX_BASE_URL: z.url().default('https://hiperdex.com'),
  SOURCE_HIPERDEX_ENABLED: boolFromString(true),
  SOURCE_MANGAREAD_BASE_URL: z.url().default('https://www.mangaread.org'),
  SOURCE_MANGAREAD_ENABLED: boolFromString(true),
  SOURCE_TOONILY_BASE_URL: z.url().default('https://toonily.com'),
  SOURCE_TOONILY_ENABLED: boolFromString(true),
  SOURCE_RAWDEX_BASE_URL: z.url().default('https://rawdex.net'),
  SOURCE_RAWDEX_ENABLED: boolFromString(true),
  SOURCE_KALISCAN_BASE_URL: z.url().default('https://kaliscan.io'),
  SOURCE_KALISCAN_ENABLED: boolFromString(true),
  SOURCE_RAWUWU_BASE_URL: z.url().default('https://rawuwu.net'),
  SOURCE_RAWUWU_ENABLED: boolFromString(true),
  SOURCE_ROLIASCAN_BASE_URL: z.url().default('https://roliascan.xyz'),
  SOURCE_ROLIASCAN_ENABLED: boolFromString(true),
  SOURCE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),

  /**
   * Automatic retries on a TRANSIENT failure (timeout, connection/DNS/TLS
   * error, HTTP 429 or 5xx) before surfacing an error to the client. Each
   * attempt gets a fresh timeoutMs budget, so worst-case latency is
   * `(retryCount + 1) * timeoutMs`.
   */
  SOURCE_REQUEST_RETRY_COUNT: z.coerce.number().int().min(0).default(2),
  /**
   * Base delay (ms) for the first retry; each subsequent attempt doubles it
   * (plus ±50% jitter). Defaults to SOURCE_REQUEST_RETRY_BASE_DELAY_MS.
   */
  SOURCE_REQUEST_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(500),

  CACHE_TTL_SEARCH_MS: z.coerce.number().int().min(0).default(120_000),
  CACHE_TTL_PANEL_MS: z.coerce.number().int().min(0).default(600_000),
  CACHE_TTL_CHAPTERS_MS: z.coerce.number().int().min(0).default(300_000),
  CACHE_TTL_PAGES_MS: z.coerce.number().int().min(0).default(1_800_000),

  /**
   * Bound on the in-memory source-response cache (PanelService TtlCache).
   * Each entry can hold a full listing or chapter page list, so an
   * unbounded-feeling 1000 entries pins hundreds of MB after a long browse.
   * A single-user journey touches dozens of keys — 200 keeps every revisit's
   * cache hot while capping the heap.
   */
  CACHE_MAX_ENTRIES: z.coerce.number().int().min(16).max(5000).default(200),

  /**
   * Bound on the in-memory source-response cache in bytes (PanelService
   * TtlCache). Entries are sized by JSON length; the oldest entries are
   * evicted past either this or CACHE_MAX_ENTRIES, so one huge chapter
   * payload can't pin the heap.
   */
  CACHE_MAX_BYTES: z.coerce.number().int().min(1024 * 1024).max(1024 * 1024 * 1024).default(64 * 1024 * 1024),

  // On-disk cache for proxied cover / chapter images. Sized relative to the
  // host's available disk at runtime (see ImageCache.computeCap): we
  // use at most IMAGE_CACHE_MAX_FRACTION of currently-available space, clamped
  // between IMAGE_CACHE_MIN_BYTES and IMAGE_CACHE_MAX_BYTES. Old entries are
  // evicted (oldest access time first) whenever the cap would be exceeded.
  //
  // Default lives in `data/.imagecache` next to the embedded database, so
  // cached images survive restarts and are backed up with the rest of `data/`.
  // A bare `bun run dev` with no .env falls back to the OS temp dir instead
  // so it never pollutes the working tree. Setting IMAGE_CACHE_DIR
  // explicitly still wins.
  IMAGE_CACHE_DIR: z.string().default('data/.imagecache'),
  IMAGE_CACHE_MAX_FRACTION: z.coerce.number().min(0.05).max(0.9).default(0.5),
  IMAGE_CACHE_MIN_BYTES: z.coerce.number().int().positive().default(256 * 1024 * 1024),
  IMAGE_CACHE_MAX_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024 * 1024),

  /**
   * Max concurrent UPSTREAM image fetches through the /api/source-image
   * proxy. Cover grids fire dozens of requests at once; each miss buffers a
   * whole image in heap, so unbounded concurrency is the transient 300MB+
   * spike. Disk hits bypass the limiter — revisits stay instant. Queued
   * requests wait FIFO; fewer parallel fetches also means fewer source
   * 429s/retries. Sized together with SOURCE_MAX_IMAGE_BYTES: 4 × 16 MiB
   * caps the worst-case transient heap at 64 MiB (down from 8 × 16 MiB).
   */
  IMAGE_PROXY_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),

  /**
   * Split response cap for outbound source traffic. Listings are KBs of
   * HTML — a rogue multi-MB page used to become a multi-MB JS string. Text
   * (HTML/JSON/sitemap) fails fast above this; images keep the full 16MB —
   * some sources serve multi-MB originals (13MB PNG covers and stitched
   * webtoon pages exist in the wild), and anything above the cap fails
   * every retry deterministically, surfacing as a permanent broken image.
   */
  SOURCE_MAX_TEXT_BYTES: z.coerce.number().int().positive().default(3 * 1024 * 1024),
  SOURCE_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(16 * 1024 * 1024),

  /**
   * Path to the COPY-block export used by `bun run db:import`. Relative paths
   * resolve against the repo root. The file is not committed, so set this in
   * your local `.env` (or pass it as the first CLI argument) to point at your
   * own export.
   */
  DUMP_PATH: z.string().default('panel_viewer_export.sql'),

  /**
   * Where the on-exit auto-backup is written (a folder, created on demand).
   * Relative paths resolve against the repo root. Defaults to `data/.backup`
   * next to the embedded database, so a single `data/` tree holds the live
   * SQLite file + every historical backup. Disabled entirely when empty.
   */
  BACKUP_DIR: z.string().default('data/.backup'),

  /**
   * Scope of the on-exit auto-backup: `full` dumps every table (including
   * the reader/search/prefetch caches, tens of MB), `minimal` dumps
   * bookmark data only. Picked at startup — `lan.bat` asks on every launch
   * (or takes `full`/`minimal` as its first argument).
   */
  BACKUP_SCOPE: z.enum(['full', 'minimal']).default('full'),

  /**
   * Interval (ms) between automatic database backups while the API is
   * running (`bun run dev`, `bun run lan`, prod). Each run writes a new
   * timestamped `.sql.gz` through the same path as the on-exit backup, so
   * an hour of bookmarks/progress is never lost to a crash or power cut
   * (the on-exit backup only fires on a clean shutdown). Failures are
   * logged, never fatal. `0` disables the periodic backup (the on-exit
   * backup still runs).
   */
  BACKUP_INTERVAL_MS: z.coerce.number().int().min(0).default(3_600_000),

});

export interface CacheConfig {
  readonly searchMs: number;
  readonly panelMs: number;
  readonly chaptersMs: number;
  readonly pagesMs: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
}

/**
 * On-disk cache for proxied cover / chapter images. The cap is computed at
 * runtime relative to the container's available disk (see ImageCache),
 * clamped between minBytes and maxBytes — so a small host disk can never
 * balloon, and a large one still uses most of the free space.
 */
export interface ImageCacheConfig {
  readonly dir: string;
  readonly maxFraction: number;
  readonly minBytes: number;
  readonly maxBytes: number;
  readonly maxUpstreamConcurrency: number;
}

export interface AppConfig {
  /**
   * Absolute path of the local SQLite database file (resolved from
   * DATABASE_URL — see `resolveDatabaseFile`). This is a file, not a
   * connection string: the database is embedded and needs no server.
   */
  readonly databaseUrl: string;
  readonly port: number;
  /**
   * Absolute path of the COPY-block export used by `bun run db:import`
   * (resolved from DUMP_PATH — see `resolveRepoDir`).
   */
  readonly dumpPath: string;
  /**
   * Absolute path of the auto-backup folder (resolved from BACKUP_DIR —
   * see `resolveRepoDir`). Empty string disables the on-exit backup.
   */
  readonly backupDir: string;
  /**
   * Scope of the on-exit auto-backup (from BACKUP_SCOPE): `full` dumps
   * every table including caches, `minimal` dumps bookmark data only.
   */
  readonly backupScope: BackupExportScope;
  /**
   * Interval (ms) between automatic database backups while the API is
   * running (from BACKUP_INTERVAL_MS, default 1h; `0` disables).
   */
  readonly backupIntervalMs: number;
  /**
   * CORS origin matcher passed to Hono's `cors` middleware.
   *
   * In development/test we allow every origin by default so `bun run dev` works
   * on any LAN device with zero config — the Vite server already listens on
   * 0.0.0.0 (`host: true`), and the API should match. Production restricts to
   * the explicit `CORS_ORIGIN` allowlist (set per-deployment, e.g. in
   * docker-compose).
   */
  readonly corsOrigin: (origin: string) => string | null;
  /** The raw, parsed allowlist (useful for logging / future tooling). */
  readonly corsOrigins: string[];
  /** Explicit LAN address for shareable links (SHARE_LAN_ADDRESS), or
      undefined to let /api/health auto-detect it. */
  readonly shareLanAddress: string | undefined;
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly sources: {
    readonly mangakatana: SourceConfig;
    readonly nihonkuni: SourceConfig;
    readonly rawkuma: SourceConfig;
    readonly rawsakura: SourceConfig;
    readonly hiperdex: SourceConfig;
    readonly mangaread: SourceConfig;
    readonly toonily: SourceConfig;
    readonly rawdex: SourceConfig;
    readonly kaliscan: SourceConfig;
    readonly rawuwu: SourceConfig;
    readonly roliascan: SourceConfig;
  };
  readonly cache: CacheConfig;
  readonly imageCache: ImageCacheConfig;
}

/**
 * Resolve a repo-relative data path (DATABASE_URL, IMAGE_CACHE_DIR) to an
 * absolute directory.
 *
 * Relative paths anchor at the repo root (derived from this module's
 * location: `apps/api/src/` → three levels up), so `bun run dev`
 * (cwd = repo root) and `bun run db:migrate` (cwd = `apps/api`) land on
 * the same folder.
 */
export function resolveRepoDir(input: string): string {
  if (isAbsolute(input)) return input;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', input);
}

/**
 * Resolve the DATABASE_URL value to an absolute local file path.
 *
 * A leftover `postgres://…` value from the PostgreSQL era is rejected with
 * a clear message instead of being misread as a relative path.
 */
export function resolveDatabaseFile(input: string): string {
  if (/^postgres(ql)?:\/\//i.test(input)) {
    throw new Error(
      'Invalid environment configuration:\n' +
        '  - DATABASE_URL: looks like a PostgreSQL connection string — this app now uses ' +
        'an embedded SQLite file. Set DATABASE_URL to a file path instead, e.g. "data/panel.db".',
    );
  }
  return resolveRepoDir(input);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Fail fast with a readable message — a misconfigured server should
    // never start silently with surprising defaults.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;

  const baseUrl = e.SOURCE_MANGAKATANA_BASE_URL.replace(/\/+$/, '');
  const nihonkuniBaseUrl = e.SOURCE_NIHONKUNI_BASE_URL.replace(/\/+$/, '');
  const rawkumaBaseUrl = e.SOURCE_RAWKUMA_BASE_URL.replace(/\/+$/, '');
  const rawsakuraBaseUrl = e.SOURCE_RAWSAKURA_BASE_URL.replace(/\/+$/, '');
  const hiperdexBaseUrl = e.SOURCE_HIPERDEX_BASE_URL.replace(/\/+$/, '');
  const mangareadBaseUrl = e.SOURCE_MANGAREAD_BASE_URL.replace(/\/+$/, '');
  const toonilyBaseUrl = e.SOURCE_TOONILY_BASE_URL.replace(/\/+$/, '');
  const rawdexBaseUrl = e.SOURCE_RAWDEX_BASE_URL.replace(/\/+$/, '');
  const kaliscanBaseUrl = e.SOURCE_KALISCAN_BASE_URL.replace(/\/+$/, '');
  const rawuwuBaseUrl = e.SOURCE_RAWUWU_BASE_URL.replace(/\/+$/, '');
  const roliascanBaseUrl = e.SOURCE_ROLIASCAN_BASE_URL.replace(/\/+$/, '');

  const isProduction = e.NODE_ENV === 'production';
  const isTest = e.NODE_ENV === 'test';
  const corsOrigins = e.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  return {
    databaseUrl: resolveDatabaseFile(e.DATABASE_URL),
    dumpPath: resolveRepoDir(e.DUMP_PATH),
    backupDir: resolveRepoDir(e.BACKUP_DIR),
    backupScope: e.BACKUP_SCOPE,
    backupIntervalMs: e.BACKUP_INTERVAL_MS,
    port: e.PORT,
    /**
     * In dev/test we allow every origin so `bun run dev` works on any LAN
     * device with zero config — the Vite server already listens on 0.0.0.0
     * (`host: true`), and the API should match. In production we restrict to
     * the explicit `CORS_ORIGIN` allowlist (per-deployment, e.g.
     * docker-compose). Hono's cors middleware treats a `null` return as
     * "origin not allowed" and an echoed string as "allowed".
     */
    corsOrigin:
      isProduction || isTest
        ? (origin: string): string | null => (corsOrigins.includes(origin) ? origin : null)
        : (origin: string): string => origin,
    corsOrigins,
    shareLanAddress: e.SHARE_LAN_ADDRESS,
    isProduction,
    isTest,
    sources: {
      mangakatana: {
        name: 'mk',
        label: 'MangaKatana',
        baseUrl,
        enabled: e.SOURCE_MANGAKATANA_ENABLED,
        requestTimeoutMs: e.SOURCE_REQUEST_TIMEOUT_MS,
        requestRetryCount: e.SOURCE_REQUEST_RETRY_COUNT,
        requestRetryBaseDelayMs: e.SOURCE_REQUEST_RETRY_BASE_DELAY_MS,
        maxTextBytes: e.SOURCE_MAX_TEXT_BYTES,
        maxImageBytes: e.SOURCE_MAX_IMAGE_BYTES,
      },
      nihonkuni: {
        name: 'nk',
        label: 'NihonKuni',
        baseUrl: nihonkuniBaseUrl,
        enabled: e.SOURCE_NIHONKUNI_ENABLED,
        requestTimeoutMs: e.SOURCE_REQUEST_TIMEOUT_MS,
        requestRetryCount: e.SOURCE_REQUEST_RETRY_COUNT,
        requestRetryBaseDelayMs: e.SOURCE_REQUEST_RETRY_BASE_DELAY_MS,
        maxTextBytes: e.SOURCE_MAX_TEXT_BYTES,
        maxImageBytes: e.SOURCE_MAX_IMAGE_BYTES,
      },
      rawkuma: {
        name: 'rk',
        label: 'Rawkuma',
        baseUrl: rawkumaBaseUrl,
        enabled: e.SOURCE_RAWKUMA_ENABLED,
        requestTimeoutMs: e.SOURCE_REQUEST_TIMEOUT_MS,
        requestRetryCount: e.SOURCE_REQUEST_RETRY_COUNT,
        requestRetryBaseDelayMs: e.SOURCE_REQUEST_RETRY_BASE_DELAY_MS,
        maxTextBytes: e.SOURCE_MAX_TEXT_BYTES,
        maxImageBytes: e.SOURCE_MAX_IMAGE_BYTES,
      },
      rawsakura: {
        name: 'rs',
        label: 'RawSakura',
        baseUrl: rawsakuraBaseUrl,
        enabled: e.SOURCE_RAWSAKURA_ENABLED,
        requestTimeoutMs: e.SOURCE_REQUEST_TIMEOUT_MS,
        requestRetryCount: e.SOURCE_REQUEST_RETRY_COUNT,
        requestRetryBaseDelayMs: e.SOURCE_REQUEST_RETRY_BASE_DELAY_MS,
        maxTextBytes: e.SOURCE_MAX_TEXT_BYTES,
        maxImageBytes: e.SOURCE_MAX_IMAGE_BYTES,
      },
      hiperdex: {
        name: 'hd',
        label: 'Hiperdex',
        baseUrl: hiperdexBaseUrl,
        enabled: e.SOURCE_HIPERDEX_ENABLED,
        requestTimeoutMs: e.SOURCE_REQUEST_TIMEOUT_MS,
        requestRetryCount: e.SOURCE_REQUEST_RETRY_COUNT,
        requestRetryBaseDelayMs: e.SOURCE_REQUEST_RETRY_BASE_DELAY_MS,
        maxTextBytes: e.SOURCE_MAX_TEXT_BYTES,
        maxImageBytes: e.SOURCE_MAX_IMAGE_BYTES,
      },
      mangaread: {
        name: 'mr',
        label: 'MangaRead',
        baseUrl: mangareadBaseUrl,
        enabled: e.SOURCE_MANGAREAD_ENABLED,
        requestTimeoutMs: e.SOURCE_REQUEST_TIMEOUT_MS,
        requestRetryCount: e.SOURCE_REQUEST_RETRY_COUNT,
        requestRetryBaseDelayMs: e.SOURCE_REQUEST_RETRY_BASE_DELAY_MS,
        maxTextBytes: e.SOURCE_MAX_TEXT_BYTES,
        maxImageBytes: e.SOURCE_MAX_IMAGE_BYTES,
      },
      toonily: {
        name: 'tn',
        label: 'Toonily',
        baseUrl: toonilyBaseUrl,
        enabled: e.SOURCE_TOONILY_ENABLED,
        requestTimeoutMs: e.SOURCE_REQUEST_TIMEOUT_MS,
        requestRetryCount: e.SOURCE_REQUEST_RETRY_COUNT,
        requestRetryBaseDelayMs: e.SOURCE_REQUEST_RETRY_BASE_DELAY_MS,
        maxTextBytes: e.SOURCE_MAX_TEXT_BYTES,
        maxImageBytes: e.SOURCE_MAX_IMAGE_BYTES,
      },
      rawdex: {
        name: 'rd',
        label: 'RawDex',
        baseUrl: rawdexBaseUrl,
        enabled: e.SOURCE_RAWDEX_ENABLED,
        requestTimeoutMs: e.SOURCE_REQUEST_TIMEOUT_MS,
        requestRetryCount: e.SOURCE_REQUEST_RETRY_COUNT,
        requestRetryBaseDelayMs: e.SOURCE_REQUEST_RETRY_BASE_DELAY_MS,
        maxTextBytes: e.SOURCE_MAX_TEXT_BYTES,
        maxImageBytes: e.SOURCE_MAX_IMAGE_BYTES,
      },
      kaliscan: {
        name: 'ks',
        label: 'KaliScan',
        baseUrl: kaliscanBaseUrl,
        enabled: e.SOURCE_KALISCAN_ENABLED,
        requestTimeoutMs: e.SOURCE_REQUEST_TIMEOUT_MS,
        requestRetryCount: e.SOURCE_REQUEST_RETRY_COUNT,
        requestRetryBaseDelayMs: e.SOURCE_REQUEST_RETRY_BASE_DELAY_MS,
        maxTextBytes: e.SOURCE_MAX_TEXT_BYTES,
        maxImageBytes: e.SOURCE_MAX_IMAGE_BYTES,
      },
      rawuwu: {
        name: 'ru',
        label: 'RawUwU',
        baseUrl: rawuwuBaseUrl,
        enabled: e.SOURCE_RAWUWU_ENABLED,
        requestTimeoutMs: e.SOURCE_REQUEST_TIMEOUT_MS,
        requestRetryCount: e.SOURCE_REQUEST_RETRY_COUNT,
        requestRetryBaseDelayMs: e.SOURCE_REQUEST_RETRY_BASE_DELAY_MS,
        maxTextBytes: e.SOURCE_MAX_TEXT_BYTES,
        maxImageBytes: e.SOURCE_MAX_IMAGE_BYTES,
      },
      roliascan: {
        name: 'rl',
        label: 'RoliaScan',
        baseUrl: roliascanBaseUrl,
        enabled: e.SOURCE_ROLIASCAN_ENABLED,
        requestTimeoutMs: e.SOURCE_REQUEST_TIMEOUT_MS,
        requestRetryCount: e.SOURCE_REQUEST_RETRY_COUNT,
        requestRetryBaseDelayMs: e.SOURCE_REQUEST_RETRY_BASE_DELAY_MS,
        maxTextBytes: e.SOURCE_MAX_TEXT_BYTES,
        maxImageBytes: e.SOURCE_MAX_IMAGE_BYTES,
      },
    },
    cache: {
      searchMs: e.CACHE_TTL_SEARCH_MS,
      panelMs: e.CACHE_TTL_PANEL_MS,
      chaptersMs: e.CACHE_TTL_CHAPTERS_MS,
      pagesMs: e.CACHE_TTL_PAGES_MS,
      maxEntries: e.CACHE_MAX_ENTRIES,
      maxBytes: e.CACHE_MAX_BYTES,
    },
    imageCache: {
      dir: resolveRepoDir(e.IMAGE_CACHE_DIR),
      maxFraction: e.IMAGE_CACHE_MAX_FRACTION,
      minBytes: e.IMAGE_CACHE_MIN_BYTES,
      maxBytes: e.IMAGE_CACHE_MAX_BYTES,
      maxUpstreamConcurrency: e.IMAGE_PROXY_CONCURRENCY,
    },
  };
}
