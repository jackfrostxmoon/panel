import { isDebugEnabled, log as rootLog } from '../lib/logger';
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
  CancelPrefetchBatchInput,
  CancelPrefetchBatchResult,
  SetPrefetchIntervalInput,
  SetPrefetchIntervalResult,
  Chapter,
  ChapterBookmark,
  ChapterPages,
  EnqueuePrefetchBatchInput,
  EnqueuePrefetchBatchResult,
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
  CachePageSettings,
  SourceOrderSettings,
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

/** Root of the API request log; every path group is a child of this scope. */
const apiLog = rootLog.child('api');

rootLog.info('api client ready', {
  baseUrl: BASE_URL || '(same origin)',
  apiBaseUrlOverride: BASE_URL !== '',
});

/**
 * Every API call funnels through here, so this is the single best place to
 * observe webapp traffic: one log line per request covering method, path,
 * status, wall time, payload size and outcome. Logs are tagged with a
 * per-path group (e.g. `api.health`) so the Sources page panel can filter
 * down to health/source-order traffic when that is all you care about.
 *
 * Payloads are summarised, not dumped — a latest-grid response is thousands
 * of lines. `info` carries shape metadata; the full body only rides along at
 * `debug`, which the level gate keeps off by default in production.
 */

/** Group a path into a short scope: `/health/benchmark` -> `api.health`. */
function scopeFor(method: string, path: string): string {
  const [raw] = path.split('?');
  const segments = (raw ?? '').split('/').filter(Boolean);
  const head = segments.find((s) => !s.startsWith(':'));
  return head ? `api.${head}` : `api.${method.toLowerCase()}`;
}

/** Top-level shape of a decoded payload — enough to spot a schema drift. */
function describePayload(data: unknown): Record<string, unknown> {
  if (data === null || data === undefined) return { type: String(data) };
  if (Array.isArray(data)) return { type: 'array', length: data.length };
  if (typeof data !== 'object') return { type: typeof data, value: data };
  const keys = Object.keys(data as Record<string, unknown>);
  const described: Record<string, unknown> = { type: 'object', keys };
  // Lengths for the list-bearing endpoints, which is the number you actually
  // want when comparing two polls of the same query.
  for (const key of keys) {
    const value = (data as Record<string, unknown>)[key];
    if (Array.isArray(value)) described[`${key}Count`] = value.length;
  }
  return described;
}

/** Byte size of the raw response text, before JSON.parse. */
function byteLength(text: string): number {
  // Blob is available in every browser and measures UTF-8 bytes, not UTF-16
  // code units, so one multi-byte character is not double-counted.
  return new Blob([text]).size;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const scope = scopeFor(method, path);
  const log = apiLog.child(scope);
  const startedAt = performance.now();
  const requestId = ++requestCounter;
  log.debug('request', { requestId, method, path, bodyBytes: init?.body ? byteLength(String(init.body)) : 0 });

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json', ...init?.headers },
      ...init,
    });
  } catch (error) {
    // Intentional aborts (reader closed / chapter hop cancels the JSON
    // fetch) are expected — propagate raw so TanStack Query marks the
    // query cancelled instead of failed, and stay quiet in the log.
    if (error instanceof DOMException && error.name === 'AbortError') {
      log.debug('request aborted by navigation', { requestId, method, path });
      throw error;
    }
    log.error('network failure — could not reach the server', {
      requestId,
      method,
      path,
      durationMs: Math.round(performance.now() - startedAt),
      cause: error instanceof Error ? error.message : String(error),
    });
    throw new ApiClientError('NETWORK_ERROR', 'Could not reach the server.', 0);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      log.debug('response read aborted by navigation', { requestId, method, path });
      throw error;
    }
    log.error('response body could not be read', {
      requestId,
      method,
      path,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      cause: error instanceof Error ? error.message : String(error),
    });
    throw new ApiClientError(
      'NETWORK_ERROR',
      'The server returned an invalid response.',
      response.status,
    );
  }

  const durationMs = Math.round(performance.now() - startedAt);
  const responseBytes = byteLength(text);

  let body: ApiResponse<T>;
  try {
    body = JSON.parse(text) as ApiResponse<T>;
  } catch {
    log.error('response was not valid JSON', {
      requestId,
      method,
      path,
      status: response.status,
      durationMs,
      responseBytes,
      bodyPreview: text.slice(0, 200),
    });
    throw new ApiClientError(
      'NETWORK_ERROR',
      'The server returned an invalid response.',
      response.status,
    );
  }

  if (!body.success) {
    const errorCtx = {
      requestId,
      method,
      path,
      status: response.status,
      durationMs,
      code: body.error.code,
    };
    // A 5xx or a rejected request is a genuine fault; a 4xx validation reply
    // is the app working as designed, so it stays at warn.
    if (response.status >= 500) log.error('request failed', errorCtx);
    else log.warn('request rejected', errorCtx);
    log.debug('error details', { ...errorCtx, message: body.error.message, details: body.error.details });
    throw new ApiClientError(body.error.code, body.error.message, response.status);
  }

  const payload = describePayload(body.data);
  const summary = { requestId, method, path, status: response.status, durationMs, responseBytes, ...payload };
  // Slow calls get their own line so a latency regression is visible even when
  // the level is raised above `info`.
  if (durationMs >= SLOW_REQUEST_MS) log.warn('slow request', summary);
  else log.info('request ok', summary);
  if (isDebugEnabled()) log.debug('response payload', { requestId, path, data: body.data });

  return body.data;
}

/** Requests at or above this wall time get a `warn` line. */
const SLOW_REQUEST_MS = 2_000;

/** Distinguishes concurrent requests in the log when several are in flight. */
let requestCounter = 0;

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
  getChapterPages: (id: string, signal?: AbortSignal, mkServer?: string) => {
    const params = new URLSearchParams();
    if (mkServer) params.set('mkServer', mkServer);
    const query = params.toString();
    return request<ChapterPages>(`/api/chapter/${encodeURIComponent(id)}/pages${query ? '?' + query : ''}`, { signal });
  },

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
   * Enqueue many chapters in one round-trip. The old client fired one
   * POST per chapter sequentially, so "Download all" spent seconds just
   * enqueuing before the first page fetched. Batches are capped at
   * `BULK_CHAPTER_LIMIT` server-side — callers with longer lists chunk.
   */
  prefetchChaptersBatch: (chapters: readonly string[], input?: Omit<EnqueuePrefetchBatchInput, 'chapters'>) =>
    request<EnqueuePrefetchBatchResult>('/api/prefetch/jobs/batch', {
      method: 'POST',
      body: JSON.stringify({ chapters: [...chapters], onlyMissing: true, ...input }),
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

  /**
   * Flip many jobs in one round-trip. "Stop downloads" used to fire one
   * POST per chapter and wait behind the browser's connection limit; one
   * POST stops the whole batch.
   */
  cancelPrefetchJobs: (jobIds: readonly string[]) =>
    request<CancelPrefetchBatchResult>('/api/prefetch/jobs/cancel-many', {
      method: 'POST',
      body: JSON.stringify({ jobIds: [...jobIds] } satisfies CancelPrefetchBatchInput),
    }),

  /**
   * Retarget the pacing of in-flight jobs (chunked like the other bulk
   * endpoints). The details page sends this when the user changes the
   * "wait between chapters" preset mid-run so the next chapter transition
   * honours the new value instead of the interval snapshotted at enqueue.
   */
  setPrefetchJobsInterval: async (jobIds: readonly string[], intervalMs: number) => {
    const CHUNK = 200;
    let updated = 0;
    for (let i = 0; i < jobIds.length; i += CHUNK) {
      const chunk = jobIds.slice(i, i + CHUNK);
      if (chunk.length === 0) continue;
      const page = await request<SetPrefetchIntervalResult>('/api/prefetch/jobs/interval', {
        method: 'POST',
        body: JSON.stringify({ jobIds: [...chunk], intervalMs } satisfies SetPrefetchIntervalInput),
      });
      updated += page.updated;
    }
    return { updated };
  },

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
   * Detailed health incl. per-source rolling stats. The image counters back
   * the source-health banner: `imageBlocked` (allowlist rejections) is the
   * signature of a CDN move, `imageErrors` counts recent image failures.
   * Best-effort: failures are ignored by the UI.
   */
  getDetailedHealth: () =>
    request<{ status: string; sources: DetailedSourceHealth[] }>('/api/health/detailed'),

  /**
   * Read how many cached images are on disk, by kind (cover / chapter /
   * both — both returns the sum). Best-effort: failures are ignored by the UI.
   */
  getImageCacheSize: (what: 'cover' | 'chapter' | 'both' = 'both', signal?: AbortSignal) =>
    request<ImageCacheSizeInfo>(
      `/api/source-image/cache?what=${what}`,
      { signal },
    ),

  /**
   * Live fault check across sources. Probes each enabled source with a
   * direct `latest(1)` (bypassing the server's listing cache) and reports
   * per-source latency / item count / error. `source` restricts the run
   * to one source (per-row retry). Manual trigger only — never polled.
   */
  benchmarkSources: (source?: string) =>
    request<{ checkedAt: string; results: SourceBenchmarkResult[] }>(
      `/api/health/benchmark${source ? `?source=${encodeURIComponent(source)}` : ''}`,
      { method: 'POST' },
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
  listImageCacheTags: (kind: 'cover' | 'chapter', signal?: AbortSignal) =>
    request<{ kind: 'cover' | 'chapter'; tags: ImageCacheTagSummary[] }>(
      `/api/source-image/cache/tags?kind=${kind}`,
      { signal },
    ),

  /**
   * Size of a single tag — the count + bytes that match one provenance
   * string. Used by the chapter-drill-in modal to show "this chapter is
   * X MB / Y pages" before the user decides to clear it.
   */
  getImageCacheTagSize: (kind: 'cover' | 'chapter', tag: string, signal?: AbortSignal) =>
    request<ImageCacheSizeInfo & { kind: 'cover' | 'chapter'; tag: string }>(
      `/api/source-image/cache/tag?kind=${kind}&tag=${encodeURIComponent(tag)}`,
      { signal },
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
  getImageCacheTagsSize: async (
    panelTags: readonly string[],
    chapterTags: readonly string[],
    signal?: AbortSignal,
  ) => {
    const batches = buildTagsSizeBatches(panelTags, chapterTags);
    if (batches.length === 0) return { sizes: [] as ImageCacheTagSummary[] };
    // Sequential so Back navigation aborts between batches instead of
    // leaving N walks running on the server while the homepage loads.
    const all: ImageCacheTagSummary[] = [];
    for (const batch of batches) {
      signal?.throwIfAborted();
      const page = await request<{ sizes: ImageCacheTagSummary[] }>(
        '/api/source-image/cache/tags-size',
        {
          method: 'POST',
          body: JSON.stringify(batch),
          signal,
        },
      );
      all.push(...page.sizes);
    }
    return { sizes: mergeTagSummaries(all) };
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
   * Read the upstream-fetch concurrency. `concurrency` is the effective
   * value (what the proxy semaphore enforces); `customConcurrency` is the
   * persisted user override (`null` = env default); `defaultConcurrency`
   * is the startup value; `min`/`max` bound the settable range.
   */
  getImageConcurrency: () =>
    request<ImageConcurrencyInfo>('/api/source-image/cache/concurrency'),

  /**
   * Set (`concurrency`) or clear (`null`, back to the env default) the
   * upstream-fetch concurrency. Persisted server-side, enforced
   * immediately, and returned as the updated info shape. Valid range: 1–32.
   */
  setImageConcurrency: (concurrency: number | null) =>
    request<ImageConcurrencyInfo>('/api/source-image/cache/concurrency', {
      method: 'PUT',
      body: JSON.stringify({ concurrency }),
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
  /**
   * Cache-page preferences, persisted server-side as a JSON file
   * (`data/display/cache.json`) — live background polling vs manual
   * refresh, shared across browsers/devices like the other page toggles.
   */
  getCacheSettings: () => request<CachePageSettings>('/api/cache-settings'),
  saveCacheSettings: (settings: CachePageSettings) =>
    request<CachePageSettings>('/api/cache-settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  /** Manual flush of the in-memory TTL cache and image index. */
  flushMemory: () =>
    request<{ flushed: boolean; panelCacheCleared: boolean; imageIndexDropped: boolean; memoryBeforeBytes?: number; memoryAfterBytes?: number }>('/api/memory-flush', { method: 'POST' }),
  /**
   * Source display order, persisted server-side as a JSON file
   * (`data/display/sources.json`) — survives cache clears and follows
   * the user across browsers/devices like the other display settings.
   */
  getSourceOrder: () => request<SourceOrderSettings>('/api/source-order'),
  saveSourceOrder: (settings: SourceOrderSettings) =>
    request<SourceOrderSettings>('/api/source-order', {
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

/**
 * Upstream-fetch concurrency for the image proxy (covers + chapter pages).
 */
export interface ImageConcurrencyInfo {
  /** Persisted user override, or null when the env default applies. */
  customConcurrency: number | null;
  /** Startup (`IMAGE_PROXY_CONCURRENCY`) value. */
  defaultConcurrency: number;
  /** Effective value (custom override while set, else default). */
  concurrency: number;
  /** Settable range bounds. */
  min: number;
  max: number;
}

/**
 * One row of the live source benchmark (`POST /api/health/benchmark`).
 * Mirrors `SourceBenchmarkResult` in `apps/api/src/routes/health.ts`.
 */
export interface SourceBenchmarkResult {
  name: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
  ok: boolean;
  latencyMs: number | null;
  items: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  checkedAt: string;
}

/**
 * One entry of the per-source list in `/api/health/detailed`. The image
 * counters are rolling-window signals surfaced on the Sources page.
 */
export interface DetailedSourceHealth {
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
