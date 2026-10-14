import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { AppConfig } from './config.js';
import type { Database } from './db/client.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { rateLimit } from './middleware/rateLimit.js';
import { requestLogger } from './middleware/requestLogger.js';
import { BookmarkFolderRepository, BookmarkRepository, PanelRatingRepository, TagRepository } from './repositories/bookmarkRepository.js';
import { ChapterBookmarkRepository } from './repositories/chapterBookmarkRepository.js';
import { PanelCacheRepository } from './repositories/panelCacheRepository.js';
import { ProgressRepository } from './repositories/progressRepository.js';
import { ReadingListRepository } from './repositories/readingListRepository.js';
import { RecentlyViewedRepository } from './repositories/recentlyViewedRepository.js';
import { backupRoutes } from './routes/backup.js';
import { bookmarkRoutes } from './routes/bookmarks.js';
import { bookmarkFolderRoutes } from './routes/bookmarkFolders.js';
import { panelRatingRoutes } from './routes/ratings.js';
import { tagRoutes } from './routes/tags.js';
import { chapterBookmarkRoutes } from './routes/chapterBookmarks.js';
import { chapterRoutes } from './routes/chapters.js';
import { healthRoutes } from './routes/health.js';
import { prefetchRoutes } from './routes/prefetch.js';
import { readingListRoutes } from './routes/readingList.js';
import { recentlyViewedRoutes } from './routes/recentlyViewed.js';
import { sourceImageRoutes } from './routes/images.js';
import { panelRoutes } from './routes/panel.js';
import { progressRoutes } from './routes/progress.js';
import { BookmarkFolderService } from './services/bookmarkFolderService.js';
import { PanelRatingService } from './services/panelRatingService.js';
import { TagService } from './services/tagService.js';
import { BookmarkService } from './services/bookmarkService.js';
import { ChapterBookmarkService } from './services/chapterBookmarkService.js';
import { PanelService } from './services/panelService.js';
import { ProgressService } from './services/progressService.js';
import { ReadingListService } from './services/readingListService.js';
import { RecentlyViewedService } from './services/recentlyViewedService.js';
import type { SourceRegistry } from './sources/registry.js';
import { readerSettingsRoutes } from './routes/reader-settings.js';
import { readerStylesRoutes } from './routes/reader-styles.js';
import { latestSettingsRoutes } from './routes/latest-settings.js';
import { searchSettingsRoutes } from './routes/search-settings.js';
import { bookmarksSettingsRoutes } from './routes/bookmarks-settings.js';
import { cacheSettingsRoutes } from './routes/cache-settings.js';
import { sourceOrderRoutes } from './routes/source-order.js';
import { memoryFlushRoutes } from './routes/memory-flush.js';
import { ImageCache } from './lib/imageCache.js';
import { panelFolderName, folderTagHash, chapterFolderName, formatChapterLabel } from './lib/imageCacheFolders.js';
import { PrefetchWorker } from './lib/prefetchWorker.js';

import { loadReaderSettings } from './lib/readerSettingsFile.js';

export interface AppDeps {
  config: AppConfig;
  db: Database;
  registry: SourceRegistry;
}

export interface BuiltApp {
  app: Hono;
  /**
   * Server-side prefetch worker. Constructed (not started) so the same
   * `ImageCache` / `PanelService` instances are shared between HTTP
   * routes and the background drain loop. `index.ts` starts it; test
   * apps simply ignore it.
   */
  prefetchWorker: PrefetchWorker;
  panelService: PanelService;
  imageCache: ImageCache;
}

/**
 * Application factory — wires dependencies and returns the Hono app plus
 * the (unstated) prefetch worker.
 * Kept separate from index.ts so tests can build an app with a test DB
 * without binding a port.
 */
export function createApp({ config, db, registry }: AppDeps): BuiltApp {
  // Load reader settings synchronously at server startup.
  loadReaderSettings();

  // Repositories
  const panelCacheRepo = new PanelCacheRepository(db);
  const bookmarkRepo = new BookmarkRepository(db);
  const bookmarkFolderRepo = new BookmarkFolderRepository(db);
  const panelRatingRepo = new PanelRatingRepository(db);
  const tagRepo = new TagRepository(db);
  const chapterBookmarkRepo = new ChapterBookmarkRepository(db);
  const progressRepo = new ProgressRepository(db);
  const readingListRepo = new ReadingListRepository(db);
  const recentlyViewedRepo = new RecentlyViewedRepository(db);

  // Services
  const panelService = new PanelService(registry, config.cache, panelCacheRepo);
  const bookmarkService = new BookmarkService(bookmarkRepo, panelCacheRepo, bookmarkFolderRepo);
  const bookmarkFolderService = new BookmarkFolderService(bookmarkFolderRepo, bookmarkRepo, panelCacheRepo);
  const panelRatingService = new PanelRatingService(panelRatingRepo, panelCacheRepo);
  const tagService = new TagService(tagRepo, panelCacheRepo);
  const chapterBookmarkService = new ChapterBookmarkService(chapterBookmarkRepo, panelCacheRepo, registry);
  const progressService = new ProgressService(progressRepo, panelCacheRepo, registry);
  const readingListService = new ReadingListService(readingListRepo, panelCacheRepo, registry);
  const recentlyViewedService = new RecentlyViewedService(
    recentlyViewedRepo,
    bookmarkRepo,
    panelCacheRepo,
  );

  // On-disk cache for proxied cover / chapter images (local data directory).
  // Files attributable to a panel land in `<Title> [<source>-<hash>]/`
  // folders, with chapter pages one level deeper in
  // `<chapter label> [<chapterHash>]/` subfolders as `001.jpg`-style numbered
  // files, so the cache is browsable; unattributable ones stay flat.
  // Resolution is memoized inside ImageCache and only runs on cache
  // misses (writes) — reads are served from the recursive index (or the
  // chapter folder path for numbered pages). Read-only: folder names are
  // derived from existing metadata rows, nothing is stored in the database.
  const imageCache = new ImageCache({
    ...config.imageCache,
    resolveFolder: async (tag, kind) => {
      const info = await panelCacheRepo.resolveTagToCacheTarget(tag);
      if (!info) return null;
      const panelFolder = panelFolderName(info.title, info.source, folderTagHash(info.panelGlobalId));
      if (kind !== 'chapter' || !info.isChapter) return { panelFolder, chapterFolder: null };
      // Chapter row missing (or no usable label) — keep today's behavior:
      // hash-named file directly in the panel folder.
      if (info.chapterNumber === null && info.chapterTitle === null) {
        return { panelFolder, chapterFolder: null };
      }
      return {
        panelFolder,
        chapterFolder: chapterFolderName(
          formatChapterLabel(info.chapterNumber, info.chapterTitle ?? ''),
          folderTagHash(tag),
        ),
      };
    },
  });

  // Server-side prefetch queue. Shares the route-level `ImageCache` and
  // `PanelService` so the disk index and in-flight dedup stay coherent.
  // Constructed here, started by index.ts (never auto-started — test
  // apps get the routes without a background loop).
  const prefetchWorker = new PrefetchWorker({ db, registry, imageCache, panelService });

  const app = new Hono();

  // Global middleware
  app.use('*', secureHeaders());
  app.use('*', requestLogger);
  app.use(
    '/api/*',
    cors({
      origin: config.corsOrigin,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  );
  // Generous local-dev limits; still guards the upstream source from abuse.
  // Sized for this app's own burst patterns, which all count toward the one
  // bucket: the bookmarks grid renders every card (551 covers on a fast
  // scroll), and parallel/gallery chapter loads fetch every page at once.
  // Anything past ~20 req/s sustained is a runaway loop, not browsing.
  // Upstream is guarded separately (source TTL cache + in-flight dedup +
  // retry backoff), so this cap only needs to stop client-side storms.
  app.use('/api/*', rateLimit({ windowMs: 60_000, max: 1200 }));

  app.onError(errorHandler);

  // notFound handler for API routes: return JSON envelope instead of SPA fallback.
  // Only matches paths under /api/ to avoid intercepting frontend routes.
  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) {
      return notFoundHandler(c);
    }
    // Non-API paths fall through to SPA fallback (if built) or default 404.
    return c.text('Not found', 404);
  });

  // Routes
  app.route('/api', healthRoutes(db, registry, imageCache, config.shareLanAddress));
  app.route('/api/panel', panelRoutes(panelService, registry));
  app.route('/api/chapter', chapterRoutes(panelService, db, { worker: prefetchWorker }));
  app.route('/api/prefetch', prefetchRoutes(db, { worker: prefetchWorker }));
  app.route('/api/source-image', sourceImageRoutes(registry, imageCache, (ids) =>
    panelCacheRepo.findPanelGlobalIdByChapterGlobalIds(ids),
    async (panelId) => {
      const found = await panelCacheRepo.findChaptersByPanel(panelId);
      return found ? found.rows.map((row) => row.globalId) : [];
    },
    (panelIds) => panelCacheRepo.findChapterGlobalIdsByPanelGlobalIds(panelIds),
  ));
  app.route('/api/backup', backupRoutes(db));
  app.route('/api/bookmarks', bookmarkRoutes(bookmarkService));
  app.route('/api/bookmark-folders', bookmarkFolderRoutes(bookmarkFolderService));
  app.route('/api/ratings', panelRatingRoutes(panelRatingService));
  app.route('/api/tags', tagRoutes(tagService));
  app.route('/api/chapter-bookmarks', chapterBookmarkRoutes(chapterBookmarkService));
  app.route('/api/progress', progressRoutes(progressService));
  app.route('/api/reading-list', readingListRoutes(readingListService));
  app.route('/api/reader-settings', readerSettingsRoutes());
  app.route('/api/reader-styles', readerStylesRoutes());
  app.route('/api/latest-settings', latestSettingsRoutes());
  app.route('/api/search-settings', searchSettingsRoutes());
  app.route('/api/bookmarks-settings', bookmarksSettingsRoutes());
  app.route('/api/cache-settings', cacheSettingsRoutes({ panelService, imageCache, registry }));
  app.route('/api/source-order', sourceOrderRoutes());
  app.route('/api/recently-viewed', recentlyViewedRoutes(recentlyViewedService));
  app.route('/api/memory-flush', memoryFlushRoutes(panelService, imageCache));

  return { app, prefetchWorker, panelService, imageCache };
}
