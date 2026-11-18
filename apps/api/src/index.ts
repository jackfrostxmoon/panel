import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from 'hono/bun';
import { sql } from 'drizzle-orm';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createDb } from './db/client.js';
import { writeBackup } from './db/backup.js';
import { acquireInstanceLock } from './lib/instanceLock.js';
import { logger } from './lib/logger.js';
import { migrateImageCacheToFolders } from './lib/imageCacheFolders.js';
import { loadCacheSettings } from './lib/cacheSettingsFile.js';
import { applyPerformanceProfile } from './routes/cache-settings.js';
import { createSourceRegistry } from './sources/registry.js';
import { PanelCacheRepository } from './repositories/panelCacheRepository.js';

/**
 * API entry point.
 *
 * Serves the REST API on PORT. When a built frontend exists
 * (apps/web/dist — e.g. inside the all-in-one Docker image), it is served
 * as static files with an SPA fallback, so one container can serve both.
 *
 * The database is embedded (SQLite via Bun's built-in `bun:sqlite`): it lives in
 * a single local file (DATABASE_URL, e.g. `data/panel.db`), created on first
 * start. No server, no Docker. If the file can't be opened the
 * process exits with a helpful message instead of hanging.
 */

const config = loadConfig();

// Single-instance guard: refuse to boot while another API process holds
// the embedded database (SQLite allows concurrent readers, but a second
// writer risks SQLITE_BUSY churn and torn backups instead of a clean
// refusal). Exits here when taken; stale locks (dead owner) are adopted
// automatically.
const releaseInstanceLock = await acquireInstanceLock(config.databaseUrl, config.port);

// Fail fast when the local database can't be opened (locked by another
// process, missing permissions, or a corrupted file — e.g. an
// unclean shutdown that tore the WAL). Without this guard an open
// failure surfaces as a bare driver error and `bun --hot` just crash-loops
// with the API port never listening.
let db: Awaited<ReturnType<typeof createDb>>;
try {
  db = await createDb(config.databaseUrl);
} catch (error) {
  logger.error('Local database could not be opened', {
    error: error instanceof Error ? error.message : String(error),
    databaseFile: config.databaseUrl,
  });
  logger.error(
    'If another API process is running, stop it first (the embedded database allows a single writer). ' +
      'If the file is corrupted, back it up, delete it, then run `bun run db:migrate` + `bun run db:import`.',
  );
  process.exit(1);
}
try {
  await db.run(sql`select 1`);
} catch (error) {
  logger.error('Local database could not be opened', {
    error: error instanceof Error ? error.message : String(error),
    databaseFile: config.databaseUrl,
  });
  logger.error(
    'Check that DATABASE_URL points at a writable file (default "data/panel.db"), e.g. `bun run db:migrate`',
  );
  process.exit(1);
}
const panelCacheForSources = new PanelCacheRepository(db);
const registry = createSourceRegistry(config, {
  // Bulk genre lookup for listing enrichment: previously-seen panels skip
  // their detail fetch (repositories are stateless, so sharing one more
  // instance over the same db is safe).
  findGenres: (ids) => panelCacheForSources.findGenresByGlobalIds(ids),
});
const { app, prefetchWorker, panelService, imageCache } = createApp({ config, db, registry });

// Re-apply the persisted performance-mode profile (max proxy concurrency,
// widened TTL cache + stretched TTLs, in-process image fetches, max
// prefetch width with no failure/claim backoffs - user-configured
// inter-chapter pacing is still honoured). The runtime profile does not live
// in env, so without this a restart would silently drop back to standard
// limits while the settings file still says ON.
try {
  const persisted = loadCacheSettings();
  if (persisted.performanceMode) {
    await applyPerformanceProfile({ panelService, imageCache, registry, prefetchWorker }, true);
    logger.info('Performance mode enabled (restored from cache settings)', {
      proxyConcurrency: imageCache.getUpstreamConcurrency(),
    });
  }
} catch (error) {
  logger.warn('Performance-mode restore failed (standard limits apply)', {
    error: error instanceof Error ? error.message : String(error),
  });
}

// One-time, best-effort organization of pre-existing flat cache files
// into per-panel folders (runs before the prefetch worker starts so no
// write can race a rename). Unknown files stay flat and keep serving.
try {
  const migrated = await migrateImageCacheToFolders(config.imageCache.dir, db);
  if (migrated.moved > 0) {
    logger.info('Image cache organized into panel folders', { ...migrated });
  }
} catch (error) {
  logger.warn('Image cache organization failed (cache still works flat)', {
    error: error instanceof Error ? error.message : String(error),
  });
}

// Server-side prefetch queue: drains `prefetch_jobs` so downloads survive
// browser refresh / tab close / API restart. Single-flight per process;
// the tick is a no-op while a job is being processed.
await prefetchWorker.start();
const prefetchTimer = setInterval(() => {
  void prefetchWorker.tick().catch((error) => {
    logger.error('PrefetchWorker tick failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}, 500);

// Periodic auto-backup: snapshot the embedded database every
// BACKUP_INTERVAL_MS while the server runs, so recent bookmarks/progress
// survive a crash or power cut (the on-exit backup only fires on a clean
// shutdown). A failed backup is logged, never fatal; ticks never overlap.
let backupInFlight = false;
const backupTimer =
  config.backupDir && config.backupIntervalMs > 0
    ? setInterval(() => {
        if (backupInFlight) return;
        backupInFlight = true;
        void writeBackup(db, config.backupDir, config.backupScope)
          .catch((error) => {
            logger.error('Periodic backup failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            backupInFlight = false;
          });
      }, config.backupIntervalMs)
    : undefined;
if (backupTimer !== undefined) {
  logger.info('Periodic backup enabled', {
    intervalMs: config.backupIntervalMs,
    scope: config.backupScope,
  });
}

// Auto memory relief: when enabled in cache settings, periodically check
// heap AND native RSS usage and flush the in-memory TTL cache + image index
// when either exceeds its threshold. Heap alone is blind to native spikes
// (e.g. a ~400 MB RSS grab with a ~20 MB heap), so RSS gets its own higher
// threshold. Keeps RAM from growing unbounded after long browsing sessions.
const AUTO_RELIEF_CHECK_MS = 30_000;
const autoReliefTimer = setInterval(() => {
  try {
    const settings = loadCacheSettings();
    // Performance mode keeps caches hot by design — the relief flush would
    // undo exactly what the toggle promises. Manual "Flush memory" still
    // works while on; automatic relief resumes when the toggle goes off.
    if (settings.performanceMode) return;
    if (!settings.autoMemoryRelief) return;
    const mem = process.memoryUsage();
    const thresholdMb = Math.max(20, Math.round(settings.autoMemoryReliefThresholdMb || 20));
    const thresholdBytes = thresholdMb * 1024 * 1024;
    const rssThresholdMb = Math.max(128, Math.round(settings.autoMemoryReliefRssThresholdMb || 256));
    const rssThresholdBytes = rssThresholdMb * 1024 * 1024;
    const heapOver = mem.heapUsed > thresholdBytes;
    const rssOver = mem.rss > rssThresholdBytes;
    if (heapOver || rssOver) {
      // Native RSS bloat (rssOver with a small heap) is mostly
      // allocator-held pages, not JS objects — the default non-blocking
      // `Bun.gc()` demonstrably collects nothing there, so run a full
      // forced collection to release everything releasable. Heap-only
      // events keep the cheap non-blocking call.
      const blocking = rssOver;
      logger.info(
        blocking ? 'Auto memory relief triggered (RSS high-water)' : 'Auto memory relief triggered',
        {
          heapUsedBytes: mem.heapUsed,
          thresholdBytes: thresholdBytes,
          thresholdMb,
          rssBytes: mem.rss,
          rssThresholdBytes,
          rssThresholdMb,
          heapOver,
          rssOver,
        },
      );
      panelService.clearCache();
      imageCache.dropMemoryIndex();
      const bunGc = (globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun?.gc;
      if (typeof bunGc === 'function') {
        bunGc(blocking ? true : undefined);
      }
    }
  } catch {
    // Best-effort; never crash the server for a settings-file read error.
  }
}, AUTO_RELIEF_CHECK_MS);

// Optional: serve the built web app (production / all-in-one Docker image).
const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, '../../web/dist');
if (existsSync(webDist)) {
  // Plain-text robots.txt so crawlers (and Lighthouse) don't parse index.html
  // as a robots file. Registered before the static + SPA fallback below.
  app.get('/robots.txt', (c) =>
    c.text('User-agent: *\nDisallow:\n', 200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    }),
  );
  /**
   * Hashed Vite assets (`assets/index-<hash>.js`) are content-addressed: the
   * URL changes on every build, so the file never goes stale. Cache them
   * immutably for a year; everything else (index.html, favicon) stays short.
   */
  const cacheControlFor = (filePath: string): string => {
    if (/\/assets\/[^/]*-[A-Za-z0-9_-]{6,}\.(js|css|woff2?)$/.test(filePath)) {
      return 'public, max-age=31536000, immutable';
    }
    return 'public, max-age=3600';
  };
  app.use(
    '/*',
    serveStatic({
      root: webDist,
      rewriteRequestPath: (path) => path,
      // hono refuses any path containing a literal `%` unless this is set.
      // Panel/chapter links always encode the `:` in the global id
      // (`/panel/rl%3A…`), so without it every detail/reader refresh 404s.
      // Decoding + traversal checks (`..`, backslashes) still apply.
      allowPercentInPath: true,
      onNotFound: () => {},
      onFound: (path, c) => {
        c.header('Cache-Control', cacheControlFor(path));
      },
    }),
  );
  // SPA fallback: unknown non-API paths serve index.html.
  // Note: use a root-relative rewrite instead of the `path` option. The `path`
  // option is joined onto the default root with node:path.join, which strips the
  // leading slash on POSIX (`join('./', '/abs/path')` -> relative), so an absolute
  // `path` silently fails to resolve on Linux (Bun.file resolves relative to the
  // module dir, not the process cwd). Rewriting to a root-relative name keeps the
  // final path absolute on every platform.
  app.get(
    '*',
    serveStatic({
      root: webDist,
      rewriteRequestPath: () => 'index.html',
      // See above — required for encoded ids in `/panel/:id` / `/read/:id`.
      allowPercentInPath: true,
      onFound: (_path, c) => {
        // Entry HTML references hashed assets by name — never cache it long
        // or a deploy keeps serving stale chunk filenames.
        c.header('Cache-Control', 'no-cache');
      },
    }),
  );
  logger.info('Serving built frontend', { webDist });
}

const server = Bun.serve({
  port: config.port,
  // Bind every interface so devices on the LAN can reach the API — mirrors
  // Vite's `host: true`. Bun defaults to localhost only.
  hostname: '0.0.0.0',
  fetch: app.fetch,
  // Cap the request body at 220 MiB. The largest legitimate payload is the
  // POST /api/backup/import dump — the route validates it at 200 MB — with
  // every other endpoint well under 100 KB. The server-level cap sits just
  // above the route limit so route-level validation, not the transport,
  // decides what fits; anything larger is rejected by either layer.
  maxRequestBodySize: 230_686_720,
  // Close idle connections after 60s instead of Bun's 10s default. Slow
  // responses are legitimate here: the sources benchmark fans out to live
  // listings (10s+ wall time) and the backup export streams multi-MB dumps.
  // With the default the socket is closed mid-request and the dev proxy
  // surfaces it as a "socket hang up" with no JSON body.
  idleTimeout: 60,
});

logger.info(`Panel viewer API listening`, {
  url: `http://0.0.0.0:${server.port}`,
  local: `http://localhost:${server.port}`,
  env: process.env.NODE_ENV ?? 'development',
  sources: registry.list().map((s) => `${s.label} (${s.enabled ? 'enabled' : 'disabled'})`),
});

// Graceful shutdown: stop claiming new jobs, let the in-flight job finish
// its current page, snapshot the embedded database to a compressed backup,
// then close the HTTP server. Docker sends SIGTERM.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal} — shutting down`);
  clearInterval(prefetchTimer);
  clearInterval(autoReliefTimer);
  if (backupTimer !== undefined) clearInterval(backupTimer);
  await prefetchWorker.stop();
  if (config.backupDir) {
    try {
      await writeBackup(db, config.backupDir, config.backupScope);
    } catch (error) {
      // A failed backup must never prevent shutdown — the server is closing
      // anyway and the live data dir survives the process.
      logger.error('On-exit backup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await db.$client.close();
  await releaseInstanceLock();
  server.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));