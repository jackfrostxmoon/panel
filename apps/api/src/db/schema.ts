import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { PanelPage, SourceSearchResult } from '@panel/shared';

/**
 * Database schema.
 *
 * `panel` / `chapters` double as a metadata cache for source data AND as the
 * anchor for user data (bookmarks, reading progress). Rows are upserted from
 * source payloads, so user data keeps working even when the source is down.
 *
 * There is deliberately no `users` table yet (single-user local app), but all
 * user-data tables are shaped so a `user_id` column can be added later
 * without restructuring.
 */

export const panel = pgTable(
  'panel',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Source name, e.g. "mk". */
    source: text('source').notNull(),
    /** Native id at the source, e.g. "solo-leveling.21708". */
    sourceId: text('source_id').notNull(),
    /** Global id used across the API, e.g. "mk:solo-leveling.21708". */
    globalId: text('global_id').notNull(),
    title: text('title').notNull(),
    altTitles: jsonb('alt_titles')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    description: text('description'),
    authors: jsonb('authors')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    artists: jsonb('artists')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    genres: jsonb('genres')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text('status').notNull().default('unknown'),
    coverUrl: text('cover_url'),
    sourceUrl: text('source_url').notNull(),
    cachedAt: timestamp('cached_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('panel_source_source_id_key').on(t.source, t.sourceId),
    uniqueIndex('panel_global_id_key').on(t.globalId),
    index('panel_title_idx').on(t.title),
  ],
);

export const chapters = pgTable(
  'chapters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    panelId: uuid('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    /** Native chapter id, e.g. "solo-leveling.21708~c200". */
    sourceId: text('source_id').notNull(),
    globalId: text('global_id').notNull(),
    title: text('title').notNull(),
    chapterNumber: doublePrecision('chapter_number'),
    sourceUrl: text('source_url').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    cachedAt: timestamp('cached_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chapters_source_source_id_key').on(t.source, t.sourceId),
    uniqueIndex('chapters_global_id_key').on(t.globalId),
    index('chapters_panel_id_idx').on(t.panelId),
  ],
);

export const bookmarks = pgTable(
  'bookmarks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    panelId: uuid('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
export const readingList = pgTable(
  'reading_list',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    panelId: uuid('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    /** One of the ReadingListStatus values (validated by the service). */
    status: text('status').notNull().default('reading'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
export const panelRatings = pgTable(
  'panel_ratings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    panelId: uuid('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    rating: integer('rating').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('panel_ratings_panel_id_key').on(t.panelId)],
);

/**
 * User-defined tags (T3-4). A tag is a free-form label the user applies to
 * panel; the join table maps many panel to many tags.
 */
export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Lowercased on write — tags are case-insensitive. */
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tags_name_key').on(t.name)],
);

/** Many-to-many: panel ↔ tags (T3-4). */
export const panelTags = pgTable(
  'panel_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    panelId: uuid('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('panel_tags_panel_tag_key').on(t.panelId, t.tagId),
    index('panel_tags_tag_id_idx').on(t.tagId),
  ],
);

export const chapterBookmarks = pgTable(
  'chapter_bookmarks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    panelId: uuid('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chapter_bookmarks_panel_chapter_key').on(t.panelId, t.chapterId),
    index('chapter_bookmarks_panel_id_idx').on(t.panelId),
  ],
);

export const readingProgress = pgTable(
  'reading_progress',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    panelId: uuid('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    /** 0-based page index. */
    page: integer('page').notNull().default(0),
    /**
     * Overall chapter scroll fraction (0–1) for vertical continue-reading.
     * Null = page-granular (paged/gallery or legacy rows).
     */
    scrollFraction: doublePrecision('scroll_fraction'),
    /** Horizontal pan in CSS px (vertical/zoomed reading). Null = unknown. */
    scrollX: doublePrecision('scroll_x'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
export const recentlyViewed = pgTable(
  'recently_viewed',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    panelId: uuid('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    viewedAt: timestamp('viewed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
export const bookmarkFolders = pgTable(
  'bookmark_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('bookmark_folders_name_key').on(t.name)],
);

/** Many-to-many: a panel bookmark can belong to many folders. */
export const bookmarkFolderItems = pgTable(
  'bookmark_folder_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    folderId: uuid('folder_id')
      .notNull()
      .references(() => bookmarkFolders.id, { onDelete: 'cascade' }),
    bookmarkId: uuid('bookmark_id')
      .notNull()
      .references(() => bookmarks.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
export const chapterPages = pgTable(
  'chapter_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    panelId: uuid('panel_id')
      .notNull()
      .references(() => panel.id, { onDelete: 'cascade' }),
    /** Ordered image URLs, JSON-encoded (cheap, pages are small). */
    pages: jsonb('pages')
      .$type<PanelPage[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    coverUrl: text('cover_url'),
    panelTitle: text('panel_title'),
    chapterTitle: text('chapter_title'),
    prevChapterId: text('prev_chapter_id'),
    nextChapterId: text('next_chapter_id'),
    cachedAt: timestamp('cached_at', { withTimezone: true }).notNull().defaultNow(),
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
export const listCache = pgTable(
  'list_cache',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** "search" | "latest". */
    kind: text('kind').notNull(),
    /** Normalised query string (lowercased, trimmed) for search; "page:N" for latest. */
    key: text('key').notNull(),
    /** Comma-separated source filter, or "*". */
    source: text('source').notNull(),
    page: integer('page').notNull(),
    /** Ordered results, JSON-encoded. */
    results: jsonb('results')
      .$type<SourceSearchResult['results']>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    hasMore: boolean('has_more').notNull().default(false),
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
 * Partial unique index `prefetch_jobs_active_chapter_id_key` (defined in
 * the migration) prevents the same chapter from being queued twice while a
 * previous job for it is still active.
 */
export const prefetchJobs = pgTable(
  'prefetch_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Global chapter id, e.g. "mk:solo-leveling.21708~c200". */
    chapterId: text('chapter_id').notNull(),
    /** UUID shared by every job enqueued by the same "Download all" click. */
    batchId: uuid('batch_id'),
    status: text('status').notNull().default('pending'),
    /** True to skip pages already on disk (default). */
    onlyMissing: boolean('only_missing').notNull().default(true),
    /** Total pages to attempt; set when the worker starts the job. */
    totalPages: integer('total_pages').notNull().default(0),
    /** Pages confirmed on disk (cached + freshly fetched in this run). */
    cachedPages: integer('cached_pages').notNull().default(0),
    failedPages: integer('failed_pages').notNull().default(0),
    /** 0-based page indices that failed. */
    failed: jsonb('failed')
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
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
    runAfter: timestamp('run_after', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('prefetch_jobs_status_idx').on(t.status),
    index('prefetch_jobs_batch_id_idx').on(t.batchId),
    index('prefetch_jobs_created_at_idx').on(t.createdAt),
  ],
);

export type PrefetchJobRow = typeof prefetchJobs.$inferSelect;
export type PrefetchJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
