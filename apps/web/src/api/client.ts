import { splitDumpIntoChunks } from '../utils/bookmarkExport';
import type {
  AddBookmarkToFolderInput,
  ApiErrorCode,
  ApiResponse,
  BackupExportScope,
  BackupImportResult,
  Bookmark,
  BookmarkFolder,
  BookmarkFolderContents,
  BulkMarkChaptersReadInput,
  Chapter,
  ChapterBookmark,
  ChapterPages,
  EnqueuePrefetchInput,
  EnqueuePrefetchResult,
  PrefetchJob,
  CreateBookmarkFolderInput,
  CreateBookmarkInput,
  CreateChapterBookmarkInput,
  CreateChapterBookmarksInput,
  GenreCatalog,
  Panel,
  PanelRating,
  ReadingListEntry,
  ReadingProgress,
  ReadingProgressEntry,
  RecentlyViewedPanel,
  RecordRecentlyViewedInput,
  RemoveBookmarkFromFolderInput,
  SaveProgressInput,
  SetPanelRatingInput,
  SourceSearchResult,
  Tag,
  TagWithPanel,
  UpdateBookmarkFolderInput,
  UpsertReadingListInput,
  ReaderSettings,
  ReaderStylePreset,
  LatestPageSettings,
  SearchPageSettings,
  BookmarksPageSettings,
} from '@panel/shared';

/**
 * Typed API client. The frontend NEVER talks to the panel source directly —
 * everything goes through this client to our backend.
 *
 * Errors are thrown as `ApiClientError` carrying the server's error code so
 * the UI can react to specific failures (e.g. SOURCE_UNAVAILABLE).
 */

export class ApiClientError extends Error {
  readonly code: ApiErrorCode | 'NETWORK_ERROR';
  readonly status: number;

  constructor(code: ApiClientError['code'], message: string, status: number) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
  }
}

const BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json', ...init?.headers },
      ...init,
    });
  } catch {
    throw new ApiClientError('NETWORK_ERROR', 'Could not reach the server.', 0);
  }

  let body: ApiResponse<T>;
  try {
    body = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiClientError(
      'NETWORK_ERROR',
      'The server returned an invalid response.',
      response.status,
    );
  }

  if (!body.success) {
    throw new ApiClientError(body.error.code, body.error.message, response.status);
  }
  return body.data;
}

/**
 * Max provenance tags per `/cache/tags-size` request. Must stay in sync with
 * the server's cap in `apps/api/src/routes/images.ts` (200 per request).
 */
export const TAGS_SIZE_MAX_TAGS = 200;

/**
 * Split a tags-size payload into server-legal batches (the endpoint rejects
 * more than `TAGS_SIZE_MAX_TAGS` tags total per request). Fills each batch
 * greedily: panel ids first, then chapter ids up to the cap, so the whole
 * input is covered in the fewest requests. Exports are pure so the batching
 * behaviour is unit-testable without a server.
 */
export function buildTagsSizeBatches(
  panelTags: readonly string[],
  chapterTags: readonly string[],
): { panelTags: string[]; chapterTags: string[] }[] {
  const batches: { panelTags: string[]; chapterTags: string[] }[] = [];
  let m = 0;
  let c = 0;
  while (m < panelTags.length || c < chapterTags.length) {
    const batchPanel: string[] = [];
    const batchChapter: string[] = [];
    while (m < panelTags.length && batchPanel.length + batchChapter.length < TAGS_SIZE_MAX_TAGS) {
      batchPanel.push(panelTags[m++]!);
    }
    while (c < chapterTags.length && batchPanel.length + batchChapter.length < TAGS_SIZE_MAX_TAGS) {
      batchChapter.push(chapterTags[c++]!);
    }
    batches.push({ panelTags: batchPanel, chapterTags: batchChapter });
  }
  return batches;
}

/**
 * Merge per-tag size rows from multiple batched responses. Rows for the same
 * 8-hex tag hash are summed (a panel can appear in two batches when the
 * bookmark list straddles a batch boundary and its chapters overflow into
 * the next request); unique rows pass through unchanged.
 */
export function mergeTagSummaries(
  rows: readonly ImageCacheTagSummary[],
): ImageCacheTagSummary[] {
  const byTag = new Map<string, ImageCacheTagSummary>();
  for (const row of rows) {
    const existing = byTag.get(row.tag);
    if (existing) {
      existing.entryCount += row.entryCount;
      existing.totalBytes += row.totalBytes;
    } else {
      byTag.set(row.tag, { ...row });
    }
  }
  return Array.from(byTag.values());
}

export const api = {
  /* Panel / chapters (source-backed) */
  search: (query: string, page = 1, source?: string, genres?: readonly string[], excludes?: readonly string[]) => {
    const params = new URLSearchParams({ q: query, page: String(page) });
    if (source) params.set('source', source);
    for (const genre of genres ?? []) params.append('genre', genre);
    for (const exclude of excludes ?? []) params.append('exclude', exclude);
    return request<SourceSearchResult>(`/api/panel/search?${params.toString()}`);
  },
  latest: (page = 1, source?: string, genres?: readonly string[], excludes?: readonly string[]) => {
    const params = new URLSearchParams({ page: String(page) });
    if (source) params.set('source', source);
    for (const genre of genres ?? []) params.append('genre', genre);
    for (const exclude of excludes ?? []) params.append('exclude', exclude);
    return request<SourceSearchResult>(`/api/panel/latest?${params.toString()}`);
  },
  resolvePanelUrl: (url: string) =>
    request<{ panelId: string; source: string }>(
      `/api/panel/resolve?url=${encodeURIComponent(url)}`,
    ),
  getPanel: (id: string) => request<Panel>(`/api/panel/${encodeURIComponent(id)}`),
  /**
   * A source's full genre catalog for the filter dropdowns (site order).
   * Sources without a genre index resolve to an empty list — callers fall
   * back to the genres seen on the current result page.
   */
  getGenreList: (source: string) =>
    request<GenreCatalog>(`/api/panel/genres?source=${encodeURIComponent(source)}`),
  getChapters: (id: string) => request<Chapter[]>(`/api/panel/${encodeURIComponent(id)}/chapters`),
  getChapter: (id: string) => request<Chapter>(`/api/chapter/${encodeURIComponent(id)}`),
  getChapterPages: (id: string) =>
    request<ChapterPages>(`/api/chapter/${encodeURIComponent(id)}/pages`),

  /**
   * Enqueue a server-side cache warm: the API's background worker fetches
   * every page from upstream into its on-disk ImageCache — no image bytes
   * reach the phone. Returns immediately with the job id; the worker
   * survives page refresh / tab close. Poll `getPrefetchJobs` for live
   * progress. Idempotent per chapter while a job is still active.
   */
  prefetchChapterPages: (id: string, input?: EnqueuePrefetchInput) =>
    request<EnqueuePrefetchResult>(`/api/chapter/${encodeURIComponent(id)}/prefetch`, {
      method: 'POST',
      body: JSON.stringify({ onlyMissing: true, ...input }),
    }),

  /**
   * Every active (pending or running) prefetch job. The chapter downloader
   * polls this to rebuild its progress view — including after a page
   * refresh, when the in-memory state is gone but the jobs live on.
   */
  getPrefetchJobs: () =>
    request<{ jobs: PrefetchJob[] }>('/api/prefetch/jobs'),

  /** Single job snapshot (also returns finished jobs still in the table). */
  getPrefetchJob: (jobId: string) =>
    request<PrefetchJob>(`/api/prefetch/jobs/${encodeURIComponent(jobId)}`),

  /**
   * Latest job per chapter id (any status) as a `chapterId → job` map.
   * Chapters with no job row are absent. The details page uses this to
   * render persisted per-row badges ("12 / 37 cached") after a browser
   * restart, when the downloader's in-memory progress map is gone.
   *
   * Long series are split into server-legal chunks (≤200 ids per
   * request, same cap style as the tags-size endpoint) and merged back.
   */
  getPrefetchJobsByChapters: async (chapterIds: readonly string[]) => {
    const CHUNK = 200;
    const jobs: Record<string, PrefetchJob> = {};
    for (let i = 0; i < chapterIds.length; i += CHUNK) {
      const chunk = chapterIds.slice(i, i + CHUNK);
      if (chunk.length === 0) continue;
      const page = await request<{ jobs: Record<string, PrefetchJob> }>(
        `/api/prefetch/jobs/by-chapters?ids=${chunk.map(encodeURIComponent).join(',')}`,
      );
      Object.assign(jobs, page.jobs);
    }
    return { jobs };
  },

  /** Flip an active job to `cancelled`. The worker stops on sight. */
  cancelPrefetchJob: (jobId: string) =>
    request<{ cancelled: boolean }>(`/api/prefetch/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    }),

  /* Bookmarks */
  getBookmarks: () => request<Bookmark[]>('/api/bookmarks'),
  getBookmarkByPanel: (panelId: string) =>
    request<Bookmark | null>(`/api/bookmarks/by-panel/${encodeURIComponent(panelId)}`),
  addBookmark: (input: CreateBookmarkInput) =>
    request<Bookmark>('/api/bookmarks', { method: 'POST', body: JSON.stringify(input) }),
  removeBookmark: (id: string) =>
    request<{ id: string }>(`/api/bookmarks/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * Backup export (.sql dump backing the Bookmarks page Export dialog).
   * `scope` selects the full database (`full`) or bookmark data without
   * the reader/search/prefetch caches (`minimal`). The export endpoint
   * returns raw `application/sql`, not the JSON envelope (dumps are tens
   * of MB), so this uses a plain fetch.
   */
  exportBackup: async (scope: BackupExportScope = 'full'): Promise<string> => {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/api/backup/export?scope=${scope}`);
    } catch {
      throw new ApiClientError('NETWORK_ERROR', 'Could not reach the server.', 0);
    }
    if (!response.ok) {
      try {
        const body = (await response.json()) as ApiResponse<unknown>;
        if (!body.success) {
          throw new ApiClientError(body.error.code, body.error.message, response.status);
        }
      } catch (error) {
        if (error instanceof ApiClientError) throw error;
      }
      throw new ApiClientError('NETWORK_ERROR', 'Export failed.', response.status);
    }
    return response.text();
  },
  /**
   * Restore a dump produced by `exportBackup`. The server caps request
   * bodies at 1 MiB (`maxRequestBodySize` in `apps/api/src/index.ts`), so
   * the dump goes up in small COPY-block slices, in order (the dump is
   * already FK-ordered and the restore is idempotent, so slicing is safe
   * and a retry never duplicates). Per-table counts are summed across
   * slices. `onProgress` fires after each slice (1-based).
   */
  importBackup: async (
    dump: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<BackupImportResult> => {
    const chunks = splitDumpIntoChunks(dump);
    if (chunks.length === 0) {
      throw new ApiClientError(
        'VALIDATION_ERROR',
        'No bookmark data found in that file — is it a panel-viewer .sql export?',
        400,
      );
    }
    const total: Record<string, number> = {};
    for (let i = 0; i < chunks.length; i++) {
      let response: Response;
      try {
        response = await fetch(`${BASE_URL}/api/backup/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sql' },
          body: chunks[i],
        });
      } catch {
        throw new ApiClientError('NETWORK_ERROR', 'Could not reach the server.', 0);
      }
      let body: ApiResponse<BackupImportResult>;
      try {
        body = (await response.json()) as ApiResponse<BackupImportResult>;
      } catch {
        throw new ApiClientError(
          'NETWORK_ERROR',
          'The server returned an invalid response.',
          response.status,
        );
      }
      if (!body.success) {
        throw new ApiClientError(body.error.code, body.error.message, response.status);
      }
      for (const [table, count] of Object.entries(body.data.tables)) {
        total[table] = (total[table] ?? 0) + count;
      }
      onProgress?.(i + 1, chunks.length);
    }
    return { tables: total };
  },

  /* Recently viewed (server-side history backing the home-page rail) */
  getRecentlyViewed: () => request<RecentlyViewedPanel[]>('/api/recently-viewed'),
  recordRecentlyViewed: (input: RecordRecentlyViewedInput) =>
    request<RecentlyViewedPanel>('/api/recently-viewed', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  clearRecentlyViewed: () =>
    request<{ count: number }>('/api/recently-viewed', { method: 'DELETE' }),

  /* Chapter Bookmarks */
  getChapterBookmarks: (panelId: string) =>
    request<ChapterBookmark[]>(`/api/chapter-bookmarks?panelId=${encodeURIComponent(panelId)}`),
  addChapterBookmark: (input: CreateChapterBookmarkInput) =>
    request<ChapterBookmark>('/api/chapter-bookmarks', { method: 'POST', body: JSON.stringify(input) }),
  addChapterBookmarks: (input: CreateChapterBookmarksInput) =>
    request<ChapterBookmark[]>('/api/chapter-bookmarks/batch', { method: 'POST', body: JSON.stringify(input) }),
  removeChapterBookmark: (panelId: string, chapterId: string) =>
    request<{ panelId: string; chapterId: string }>(
      `/api/chapter-bookmarks?panelId=${encodeURIComponent(panelId)}&chapterId=${encodeURIComponent(chapterId)}`,
      { method: 'DELETE' }
    ),
  clearChapterBookmarks: (panelId: string) =>
    request<{ count: number }>(`/api/chapter-bookmarks?panelId=${encodeURIComponent(panelId)}`, { method: 'DELETE' }),

  /* Reading progress */
  getProgress: (panelId: string, chapterId: string) =>
    request<ReadingProgress | null>(
      `/api/progress/${encodeURIComponent(panelId)}/${encodeURIComponent(chapterId)}`,
    ),
  getRecentProgress: (limit = 10) =>
    request<ReadingProgressEntry[]>(`/api/progress/recent?limit=${limit}`),
  /**
   * Latest progress entry for one panel (any chapter), or null. The
   * details page's Continue button uses this instead of the capped global
   * recent list — a panel read days ago falls out of the top-N window
   * even though its progress row is intact.
   */
  getLatestProgressByPanel: (panelId: string) =>
    request<ReadingProgressEntry | null>(
      `/api/progress/by-panel/${encodeURIComponent(panelId)}/latest`,
    ),
  /**
   * Every progress entry for one panel (any chapter), oldest-last by
   * update time. Powers the details-page chapter read markers, which
   * must not depend on the capped global recent list.
   */
  getProgressForPanel: (panelId: string) =>
    request<ReadingProgressEntry[]>(
      `/api/progress/by-panel/${encodeURIComponent(panelId)}/all`,
    ),
  saveProgress: (input: SaveProgressInput) =>
    request<ReadingProgress>('/api/progress', { method: 'PUT', body: JSON.stringify(input) }),

  /**
   * Same PUT, but with `keepalive: true` so the browser finishes it even
   * while the page is unloading. Used to flush a pending (debounced)
   * progress save on `pagehide` / effect cleanup — without this, closing
   * the tab inside the debounce window silently drops the latest
   * position, and "Continue Reading" goes missing after a restart.
   * Best-effort: failures are swallowed (unload handlers can't toast).
   */
  saveProgressBeacon: (input: SaveProgressInput): Promise<ReadingProgress | null> =>
    request<ReadingProgress>('/api/progress', {
      method: 'PUT',
      body: JSON.stringify(input),
      keepalive: true,
    }).catch(() => null),
  clearProgress: (panelId: string) =>
    request<{ count: number }>(`/api/progress?panelId=${encodeURIComponent(panelId)}`, { method: 'DELETE' }),

  /**
   * Basic health info (liveness + the server's LAN address, used to build
   * shareable links that work from other devices). Best-effort.
   */
  getHealth: () =>
    request<{ status: string; lanAddress: string | null }>('/api/health'),

  /**
   * Read how many cached images are on disk, by kind (cover / chapter /
   * both — both returns the sum). Best-effort: failures are ignored by the UI.
   */
  getImageCacheSize: (what: 'cover' | 'chapter' | 'both' = 'both') =>
    request<ImageCacheSizeInfo>(
      `/api/source-image/cache?what=${what}`,
    ),

  /**
   * Purge the on-disk cache of proxied images. `what` selects covers,
   * chapter images, or both. Returns how many bytes were freed.
   */
  clearImageCache: (what: 'cover' | 'chapter' | 'both' = 'both') =>
    request<ImageCacheClearResult>(
      `/api/source-image/cache?what=${what}`,
      { method: 'DELETE' },
    ),

  /**
   * Remove LEGACY cache entries (files written before the per-panel/chapter
   * provenance-tag format existed). They are invisible to the per-tag views
   * and usually unreachable (tokenized sources rotated their URLs), so they
   * are dead weight on the disk cap. Safe: the next read re-fetches.
   */
  pruneLegacyImageCache: () =>
    request<ImageCacheClearResult>(
      '/api/source-image/cache/legacy',
      { method: 'DELETE' },
    ),

  /**
   * Per-provenance-tag breakdown for one kind. Each row has the 8-hex tag
   * hash and the size of the files that share it. The frontend correlates
   * these hashes with the tags it has sent (via the source list and the
   * recently-viewed rail) to display "which panel takes how much space".
   */
  listImageCacheTags: (kind: 'cover' | 'chapter') =>
    request<{ kind: 'cover' | 'chapter'; tags: ImageCacheTagSummary[] }>(
      `/api/source-image/cache/tags?kind=${kind}`,
    ),

  /**
   * Size of a single tag — the count + bytes that match one provenance
   * string. Used by the chapter-drill-in modal to show "this chapter is
   * X MB / Y pages" before the user decides to clear it.
   */
  getImageCacheTagSize: (kind: 'cover' | 'chapter', tag: string) =>
    request<ImageCacheSizeInfo & { kind: 'cover' | 'chapter'; tag: string }>(
      `/api/source-image/cache/tag?kind=${kind}&tag=${encodeURIComponent(tag)}`,
    ),

  /**
   * Total cached footprint (cover + chapter pages merged) for a set of panel,
   * in one logical round-trip. The client sends the panel ids (covers are
   * tagged with the panel id) plus the chapter ids (chapter pages are tagged
   * with the chapter id); the server resolves chapter ids → panel id via the
   * chapters table, because a chapter id (`mr:x~c1`) and its panel id
   * (`mr:x`) are different provenance strings with different tag hashes. One
   * row per panel — zeroed for panel with no cached files — so the
   * cache-settings "Your panel" rows can show "X MB / Y files" next to each
   * title.
   *
   * The server rejects any request with more than `TAGS_SIZE_MAX_TAGS` tags
   * total (an abuse guard), so the lists are split into batches and merged
   * back — with hundreds of bookmarks a single unbatched request used to 400
   * and made every "Your panel" row read as 0 B.
   */
  getImageCacheTagsSize: async (panelTags: readonly string[], chapterTags: readonly string[]) => {
    const batches = buildTagsSizeBatches(panelTags, chapterTags);
    if (batches.length === 0) return { sizes: [] as ImageCacheTagSummary[] };
    const results = await Promise.all(
      batches.map((batch) =>
        request<{ sizes: ImageCacheTagSummary[] }>('/api/source-image/cache/tags-size', {
          method: 'POST',
          body: JSON.stringify(batch),
        }),
      ),
    );
    return { sizes: mergeTagSummaries(results.flatMap((r) => r.sizes)) };
  },

  /**
   * Purge every file matching a provenance tag. Used to clear one source's
   * covers, one panel's chapter pages, or a single chapter. Without a tag,
   * `clearImageCache` already does kind-level clears.
   */
  clearImageCacheByTag: (
    what: 'cover' | 'chapter' | 'both',
    tag: string,
  ) =>
    request<ImageCacheClearResult>(
      `/api/source-image/cache?what=${what}&tag=${encodeURIComponent(tag)}`,
      { method: 'DELETE' },
    ),

  /**
   * Read the cache size limit. `capBytes` is the effective cap (what the
   * Usage bar and eviction enforce); `customMaxBytes` is the persisted user
   * override (`null` = automatic); `computedCapBytes` is the automatic
   * disk-relative value the override replaces while set.
   */
  getImageCacheLimit: () =>
    request<ImageCacheLimitInfo>('/api/source-image/cache/limit'),

  /**
   * Set (`maxBytes`) or clear (`null`, back to automatic) the custom cache
   * size limit. The server persists it, enforces it immediately (evicting
   * cold entries when the new cap is below current usage), and returns the
   * updated limit triple. Valid range: 64 MB – 1 TB.
   */
  setImageCacheLimit: (maxBytes: number | null) =>
    request<ImageCacheLimitInfo>('/api/source-image/cache/limit', {
      method: 'PUT',
      body: JSON.stringify({ maxBytes }),
    }),

  /**
   * Probe which 0-based page indices of a chapter are already on the server's
   * ImageCache. Used by the chapter downloader to skip pages that were
   * cached by a previous (possibly partial) run, so a retry doesn't re-fetch
   * them from upstream and re-trip the source's rate limit. Returns the
   * same shape the server documents (`{ chapterTag, totalPages, cached, missing }`).
   */
  getChapterCachedPages: (chapterTag: string, totalPages: number) =>
    request<{
      chapterTag: string;
      totalPages: number;
      cached: number[];
      missing: number[];
    }>('/api/source-image/cache/has-chapter-pages', {
      method: 'POST',
      body: JSON.stringify({ chapterTag, totalPages }),
    }),

  /**
   * Disk truth for many chapters in one logical round-trip: how many of
   * each chapter's pages are actually on disk right now. Split into
   * server-legal chunks (≤200 chapters per request, same cap style as
   * the prefetch and tags-size endpoints) and merged back into a
   * `chapterTag → { chapterTag, totalPages, cachedCount }` map.
   *
   * Used to verify "done" claims: a prefetch job row still says
   * `completed 31/31` after its files were cleared, evicted, or deleted,
   * so the row alone can't back the badge.
   */
  getChaptersDiskState: async (
    chapters: readonly { chapterTag: string; totalPages: number }[],
  ): Promise<Record<string, ChapterDiskState>> => {
    const CHUNK = 200;
    const results: Record<string, ChapterDiskState> = {};
    for (let i = 0; i < chapters.length; i += CHUNK) {
      const chunk = chapters.slice(i, i + CHUNK);
      if (chunk.length === 0) continue;
      const page = await request<{ results: Record<string, ChapterDiskState> }>(
        '/api/source-image/cache/has-chapters-pages',
        {
          method: 'POST',
          body: JSON.stringify({ chapters: chunk }),
        },
      );
      Object.assign(results, page.results);
    }
    return results;
  },

  /**
   * Bulk mark chapters read / unread (T1-6). `page` = null marks a chapter
   * unread; otherwise the chapter is recorded as read at that page.
   */
  bulkMarkChaptersRead: (input: BulkMarkChaptersReadInput) =>
    request<{ markedRead: number; markedUnread: number }>('/api/progress/bulk', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** Unread chapter counts per panel id, keyed by global panel id (T2-6). */
  /* Reading list (T1-5) — Want to Read / Reading / Completed */
  getReadingList: (status?: 'want_to_read' | 'reading' | 'completed') =>
    request<ReadingListEntry[]>(
      `/api/reading-list${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    ),
  getReadingListByPanel: (panelId: string) =>
    request<ReadingListEntry | null>(`/api/reading-list/by-panel/${encodeURIComponent(panelId)}`),
  upsertReadingList: (input: UpsertReadingListInput) =>
    request<ReadingListEntry>('/api/reading-list', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  removeReadingList: (panelId: string) =>
    request<{ panelId: string }>(`/api/reading-list/${encodeURIComponent(panelId)}`, {
      method: 'DELETE',
    }),

  /* User ratings (T3-3). */
  getPanelRating: (panelId: string) =>
    request<PanelRating | null>(`/api/ratings/by-panel/${encodeURIComponent(panelId)}`),
  setPanelRating: (input: SetPanelRatingInput) =>
    request<PanelRating>('/api/ratings', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  clearPanelRating: (panelId: string) =>
    request<{ cleared: boolean }>(`/api/ratings/${encodeURIComponent(panelId)}`, {
      method: 'DELETE',
    }),

  /* Custom tags (T3-4). */
  getTags: () => request<TagWithPanel[]>('/api/tags'),
  getTagsByPanel: (panelId: string) =>
    request<Tag[]>(`/api/tags/by-panel/${encodeURIComponent(panelId)}`),
  setPanelTags: (panelId: string, names: string[]) =>
    request<Tag[]>(`/api/tags/by-panel/${encodeURIComponent(panelId)}`, {
      method: 'PUT',
      body: JSON.stringify({ names }),
    }),
  deleteTag: (tagId: string) =>
    request<{ deleted: boolean }>(`/api/tags/${encodeURIComponent(tagId)}`, {
      method: 'DELETE',
    }),

  /* Bookmark folders / collections (T2-8). */
  getBookmarkFolders: () =>
    request<{ folders: BookmarkFolder[]; defaultId: string | null }>(
      '/api/bookmark-folders',
    ),
  getBookmarkFolderContents: (folderId: string | null) =>
    request<BookmarkFolderContents>(
      folderId
        ? `/api/bookmark-folders/${encodeURIComponent(folderId)}`
        : '/api/bookmark-folders/default',
    ),
  createBookmarkFolder: (input: CreateBookmarkFolderInput) =>
    request<BookmarkFolder>('/api/bookmark-folders', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  renameBookmarkFolder: (input: UpdateBookmarkFolderInput) =>
    request<BookmarkFolder>(`/api/bookmark-folders/${encodeURIComponent(input.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: input.name }),
    }),
  deleteBookmarkFolder: (folderId: string) =>
    request<{ deleted: boolean }>(`/api/bookmark-folders/${encodeURIComponent(folderId)}`, {
      method: 'DELETE',
    }),
  addBookmarkToFolder: (input: AddBookmarkToFolderInput) =>
    request<{ added: boolean }>(
      `/api/bookmark-folders/${encodeURIComponent(input.folderId)}/items`,
      {
        method: 'POST',
        body: JSON.stringify({ bookmarkId: input.bookmarkId }),
      },
    ),
  removeBookmarkFromFolder: (input: RemoveBookmarkFromFolderInput) =>
    request<{ removed: boolean }>(
      `/api/bookmark-folders/${encodeURIComponent(input.folderId)}/items/${encodeURIComponent(input.bookmarkId)}`,
      {
        method: 'DELETE',
      },
    ),
  getReaderSettings: () => request<ReaderSettings>('/api/reader-settings'),
  saveReaderSettings: (settings: ReaderSettings) =>
    request<ReaderSettings>('/api/reader-settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  /**
   * Named reader-style presets, persisted server-side as a JSON file
   * (`data/reader/styles.json`) — unlike the old localStorage copy they
   * survive cache clears and follow the user across browsers/devices.
   */
  getReaderStyles: () => request<ReaderStylePreset[]>('/api/reader-styles'),
  saveReaderStyles: (styles: ReaderStylePreset[]) =>
    request<ReaderStylePreset[]>('/api/reader-styles', {
      method: 'PUT',
      body: JSON.stringify(styles),
    }),
  /**
   * Latest-page preferences, persisted server-side as a JSON file
   * (`data/display/latest.json`) — survives cache clears and follows
   * the user across browsers/devices.
   */
  getLatestSettings: () => request<LatestPageSettings>('/api/latest-settings'),
  saveLatestSettings: (settings: LatestPageSettings) =>
    request<LatestPageSettings>('/api/latest-settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  /**
   * Search-page preferences, persisted server-side as a JSON file
   * (`data/display/search.json`) — independent from the latest-page
   * toggle so each list scrolls its own way.
   */
  getSearchSettings: () => request<SearchPageSettings>('/api/search-settings'),
  saveSearchSettings: (settings: SearchPageSettings) =>
    request<SearchPageSettings>('/api/search-settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  /**
   * Bookmarks-page preferences, persisted server-side as a JSON file
   * (`data/display/bookmarks.json`) — independent from the latest/search
   * toggles so each list keeps its own layout.
   */
  getBookmarksSettings: () => request<BookmarksPageSettings>('/api/bookmarks-settings'),
  saveBookmarksSettings: (settings: BookmarksPageSettings) =>
    request<BookmarksPageSettings>('/api/bookmarks-settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
};

/**
 * Disk truth for one chapter: how many of its `totalPages` pages are
 * actually cached on the server right now (see `getChaptersDiskState`).
 */
export interface ChapterDiskState {
  chapterTag: string;
  totalPages: number;
  cachedCount: number;
}

export interface ImageCacheKindInfo {
  entryCount: number;
  totalBytes: number;
}

export interface ImageCacheSizeInfo {
  cover: ImageCacheKindInfo;
  chapter: ImageCacheKindInfo;
  /** Sum of cover + chapter. */
  entryCount: number;
  totalBytes: number;
  /** Disk-relative cap (bavail*bsize * maxFraction, clamped) — lets the
      client draw a "how full is the cache" progress bar. */
  capBytes: number;
}

export interface ImageCacheTagSummary {
  /** 8-hex-char hash prefix derived from the original provenance string. */
  tag: string;
  entryCount: number;
  totalBytes: number;
}

export interface ImageCacheClearResult {
  what: string;
  cleared: number;
  totalBytes: number;
  entryCount: number;
}

export interface ImageCacheLimitInfo {
  /** Persisted user override in bytes, or null when the automatic cap applies. */
  customMaxBytes: number | null;
  /** Automatic disk-relative cap in bytes. */
  computedCapBytes: number;
  /** Effective cap in bytes (custom override while set, else computed). */
  capBytes: number;
}
