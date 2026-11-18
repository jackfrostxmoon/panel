/**
 * API contract shared by the backend (Hono) and the frontend (API client).
 *
 * Every endpoint returns the same envelope:
 *
 *   { "success": true,  "data": ... }
 *   { "success": false, "error": { "code": "...", "message": "..." } }
 */

import type { Bookmark, PanelStatus, ReadingListStatus } from './types.js';

export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  PANEL_NOT_FOUND: 'PANEL_NOT_FOUND',
  CHAPTER_NOT_FOUND: 'CHAPTER_NOT_FOUND',
  BOOKMARK_NOT_FOUND: 'BOOKMARK_NOT_FOUND',
  BOOKMARK_EXISTS: 'BOOKMARK_EXISTS',
  READING_LIST_NOT_FOUND: 'READING_LIST_NOT_FOUND',
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  SOURCE_TIMEOUT: 'SOURCE_TIMEOUT',
  SOURCE_PARSE_ERROR: 'SOURCE_PARSE_ERROR',
  SOURCE_DISABLED: 'SOURCE_DISABLED',
  UNKNOWN_SOURCE: 'UNKNOWN_SOURCE',
  DATABASE_ERROR: 'DATABASE_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  INCOGNITO_MODE: 'INCOGNITO_MODE',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ApiErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ApiErrorBody {
  code: ApiErrorCode;
  /** Human-readable, safe-to-display message (never a stack trace). */
  message: string;
  /** Optional extra context (validation issues, upstream status, ...). */
  details?: unknown;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiFailure {
  success: false;
  error: ApiErrorBody;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function ok<T>(data: T): ApiSuccess<T> {
  return { success: true, data };
}

export function fail(code: ApiErrorCode, message: string, details?: unknown): ApiFailure {
  return {
    success: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

/** Request/response payloads for endpoints with bodies. */
export interface CreateBookmarkInput {
  panelId: string;
  title: string;
  coverUrl?: string | null;
  source: string;
  sourceUrl: string;
}

/**
 * One entry of the server-side recently-viewed history. Mirrors the
 * localStorage `RecentlyViewedEntry` shape on the web side so the home
 * page can swap sources without reshaping.
 */
export interface RecentlyViewedPanel {
  /** Global panel id, e.g. "nk:minna-hotaru-wo-koroshitakatta". */
  id: string;
  title: string;
  coverUrl: string | null;
  source: string;
  sourceUrl: string;
  status: PanelStatus;
  latestChapter: string | null;
  /** ISO timestamp of the last view — the list order. */
  viewedAt: string;
}

/** Record (or bump) a panel in the server-side recently-viewed history. */
export interface RecordRecentlyViewedInput {
  panelId: string;
  title: string;
  coverUrl?: string | null;
  source: string;
  sourceUrl: string;
  status?: PanelStatus;
}

export interface SaveProgressInput {
  panelId: string;
  chapterId: string;
  /** Optional display metadata so the home screen can render without an
   *  extra source round-trip. */
  panelTitle?: string;
  coverUrl?: string | null;
  chapterTitle?: string;
}

export interface ChapterBookmark {
  id: string;
  panelId: string;
  chapterId: string;
  createdAt: string;
}

export interface CreateChapterBookmarkInput {
  panelId: string;
  chapterId: string;
  title: string;
  chapterNumber: number | null;
  sourceUrl: string;
  publishedAt: string | null;
}

export interface CreateChapterBookmarksInput {
  panelId: string;
  chapters: Array<{
    chapterId: string;
    title: string;
    chapterNumber: number | null;
    sourceUrl: string;
    publishedAt: string | null;
  }>;
}

/** Per-panel count of bookmarked chapters (powers the bookmarks-page
    "With/Without bookmarked chapters" filter). */
export interface ChapterBookmarkPanelSummary {
  /** Global panel id, e.g. "mk:solo-leveling.21708". */
  panelId: string;
  count: number;
}

/** User rating for a panel, 1–5 stars (T3-3). */
export interface PanelRating {
  panelId: string;
  /** 1–5 stars; the API rejects anything else. */
  rating: number;
  updatedAt: string;
}

/** A source's full genre catalog for the filter dropdowns (site order). */
export interface GenreCatalog {
  source: string;
  genres: string[];
}

/** Upsert a rating (T3-3). Sending the same panel again overwrites it. */
export interface SetPanelRatingInput {
  panelId: string;
  rating: number;
}

/** User-defined tag (T3-4). */
export interface Tag {
  id: string;
  name: string;
}

/** All tags with the panel ids carrying them (T3-4). */
export interface TagWithPanel extends Tag {
  panelIds: string[];
}

/** Replace the tag set on a panel (T3-4). Tags are created on demand. */
export interface SetPanelTagsInput {
  panelId: string;
  /** Tag names (any case); replaces the current set. */
  names: string[];
}

/** Create a standalone tag (T3-4). Idempotent by name. */
export interface CreateTagInput {
  name: string;
}

/** Bookmark folder (T2-8): a named collection of panel bookmarks. */
export interface BookmarkFolder {
  id: string;
  name: string;
  /** The default folder powers the continue-reading rail and is never deletable. */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBookmarkFolderInput {
  name: string;
}

export interface UpdateBookmarkFolderInput {
  id: string;
  name: string;
}

export interface AddBookmarkToFolderInput {
  folderId: string;
  bookmarkId: string;
}

export interface RemoveBookmarkFromFolderInput {
  folderId: string;
  bookmarkId: string;
}

export interface BookmarkFolderContents {
  folder: BookmarkFolder | null;
  items: Bookmark[];
}

/** Bulk mark chapters read / unread (T1-6). `read` = false means "unread". */
export interface BulkMarkChaptersReadInput {
  panelId: string;
  chapters: Array<{ chapterId: string; read: boolean }>;
}

/**
 * Maximum chapters per bulk endpoint POST. Single source of truth shared by
 * the Zod schemas on the server (chapter-bookmark batch + progress bulk-mark)
 * and by the client chunking in `ChapterBookmarkActions.bulkMarkInChunks` and
 * `PanelDetailsPage.handleBookmarkSelected`. The two sides MUST agree —
 * otherwise the client sends chunks the server silently truncates, or vice
 * versa.
 */
export const BULK_CHAPTER_LIMIT = 200;

/** Lifecycle of a server-side prefetch job (`prefetch_jobs.status`). */
export type PrefetchJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * A server-side image-cache prefetch job. Returned by
 * GET /api/prefetch/jobs (list) and GET /api/prefetch/jobs/:id.
 */
export interface PrefetchJob {
  id: string;
  chapterId: string;
  batchId: string | null;
  status: PrefetchJobStatus;
  /** Total pages; 0 until the worker starts the job. */
  totalPages: number;
  /** Pages confirmed on disk (skipped as cached + freshly fetched). */
  cachedPages: number;
  failedPages: number;
  /** 0-based page indices that failed to warm. */
  failed: number[];
  /** ISO timestamp before which the job is not claimable (pacing), or null. */
  runAfter: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * Pages fetched concurrently within this job. Mirrors the reader's image
   * loading width (`parallel` = 8, `sequential` = `preloadAhead`, data-saver
   * = 1). Optional on read so rows written before the column existed still
   * parse; the worker falls back to 3 when absent.
   */
  pageConcurrency?: number;
}

/** Enqueue result (POST /api/chapter/:id/prefetch). `reused` is true when
 *  a job for the chapter was already pending/running and no new row was
 *  created. */
export interface EnqueuePrefetchResult {
  jobId: string;
  reused: boolean;
}

/** Body for POST /api/chapter/:id/prefetch. All fields optional. */
export interface EnqueuePrefetchInput {
  onlyMissing?: boolean;
  /** Shared by every chapter of one "Download all" run (pacing scope). */
  batchId?: string;
  /** Pacing between chapters in the same batch (worker honors). */
  intervalMs?: number;
  /** Hold this job back before it becomes claimable (manual clicks). */
  delayMs?: number;
  /**
   * Pages to fetch concurrently within the chapter (worker honors).
   * Follows the reader's image loading width when set; the worker clamps
   * to 1–16 and defaults to 3 when omitted.
   */
  pageConcurrency?: number;
}

/** Body for POST /api/prefetch/jobs/batch. Enqueues many chapters in one round-trip. */
export interface EnqueuePrefetchBatchInput {
  /** Global chapter ids, in download order (worker claims oldest first). */
  chapters: string[];
  /** Shared pacing scope for the whole batch. */
  batchId?: string;
  /** Pacing between chapters in the same batch (worker honors). */
  intervalMs?: number;
  onlyMissing?: boolean;
  /**
   * Pages to fetch concurrently within each chapter of the batch.
   * Same semantics as `EnqueuePrefetchInput.pageConcurrency`.
   */
  pageConcurrency?: number;
}

/** One entry of a batch enqueue result. */
export interface EnqueuePrefetchBatchItem {
  chapterId: string;
  jobId: string;
  reused: boolean;
}

/** Result for POST /api/prefetch/jobs/batch. */
export interface EnqueuePrefetchBatchResult {
  jobs: EnqueuePrefetchBatchItem[];
}

/** Body for POST /api/prefetch/jobs/cancel-many. */
export interface CancelPrefetchBatchInput {
  jobIds: string[];
}

/** Result for POST /api/prefetch/jobs/cancel-many. */
export interface CancelPrefetchBatchResult {
  cancelled: number;
}

/**
 * Body for POST /api/prefetch/jobs/interval. Retargets the pacing of an
 * in-flight batch: the user changed the "wait between chapters" setting
 * mid-run, so pending (and running) jobs adopt the new value from the next
 * chapter transition on. Setting it to 0 also releases jobs already held
 * by a previous wait.
 */
export interface SetPrefetchIntervalInput {
  jobIds: string[];
  intervalMs: number;
}

/** Result for POST /api/prefetch/jobs/interval. */
export interface SetPrefetchIntervalResult {
  updated: number;
}

/**
 * Full-database SQL dump (pg_dump COPY format) backing the Bookmarks page
 * Export / Import actions.
 *
 * GET /api/backup/export returns the dump as raw `application/sql` (not the
 * JSON envelope — dumps are tens of MB and must skip the extra escaping
 * copy). The file is loadable by `bun run db:import` too.
 *
 * POST /api/backup/import accepts the raw dump (`application/sql`) or,
 * equivalently, the JSON envelope `{ sql }`.
 */
export interface BackupImportInput {
  sql: string;
}

/**
 * Export flavour for GET /api/backup/export (`?scope=`).
 *
 * - `full`: every table, including the reader/search/prefetch caches.
 * - `minimal`: bookmark data only — cache tables are skipped and
 *   `panel`/`chapters` rows are limited to IDs referenced by user data.
 */
export type BackupExportScope = 'full' | 'minimal';

/** Per-table row counts processed by the restore (idempotent). */
export interface BackupImportResult {
  tables: Record<string, number>;
}

/** Reading-list input (T1-5). */
export interface UpsertReadingListInput {
  panelId: string;
  status: ReadingListStatus;
  title: string;
  coverUrl?: string | null;
  source: string;
  sourceUrl: string;
}

/** Lifecycle of the bulk cover re-encode job (`/api/optimize-covers`). */
export type OptimizeCoversState = 'idle' | 'running' | 'done' | 'error';

/**
 * Status snapshot of the cover-optimization job. Read via
 * GET /api/optimize-covers (polled by the cache-settings page while a run
 * is active); POST /api/optimize-covers starts a new run and returns
 * 409 while one is already in flight.
 *
 * `bytesBefore`/`bytesAfter` account for every file that went through the
 * pipeline, but not for ones that could not even be stat'd. Skipped files
 * still count toward `bytesAfter` at their unchanged size, so
 * `bytesBefore - bytesAfter` is always the net disk saved.
 */
export interface OptimizeCoversStatus {
  state: OptimizeCoversState;
  /** ISO timestamp the current/last run started, or null before the first run. */
  startedAt: string | null;
  /** ISO timestamp the last run finished (done or error), or null. */
  finishedAt: string | null;
  /** Cover files scheduled for the current/last run. */
  total: number;
  /** Files fully processed so far (converted or skipped). */
  processed: number;
  /** Files re-encoded and replaced. */
  converted: number;
  /** Skipped: already WebP, or the re-encode would not save bytes. */
  skippedOptimal: number;
  /** Skipped: animated (GIF / APNG / animated WebP) — never flattened. */
  skippedAnimated: number;
  /** Skipped: undecodable or otherwise failed conversion. */
  skippedError: number;
  bytesBefore: number;
  bytesAfter: number;
  /** Basename of the file currently being processed, or null. */
  currentFile: string | null;
  /** Set when state is 'error' (the per-file errors are logged, not surfaced). */
  error: string | null;
}

