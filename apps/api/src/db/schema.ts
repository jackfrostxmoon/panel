import { randomUUID } from 'node:crypto';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { PanelPage, SourceSearchResult } from '@panel/shared';

/**
 * Database schema (SQLite, embedded via `bun:sqlite`).
 *
 * `panel` / `chapters` double as a metadata cache for source data AND as the
 * anchor for user data (bookmarks, reading progress). Rows are upserted from
 * source payloads, so user data keeps working even when the source is down.
 *
 * There is deliberately no `users` table yet (single-user local app), but all
 * user-data tables are shaped so a `user_id` column can be added later
 * without restructuring.
 *
 * Storage notes (SQLite vs the old PostgreSQL):
 * - Ids are uuid strings in `text` columns (was `uuid ... DEFAULT
 *   gen_random_uuid()`); new rows get `randomUUID()` in JS.
 * - String arrays / page lists are `text` in `json` mode (auto
 *   JSON-serialised; was `jsonb`). Table/column/index names are unchanged so
 *   existing COPY-block backups keep restoring 1:1.
 * - Timestamps are integer milliseconds (`timestamp_ms` mode, mapped to
 *   `Date`; was `timestamp with time zone`). Booleans are 0/1 integers
 *   (`boolean` mode). `chapter_number` is `real`.
 */

export const panel = sqliteTable(
  'panel',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** Source name, e.g. "mk". */
    source: text('source').notNull(),
    /** Native id at the source, e.g. "solo-leveling.21708". */
    sourceId: text('source_id').notNull(),
    /** Global id used across the API, e.g. "mk:solo-leveling.21708". */
    globalId: text('global_id').notNull(),
    title: text('title').notNull(),
    altTitles: text('alt_titles', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
    description: text('description'),
    authors: text('authors', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
    artists: text('artists', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
    genres: text('genres', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
    status: text('status').notNull().default('unknown'),
    coverUrl: text('cover_url'),
    sourceUrl: text('source_url').notNull(),
    cachedAt: integer('cached_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('panel_source_source_id_key').on(t.source, t.sourceId),
    uniqueIndex('panel_global_id_key').on(t.globalId),
    index('panel_title_idx').on(t.title),
  ],
);

export const chapters = sqliteTable(
  'chapters',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    panelId: text('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    /** Native chapter id, e.g. "solo-leveling.21708~c200". */
    sourceId: text('source_id').notNull(),
    globalId: text('global_id').notNull(),
    title: text('title').notNull(),
    chapterNumber: real('chapter_number'),
    sourceUrl: text('source_url').notNull(),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
    cachedAt: integer('cached_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('chapters_source_source_id_key').on(t.source, t.sourceId),
    uniqueIndex('chapters_global_id_key').on(t.globalId),
    index('chapters_panel_id_idx').on(t.panelId),
  ],
);

export const bookmarks = sqliteTable(
  'bookmarks',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    panelId: text('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('bookmarks_panel_id_key').on(t.panelId)],
);

/**
 * The reading list (T1-5): one row per panel with a user-chosen status.
 *
 * `want_to_read` / `reading` / `completed` are the three supported states.
 * `reading` is the default when a panel is added from the details page;
 * the user can move it to any of the three at any time. A panel with no row
 * here is simply "not on the list".
 */
export const readingList = sqliteTable(
  'reading_list',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    panelId: text('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    /** One of the ReadingListStatus values (validated by the service). */
    status: text('status').notNull().default('reading'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('reading_list_panel_id_key').on(t.panelId),
    index('reading_list_status_idx').on(t.status),
  ],
);

/**
 * User star rating per panel (T3-3). One row per panel (single-user app);
 * 1–5, validated by the service. Unrated panel simply have no row.
 */
export const panelRatings = sqliteTable(
  'panel_ratings',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    panelId: text('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    rating: integer('rating').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('panel_ratings_panel_id_key').on(t.panelId)],
);

/**
 * User-defined tags (T3-4). A tag is a free-form label the user applies to
 * panel; the join table maps many panel to many tags.
 */
export const tags = sqliteTable(
  'tags',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** Lowercased on write — tags are case-insensitive. */
    name: text('name').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('tags_name_key').on(t.name)],
);

/** Many-to-many: panel ↔ tags (T3-4). */
export const panelTags = sqliteTable(
  'panel_tags',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    panelId: text('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('panel_tags_panel_tag_key').on(t.panelId, t.tagId),
    index('panel_tags_tag_id_idx').on(t.tagId),
  ],
);

export const chapterBookmarks = sqliteTable(
  'chapter_bookmarks',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    panelId: text('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    chapterId: text('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('chapter_bookmarks_panel_chapter_key').on(t.panelId, t.chapterId),
    index('chapter_bookmarks_panel_id_idx').on(t.panelId),
  ],
);

export const readingProgress = sqliteTable(
  'reading_progress',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    panelId: text('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    chapterId: text('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    // Page-position columns (`page`, `scroll_fraction`, `scroll_x`,
    // `anchor_ratio`) were dropped: progress is a chapter-level read
    // marker (which chapters were opened), never a page position.
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('reading_progress_panel_chapter_key').on(t.panelId, t.chapterId),
    index('reading_progress_updated_at_idx').on(t.updatedAt),
  ],
);

/**
 * Server-side recently-viewed history (powers the home-page rail). One row
 * per panel (single-user app); opening a panel details page "touches" its
 * row, so the history survives browser clears, incognito sessions, and
 * device switches — unlike the old localStorage-only rail.
 */
export const recentlyViewed = sqliteTable(
  'recently_viewed',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    panelId: text('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    viewedAt: integer('viewed_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('recently_viewed_panel_id_key').on(t.panelId),
    index('recently_viewed_viewed_at_idx').on(t.viewedAt),
  ],
);

/**
 * Bookmark folders / collections (T2-8). A folder is just a named grouping
 * of panel bookmarks; panel can live in multiple folders.
 *
 * `isDefault` marks the "Reading list" folder — the one that powers the
 * continue-reading rail. It's created lazily on first save and never
 * deletable, so we always have a home for a bookmark even if the user
 * hasn't made a folder yet.
 */
export const bookmarkFolders = sqliteTable(
  'bookmark_folders',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    name: text('name').notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('bookmark_folders_name_key').on(t.name)],
);

/** Many-to-many: a panel bookmark can belong to many folders. */
export const bookmarkFolderItems = sqliteTable(
  'bookmark_folder_items',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    folderId: text('folder_id')
      .notNull()
      .references(() => bookmarkFolders.id, { onDelete: 'cascade' }),
    bookmarkId: text('bookmark_id')
      .notNull()
      .references(() => bookmarks.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('bookmark_folder_items_folder_bookmark_key').on(t.folderId, t.bookmarkId),
    index('bookmark_folder_items_bookmark_id_idx').on(t.bookmarkId),
  ],
);

export type PanelRow = typeof panel.$inferSelect;
export type ChapterRow = typeof chapters.$inferSelect;
export type BookmarkRow = typeof bookmarks.$inferSelect;
export type ChapterBookmarkRow = typeof chapterBookmarks.$inferSelect;
export type ReadingProgressRow = typeof readingProgress.$inferSelect;
export type RecentlyViewedRow = typeof recentlyViewed.$inferSelect;
export type ReadingListRow = typeof readingList.$inferSelect;
export type BookmarkFolderRow = typeof bookmarkFolders.$inferSelect;
export type BookmarkFolderItemRow = typeof bookmarkFolderItems.$inferSelect;
export type PanelRatingRow = typeof panelRatings.$inferSelect;
export type TagRow = typeof tags.$inferSelect;
export type PanelTagRow = typeof panelTags.$inferSelect;

/**
 * Persisted reader payload for a chapter: the ordered image URLs and the
 * metadata the reader needs (panel/chapter titles, cover, prev/next). Written
 * on first read so a chapter re-opened offline (or with the source down)
 * still renders — the images themselves live in the on-disk ImageCache.
 */
export const chapterPages = sqliteTable(
  'chapter_pages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    chapterId: text('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    panelId: text('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    /** Ordered image URLs, JSON-encoded (cheap, pages are small). */
    pages: text('pages', { mode: 'json' }).$type<PanelPage[]>().notNull().$defaultFn(() => []),
    coverUrl: text('cover_url'),
    panelTitle: text('panel_title'),
    chapterTitle: text('chapter_title'),
    prevChapterId: text('prev_chapter_id'),
    nextChapterId: text('next_chapter_id'),
    cachedAt: integer('cached_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('chapter_pages_chapter_id_key').on(t.chapterId),
    index('chapter_pages_panel_id_idx').on(t.panelId),
  ],
);

export type ChapterPagesRow = typeof chapterPages.$inferSelect;

/**
 * Persisted search / latest result lists. Keyed by the exact query so an
 * offline revisit renders the same ordered cards the user saw online.
 * Individual panel metadata also lives in `panel`; this table preserves the
 * *list* (ordering, hasMore) which the row store cannot.
 */
export const listCache = sqliteTable(
  'list_cache',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** "search" | "latest". */
    kind: text('kind').notNull(),
    /** Normalised query string (lowercased, trimmed) for search; "page:N" for latest. */
    key: text('key').notNull(),
    /** Comma-separated source filter, or "*". */
    source: text('source').notNull(),
    page: integer('page').notNull(),
    /** Ordered results, JSON-encoded. */
    results: text('results', { mode: 'json' })
      .$type<SourceSearchResult['results']>()
      .notNull()
      .$defaultFn(() => []),
    hasMore: integer('has_more', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    uniqueIndex('list_cache_kind_key_source_page_key').on(t.kind, t.key, t.source, t.page),
    index('list_cache_kind_idx').on(t.kind),
  ],
);

export type ListCacheRow = typeof listCache.$inferSelect;

/**
 * Server-side image-cache prefetch job queue.
 *
 * "Pre-warm" downloads used to run entirely in the user's browser, which
 * meant a refresh, tab close, or browser crash killed the whole batch and
 * left most pages un-cached. The job now lives here: enqueue via POST
 * `/api/chapter/:id/prefetch`, a background worker drains the queue, and
 * the web UI polls `/api/prefetch/jobs` for live progress.
 *
 * `batchId` groups chapters from a single "Download all" run so the worker
 * can honour `intervalMs` between consecutive chapters in the same batch.
 * A single-click download is a one-chapter batch with `intervalMs=0`.
 *
 * Duplicate active jobs for the same chapter are rejected at the
 * application level (`findActiveByChapter` + unique-violation handling in
 * `enqueue`) — SQLite has no partial unique index to enforce
 * "one active job per chapter" in DDL.
 */
export const prefetchJobs = sqliteTable(
  'prefetch_jobs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** Global chapter id, e.g. "mk:solo-leveling.21708~c200". */
    chapterId: text('chapter_id').notNull(),
    /** UUID shared by every job enqueued by the same "Download all" click. */
    batchId: text('batch_id'),
    status: text('status').notNull().default('pending'),
    /** True to skip pages already on disk (default). */
    onlyMissing: integer('only_missing', { mode: 'boolean' }).notNull().default(true),
    /** Total pages to attempt; set when the worker starts the job. */
    totalPages: integer('total_pages').notNull().default(0),
    /** Pages confirmed on disk (cached + freshly fetched in this run). */
    cachedPages: integer('cached_pages').notNull().default(0),
    failedPages: integer('failed_pages').notNull().default(0),
    /** 0-based page indices that failed. */
    failed: text('failed', { mode: 'json' }).$type<number[]>().notNull().$defaultFn(() => []),
    /** Pacing to apply between chapters in the same batch (worker honors). */
    intervalMs: integer('interval_ms').notNull().default(0),
    /**
     * The job must not start before this timestamp. The worker's claim
     * query only picks up due jobs (`run_after IS NULL OR run_after <=
     * now()`). Two uses: (1) a single manual click enqueued with
     * `delayMs` waits out the user's pacing setting before firing;
     * (2) after each completion the worker pushes the remaining
     * batch-mates' `run_after` forward by `intervalMs` — pacing without
     * ever blocking the worker loop on a sleep.
     */
    runAfter: integer('run_after', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('prefetch_jobs_status_idx').on(t.status),
    index('prefetch_jobs_batch_id_idx').on(t.batchId),
    index('prefetch_jobs_created_at_idx').on(t.createdAt),
  ],
);

export type PrefetchJobRow = typeof prefetchJobs.$inferSelect;
export type PrefetchJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
