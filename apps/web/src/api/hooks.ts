import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer } from 'react';
import type {
  AddBookmarkToFolderInput,
  Bookmark,
  BookmarkFolder,
  BookmarkFolderContents,
  BulkMarkChaptersReadInput,
  Chapter,
  ChapterBookmark,
  ChapterPages,
  CreateBookmarkFolderInput,
  CreateBookmarkInput,
  CreateChapterBookmarkInput,
  CreateChapterBookmarksInput,
  GenreCatalog,
  LatestPageSettings,
  SearchPageSettings,
  BookmarksPageSettings,
  CachePageSettings,
  SourceOrderSettings,
  Panel,
  PanelRating,
  PrefetchJob,
  ReadingListEntry,
  ReadingProgress,
  ReadingProgressEntry,
  RecentlyViewedPanel,
  RecordRecentlyViewedInput,
  RemoveBookmarkFromFolderInput,
  SaveProgressInput,
  SourceSearchResult,
  SetPanelRatingInput,
  Tag,
  TagWithPanel,
  UpdateBookmarkFolderInput,
  UpsertReadingListInput,
} from '@panel/shared';
import { log as rootLog } from '../lib/logger';
import { ApiClientError } from './client';
import {
  api,
  type ChapterDiskState,
  type DetailedSourceHealth,
  type SourceBenchmarkResult,
  type ImageCacheSizeInfo,
  type ImageConcurrencyInfo,
  type ImageCacheKindInfo,
  type ImageCacheClearResult,
  type ImageCacheLimitInfo,
  type ImageCacheTagSummary,
} from './client';

/**
 * TanStack Query hooks — all server state lives here. Query keys are
 * centralized so mutations can invalidate exactly the right caches.
 */

/** Stable key fragment for a genre list (sorted, so re-renders with a new array reference reuse the cache). */
function genreKey(labels: readonly string[] | undefined): string {
  return [...(labels ?? [])].sort((a, b) => a.localeCompare(b)).join('|');
}

export const queryKeys = {
  search: (q: string, page: number, source?: string, genres?: readonly string[], excludes?: readonly string[]) =>
    ['search', q, page, source ?? 'all', genreKey(genres), genreKey(excludes)] as const,
  latest: (page: number, source?: string, genres?: readonly string[], excludes?: readonly string[]) =>
    ['latest', page, source ?? 'all', genreKey(genres), genreKey(excludes)] as const,
  panel: (id: string) => ['panel', id] as const,
  chapters: (id: string) => ['chapters', id] as const,
  chapterPages: (id: string) => ['chapterPages', id] as const,
  bookmarks: () => ['bookmarks'] as const,
  bookmarkByPanel: (panelId: string) => ['bookmarks', 'by-panel', panelId] as const,
  /** Server-side recently-viewed history backing the home-page rail. */
  recentlyViewed: () => ['recently-viewed'] as const,
  chapterBookmarks: (panelId: string) => ['chapterBookmarks', panelId] as const,
  progress: (panelId: string, chapterId: string) => ['progress', panelId, chapterId] as const,
  recentProgress: () => ['progress', 'recent'] as const,
  progressLatestByPanel: (panelId: string) => ['progress', 'latest-by-panel', panelId] as const,
  progressByPanel: (panelId: string) => ['progress', 'by-panel', panelId] as const,
  readingList: (status?: 'want_to_read' | 'reading' | 'completed') =>
    ['reading-list', status ?? 'all'] as const,
  readingListByPanel: (panelId: string) => ['reading-list', 'by-panel', panelId] as const,
  bookmarkFolders: () => ['bookmark-folders'] as const,
  bookmarkFolderContents: (folderId: string | null) =>
    ['bookmark-folders', 'contents', folderId ?? 'default'] as const,
  panelRating: (panelId: string) => ['rating', panelId] as const,
  tags: () => ['tags'] as const,
  tagsByPanel: (panelId: string) => ['tags', 'by-panel', panelId] as const,
  imageCacheStats: () => ['imageCache', 'stats'] as const,
  /** Custom size-limit override for the on-disk image cache. */
  imageCacheLimit: () => ['imageCache', 'limit'] as const,
  /** Upstream-fetch concurrency override for the image proxy. */
  imageConcurrency: () => ['imageCache', 'concurrency'] as const,
  /** Per-panel totals (cover + chapter pages merged) for the "Your panel"
      * rows. The key includes the sorted chapter-tag list as well as the
      * panel-id list: the server only attributes chapter pages to their
      * panel when the client sends the chapter ids, so a cache built with
      * `chapterTags=[]` (e.g. before any chapter has been opened this
      * session) would otherwise be reused after a chapter opens and the
      * "Your panel" rows would silently read as 0 B for the freshly-opened
      * panel's chapter footprint. Sorting keeps the key stable across
      * re-renders that produce a new array reference for the same ids. */
  imageCacheTagsSize: (panelIds: readonly string[], chapterTags: readonly string[]) =>
    [
      'imageCache',
      'tagsSize',
      [...panelIds].sort().join('|'),
      [...chapterTags].sort().join('|'),
    ] as const,
  /** Latest-page preferences persisted to `data/display/latest.json`. */
  latestSettings: () => ['latest-settings'] as const,
  /** Search-page preferences persisted to `data/display/search.json`. */
  searchSettings: () => ['search-settings'] as const,
  /** Bookmarks-page preferences persisted to `data/display/bookmarks.json`. */
  bookmarksSettings: () => ['bookmarks-settings'] as const,
  /** Cache-page preferences persisted to `data/display/cache.json`. */
  cacheSettings: () => ['cache-settings'] as const,
  /** Source display order persisted to `data/display/sources.json`. */
  sourceOrder: () => ['source-order'] as const,
  /** A source's full genre catalog for the filter dropdowns. */
  genreCatalog: (source: string) => ['genres', 'catalog', source] as const,
  healthDetailed: () => ['health', 'detailed'] as const,
  /** Latest prefetch job per chapter id (any status). Sorted ids keep the
   *  key stable across re-renders that produce a new array reference. */
  prefetchByChapters: (chapterIds: readonly string[]) =>
    ['prefetch', 'by-chapters', [...chapterIds].sort().join('|')] as const,
};

type QueryOpts<T> = Omit<UseQueryOptions<T, ApiClientError>, 'queryKey' | 'queryFn'>;

/**
 * Scoped loggers for the queries and mutations the Sources page leans on.
 * Each lifecycle step (fetch start/ok/fail, mutation save/fail) is traced so a
 * stalled poll or a lost order write is visible without opening devtools.
 */
const healthLog = rootLog.child('query.health');
const benchmarkLog = rootLog.child('query.benchmark');
const orderLog = rootLog.child('query.sourceOrder');

export function useSearch(
  query: string,
  page = 1,
  source?: string,
  genres?: readonly string[],
  excludes?: readonly string[],
  opts?: QueryOpts<SourceSearchResult>,
) {
  return useQuery<SourceSearchResult, ApiClientError>({
    queryKey: queryKeys.search(query, page, source, genres, excludes),
    queryFn: () => api.search(query, page, source, genres, excludes),
    enabled: query.trim().length > 0,
    staleTime: 60_000,
    ...opts,
  });
}

export function useLatest(
  page = 1,
  source?: string,
  genres?: readonly string[],
  excludes?: readonly string[],
  opts?: QueryOpts<SourceSearchResult>,
) {
  return useQuery<SourceSearchResult, ApiClientError>({
    queryKey: queryKeys.latest(page, source, genres, excludes),
    queryFn: () => api.latest(page, source, genres, excludes),
    staleTime: 60_000,
    ...opts,
  });
}

/**
 * Source-health telemetry (`/api/health/detailed`). Best-effort
 * diagnostics: polled in the background, never retries (a down API must
 * not spin), and failures are ignored by the UI. Backs the Sources page.
 */
export function useSourceImageHealth(opts?: QueryOpts<{ status: string; sources: DetailedSourceHealth[] }>) {
  return useQuery<{ status: string; sources: DetailedSourceHealth[] }, ApiClientError>({
    queryKey: queryKeys.healthDetailed(),
    // This query polls every 60s and drives the Sources page, so each fetch is
    // traced: which pass it was (initial vs background refetch) and what the
    // payload looked like. A failed poll is expected when the API is down, so
    // it logs at warn rather than error — the UI already tolerates it.
    queryFn: async ({ meta }) => {
      const phase = meta?.['phase'] === 'background' ? 'refetch' : 'initial';
      healthLog.debug('fetch start', { phase });
      try {
        const data = await api.getDetailedHealth();
        healthLog.debug('fetch ok', {
          phase,
          status: data.status,
          sourceCount: data.sources.length,
          enabledCount: data.sources.filter((s) => s.enabled).length,
        });
        return data;
      } catch (error) {
        healthLog.warn('fetch failed', {
          phase,
          code: error instanceof ApiClientError ? error.code : 'UNKNOWN',
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    ...opts,
  });
}

/**
 * Live per-source fault check (`POST /api/health/benchmark`). Manual
 * trigger only — the probe hits every enabled source's live listing, so
 * it must never poll in the background.
 */
export function useBenchmarkSources() {
  return useMutation<{ checkedAt: string; results: SourceBenchmarkResult[] }, ApiClientError, string | undefined>({
    // One probe per mutation (the Sources page runs them sequentially). The
    // per-row outcome is logged here so the trace survives even if the page
    // unmounts mid-run.
    mutationFn: async (source) => {
      const startedAt = performance.now();
      benchmarkLog.debug('probe start', { source: source ?? '(all)' });
      try {
        const data = await api.benchmarkSources(source);
        for (const row of data.results) {
          const summary = {
            source: row.name,
            enabled: row.enabled,
            ok: row.ok,
            latencyMs: row.latencyMs,
            items: row.items,
            errorCode: row.errorCode,
          };
          if (row.ok) benchmarkLog.info('probe ok', summary);
          else benchmarkLog.warn('probe down', { ...summary, errorMessage: row.errorMessage });
        }
        return data;
      } catch (error) {
        benchmarkLog.error('probe request failed', {
          source: source ?? '(all)',
          durationMs: Math.round(performance.now() - startedAt),
          code: error instanceof ApiClientError ? error.code : 'UNKNOWN',
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    retry: false,
  });
}

/**
 * Latest-page preferences (`data/display/latest.json` on the server).
 * OFF by default — classic Previous/Next pagination until the user opts in.
 */
export function useLatestSettings(opts?: QueryOpts<LatestPageSettings>) {
  return useQuery<LatestPageSettings, ApiClientError>({
    queryKey: queryKeys.latestSettings(),
    queryFn: () => api.getLatestSettings(),
    staleTime: 60_000,
    ...opts,
  });
}

/** Persist the infinite-scroll toggle; refreshes the settings query on success. */
export function useSaveLatestSettings() {
  const queryClient = useQueryClient();
  return useMutation<LatestPageSettings, ApiClientError, LatestPageSettings>({
    mutationFn: (settings) => api.saveLatestSettings(settings),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.latestSettings(), data);
    },
  });
}

/**
 * Search-page preferences (`data/display/search.json` on the server).
 * OFF by default — classic Previous/Next pagination until the user opts in.
 */
export function useSearchSettings(opts?: QueryOpts<SearchPageSettings>) {
  return useQuery<SearchPageSettings, ApiClientError>({
    queryKey: queryKeys.searchSettings(),
    queryFn: () => api.getSearchSettings(),
    staleTime: 60_000,
    ...opts,
  });
}

/** Persist the infinite-scroll toggle; refreshes the settings query on success. */
export function useSaveSearchSettings() {
  const queryClient = useQueryClient();
  return useMutation<SearchPageSettings, ApiClientError, SearchPageSettings>({
    mutationFn: (settings) => api.saveSearchSettings(settings),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.searchSettings(), data);
    },
  });
}

/**
 * Bookmarks-page preferences (`data/display/bookmarks.json` on the server).
 * Cards layout by default — the compact list shows a cover preview on
 * title hover instead.
 */
export function useBookmarksSettings(opts?: QueryOpts<BookmarksPageSettings>) {
  return useQuery<BookmarksPageSettings, ApiClientError>({
    queryKey: queryKeys.bookmarksSettings(),
    queryFn: () => api.getBookmarksSettings(),
    staleTime: 60_000,
    ...opts,
  });
}

/** Persist the bookmarks card/list layout; refreshes the settings query on success. */
export function useSaveBookmarksSettings() {
  const queryClient = useQueryClient();
  return useMutation<BookmarksPageSettings, ApiClientError, BookmarksPageSettings>({
    mutationFn: (settings) => api.saveBookmarksSettings(settings),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.bookmarksSettings(), data);
    },
  });
}

/**
 * Cache-page preferences (`data/display/cache.json` on the server).
 * Manual refresh by default — live mode polls the stats/size queries.
 */
export function useCacheSettings(opts?: QueryOpts<CachePageSettings>) {
  return useQuery<CachePageSettings, ApiClientError>({
    queryKey: queryKeys.cacheSettings(),
    queryFn: () => api.getCacheSettings(),
    staleTime: 60_000,
    ...opts,
  });
}

/** Persist the live-refresh toggle; refreshes the settings query on success. */
export function useSaveCacheSettings() {
  const queryClient = useQueryClient();
  return useMutation<CachePageSettings, ApiClientError, CachePageSettings>({
    mutationFn: (settings) => api.saveCacheSettings(settings),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.cacheSettings(), data);
    },
  });
}

/**
 * Source display order (`data/display/sources.json` on the server).
 * Canonical order by default — the Sources page editor writes here.
 */
export function useSourceOrder(opts?: QueryOpts<SourceOrderSettings>) {
  return useQuery<SourceOrderSettings, ApiClientError>({
    queryKey: queryKeys.sourceOrder(),
    queryFn: async () => {
      orderLog.debug('load saved order');
      try {
        const data = await api.getSourceOrder();
        orderLog.debug('loaded saved order', {
          order: data.order,
          custom: data.order.length > 0,
        });
        return data;
      } catch (error) {
        orderLog.warn('could not load saved order — falling back to built-in order', {
          code: error instanceof ApiClientError ? error.code : 'UNKNOWN',
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    staleTime: 60_000,
    ...opts,
  });
}

/** Persist the source order; refreshes the settings query on success. */
export function useSaveSourceOrder() {
  const queryClient = useQueryClient();
  return useMutation<SourceOrderSettings, ApiClientError, SourceOrderSettings>({
    mutationFn: async (settings) => {
      orderLog.info('saving order', {
        order: settings.order,
        count: settings.order.length,
        reset: settings.order.length === 0,
      });
      try {
        const saved = await api.saveSourceOrder(settings);
        orderLog.info('order saved', { order: saved.order });
        return saved;
      } catch (error) {
        orderLog.error('order save failed', {
          requested: settings.order,
          code: error instanceof ApiClientError ? error.code : 'UNKNOWN',
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.sourceOrder(), data);
      orderLog.debug('source-order query cache updated', { order: data.order });
    },
  });
}

/**
 * A source's full genre catalog for the filter dropdowns. Empty when the
 * source publishes no genre index (or while loading) — callers fall back
 * to the genres seen on the current result page. Cached client-side for
 * hours; the server caches per source for a day.
 */
export function useGenreList(source: string, opts?: QueryOpts<GenreCatalog>) {
  return useQuery<GenreCatalog, ApiClientError>({
    queryKey: queryKeys.genreCatalog(source),
    queryFn: () => api.getGenreList(source),
    enabled: source.trim().length > 0,
    staleTime: 6 * 60 * 60_000,
    ...opts,
  });
}

/** Resolve a pasted source page url ("https://hiperdex.com/manga/…") to a panel id. */
export function useResolvePanelUrl() {
  return useMutation<{ panelId: string; source: string }, ApiClientError, string>({
    mutationFn: (url) => api.resolvePanelUrl(url),
  });
}

export function usePanel(id: string, opts?: QueryOpts<Panel>) {
  return useQuery<Panel, ApiClientError>({
    queryKey: queryKeys.panel(id),
    queryFn: () => api.getPanel(id),
    staleTime: 5 * 60_000,
    refetchOnMount: 'always',
    ...opts,
  });
}

export function useChapters(id: string, opts?: QueryOpts<Chapter[]>) {
  return useQuery<Chapter[], ApiClientError>({
    queryKey: queryKeys.chapters(id),
    queryFn: () => api.getChapters(id),
    staleTime: 5 * 60_000,
    refetchOnMount: 'always',
    ...opts,
  });
}

export function useChapterPages(id: string, opts?: QueryOpts<ChapterPages>) {
  return useQuery<ChapterPages, ApiClientError>({
    queryKey: queryKeys.chapterPages(id),
    queryFn: () => api.getChapterPages(id),
    staleTime: 30 * 60_000,
    refetchOnMount: 'always',
    ...opts,
  });
}

/**
 * Background prefetch for the next chapter (T3-1). The API caches chapter
 * page payloads server-side (and persists them to `chapter_pages`), so a
 * prefetched chapter turns instantly when the user reaches the end of the
 * current one — and stays available offline. Callers should skip this in
 * data-saver mode.
 */
export function usePrefetchChapterPages() {
  const queryClient = useQueryClient();
  return useCallback((chapterId: string) => {
    // Skip if it's already in the cache (any state) — no duplicate work.
    if (queryClient.getQueryData(queryKeys.chapterPages(chapterId))) return;
    void queryClient.prefetchQuery({
      queryKey: queryKeys.chapterPages(chapterId),
      queryFn: () => api.getChapterPages(chapterId),
      staleTime: 30 * 60_000,
    });
  }, [queryClient]);
}

export function useBookmarks(opts?: QueryOpts<Bookmark[]>) {
  return useQuery<Bookmark[], ApiClientError>({
    queryKey: queryKeys.bookmarks(),
    queryFn: () => api.getBookmarks(),
    ...opts,
  });
}

export function useBookmarkByPanel(panelId: string, opts?: QueryOpts<Bookmark | null>) {
  return useQuery<Bookmark | null, ApiClientError>({
    queryKey: queryKeys.bookmarkByPanel(panelId),
    queryFn: () => api.getBookmarkByPanel(panelId),
    ...opts,
  });
}

export function useChapterBookmarks(panelId: string, opts?: QueryOpts<ChapterBookmark[]>) {
  return useQuery<ChapterBookmark[], ApiClientError>({
    queryKey: queryKeys.chapterBookmarks(panelId),
    queryFn: () => api.getChapterBookmarks(panelId),
    enabled: panelId.length > 0,
    ...opts,
  });
}

export function useProgress(
  panelId: string,
  chapterId: string,
  opts?: QueryOpts<ReadingProgress | null>,
) {
  return useQuery<ReadingProgress | null, ApiClientError>({
    queryKey: queryKeys.progress(panelId, chapterId),
    queryFn: () => api.getProgress(panelId, chapterId),
    staleTime: 30_000,
    ...opts,
  });
}

export function useRecentProgress(opts?: QueryOpts<ReadingProgressEntry[]>) {
  return useQuery<ReadingProgressEntry[], ApiClientError>({
    queryKey: queryKeys.recentProgress(),
    queryFn: () => api.getRecentProgress(),
    ...opts,
  });
}

/**
 * Server-side recently-viewed history (home-page rail). Falls back to the
 * localStorage rail in the page component while loading or offline.
 */
export function useRecentlyViewed(opts?: QueryOpts<RecentlyViewedPanel[]>) {
  return useQuery<RecentlyViewedPanel[], ApiClientError>({
    queryKey: queryKeys.recentlyViewed(),
    queryFn: () => api.getRecentlyViewed(),
    staleTime: 30_000,
    ...opts,
  });
}

/**
 * Latest progress entry for one panel (any chapter), or null. Backs the
 * details page's Continue button, which must not depend on the capped
 * global recent list.
 */
export function useLatestProgressForPanel(panelId: string, opts?: QueryOpts<ReadingProgressEntry | null>) {
  return useQuery<ReadingProgressEntry | null, ApiClientError>({
    queryKey: queryKeys.progressLatestByPanel(panelId),
    queryFn: () => api.getLatestProgressByPanel(panelId),
    enabled: panelId.length > 0,
    staleTime: 30_000,
    ...opts,
  });
}

/**
 * Every progress entry for one panel (any chapter). Backs the details
 * page's chapter read markers — unlike the capped global recent list,
 * this survives after the panel falls out of the top-N window.
 */
export function useProgressForPanel(panelId: string, opts?: QueryOpts<ReadingProgressEntry[]>) {
  return useQuery<ReadingProgressEntry[], ApiClientError>({
    queryKey: queryKeys.progressByPanel(panelId),
    queryFn: () => api.getProgressForPanel(panelId),
    enabled: panelId.length > 0,
    staleTime: 30_000,
    ...opts,
  });
}

/* ------------------------------------------------------------------------ */
/* Mutations                                                                 */
/* ------------------------------------------------------------------------ */

export function useAddBookmark() {
  const queryClient = useQueryClient();
  return useMutation<Bookmark, ApiClientError, CreateBookmarkInput>({
    mutationFn: (input) => api.addBookmark(input),
    onSuccess: (bookmark) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarks() });
      queryClient.invalidateQueries({ queryKey: ['bookmark-folders', 'contents'] });
      queryClient.setQueryData(queryKeys.bookmarkByPanel(bookmark.panelId), bookmark);
    },
  });
}

export function useRemoveBookmark() {
  const queryClient = useQueryClient();
  return useMutation<{ id: string }, ApiClientError, { id: string; panelId: string }>({
    mutationFn: ({ id }) => api.removeBookmark(id),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarks() });
      queryClient.invalidateQueries({ queryKey: ['bookmark-folders', 'contents'] });
      queryClient.setQueryData(queryKeys.bookmarkByPanel(variables.panelId), null);
    },
  });
}

/** Fire-and-forget from the details page — the local rail covers offline. */
export function useRecordRecentlyViewed() {
  const queryClient = useQueryClient();
  return useMutation<RecentlyViewedPanel, ApiClientError, RecordRecentlyViewedInput>({
    mutationFn: (input) => api.recordRecentlyViewed(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.recentlyViewed() });
    },
  });
}

export function useClearRecentlyViewed() {
  const queryClient = useQueryClient();
  return useMutation<{ count: number }, ApiClientError, void>({
    mutationFn: () => api.clearRecentlyViewed(),
    onSuccess: () => {
      queryClient.setQueryData<RecentlyViewedPanel[]>(queryKeys.recentlyViewed(), []);
    },
  });
}

export function useAddChapterBookmark() {
  const queryClient = useQueryClient();
  return useMutation<ChapterBookmark, ApiClientError, CreateChapterBookmarkInput>({
    mutationFn: (input) => api.addChapterBookmark(input),
    onSuccess: (bookmark) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chapterBookmarks(bookmark.panelId) });
    },
  });
}

export function useAddChapterBookmarks() {
  const queryClient = useQueryClient();
  return useMutation<ChapterBookmark[], ApiClientError, CreateChapterBookmarksInput>({
    mutationFn: (input) => api.addChapterBookmarks(input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chapterBookmarks(variables.panelId) });
    },
  });
}

export function useRemoveChapterBookmark() {
  const queryClient = useQueryClient();
  return useMutation<{ panelId: string; chapterId: string }, ApiClientError, { panelId: string; chapterId: string }>({
    mutationFn: ({ panelId, chapterId }) => api.removeChapterBookmark(panelId, chapterId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chapterBookmarks(variables.panelId) });
    },
  });
}

export function useClearChapterBookmarks() {
  const queryClient = useQueryClient();
  return useMutation<{ count: number }, ApiClientError, string>({
    mutationFn: (panelId) => api.clearChapterBookmarks(panelId),
    onSuccess: (_data, panelId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chapterBookmarks(panelId) });
    },
  });
}

export function useClearProgress() {
  const queryClient = useQueryClient();
  return useMutation<{ count: number }, ApiClientError, string>({
    mutationFn: (panelId) => api.clearProgress(panelId),
    onSuccess: (_data, panelId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.recentProgress() });
      queryClient.invalidateQueries({ queryKey: queryKeys.progressLatestByPanel(panelId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.progressByPanel(panelId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarks() });
      // The bookmarks page default view renders folder contents (which
      // joins progress) — without this it keeps showing the cleared
      // position until a manual refetch.
      queryClient.invalidateQueries({ queryKey: ['bookmark-folders', 'contents'] });
    },
  });
}

export function useSaveProgress() {
  const queryClient = useQueryClient();
  return useMutation<ReadingProgress, ApiClientError, SaveProgressInput>({
    mutationFn: (input) => api.saveProgress(input),
    onSuccess: (progress) => {
      queryClient.setQueryData(queryKeys.progress(progress.panelId, progress.chapterId), progress);
      // Keep the home "continue reading" rail fresh.
      queryClient.invalidateQueries({ queryKey: queryKeys.recentProgress() });
      queryClient.invalidateQueries({ queryKey: queryKeys.progressLatestByPanel(progress.panelId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.progressByPanel(progress.panelId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarks() });
      // Same folder-contents staleness as above: the card in the folder
      // view would keep showing the old position / "Not started yet".
      queryClient.invalidateQueries({ queryKey: ['bookmark-folders', 'contents'] });
    },
  });
}

/* ---------------------------------------------------------------------- */
/* Reading list (T1-5)                                                     */
/* ---------------------------------------------------------------------- */

export function useReadingList(
  status?: 'want_to_read' | 'reading' | 'completed',
  opts?: QueryOpts<ReadingListEntry[]>,
) {
  return useQuery<ReadingListEntry[], ApiClientError>({
    queryKey: queryKeys.readingList(status),
    queryFn: () => api.getReadingList(status),
    staleTime: 60_000,
    ...opts,
  });
}

export function useReadingListByPanel(panelId: string, opts?: QueryOpts<ReadingListEntry | null>) {
  return useQuery<ReadingListEntry | null, ApiClientError>({
    queryKey: queryKeys.readingListByPanel(panelId),
    queryFn: () => api.getReadingListByPanel(panelId),
    staleTime: 60_000,
    ...opts,
  });
}

export function useUpsertReadingList() {
  const queryClient = useQueryClient();
  return useMutation<ReadingListEntry, ApiClientError, UpsertReadingListInput>({
    mutationFn: (input) => api.upsertReadingList(input),
    onSuccess: (entry) => {
      queryClient.setQueryData(queryKeys.readingListByPanel(entry.panelId), entry);
      queryClient.invalidateQueries({ queryKey: queryKeys.readingList() });
    },
  });
}

export function useRemoveReadingList() {
  const queryClient = useQueryClient();
  return useMutation<{ panelId: string }, ApiClientError, string>({
    mutationFn: (panelId) => api.removeReadingList(panelId),
    onSuccess: (_data, panelId) => {
      queryClient.setQueryData(queryKeys.readingListByPanel(panelId), null);
      queryClient.invalidateQueries({ queryKey: queryKeys.readingList() });
    },
  });
}

/* ---------------------------------------------------------------------- */
/* ---------------------------------------------------------------------- */
/* Bulk chapter mark read / unread (T1-6)                                  */
/* ---------------------------------------------------------------------- */

export function useBulkMarkChaptersRead() {
  const queryClient = useQueryClient();
  return useMutation<{ markedRead: number; markedUnread: number }, ApiClientError, BulkMarkChaptersReadInput>({
    mutationFn: (input) => api.bulkMarkChaptersRead(input),
    onSuccess: (_data, variables) => {
      // The read-marker set is derived from the per-panel progress cache
      // (with the `recent` list as a fallback while it loads).
      queryClient.invalidateQueries({ queryKey: queryKeys.recentProgress() });
      queryClient.invalidateQueries({ queryKey: queryKeys.progressLatestByPanel(variables.panelId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.progressByPanel(variables.panelId) });
      // Per-chapter progress caches (reader resume state) go stale after a
      // bulk mark/unmark — invalidate by panel prefix so open readers refresh.
      queryClient.invalidateQueries({ queryKey: ['progress', variables.panelId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarks() });
      queryClient.invalidateQueries({ queryKey: ['bookmark-folders', 'contents'] });
      // Reading-list entries may have progress joined in.
      queryClient.invalidateQueries({ queryKey: queryKeys.readingList() });
      // If we cleared progress for a panel, its "by-panel" bookmark entry
      // (which joins progress) also needs refreshing.
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarkByPanel(variables.panelId) });
    },
  });
}

/**
 * Global ids of every chapter the user has already opened (and thus cached
 * on disk). Derived from the TanStack `chapterPages` cache — no polling,
 * no network, just a cache read.
 *
 * Sent to the per-panel tags-size endpoint so the server can attribute each
 * cached chapter's pages to the panel that owns it (a chapter id and its
 * panel id are different provenance strings with different tag hashes).
 */
export function useCachedChapterIds(): string[] {
  const queryClient = useQueryClient();
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] !== 'chapterPages') return;
      forceRender();
    });
    return unsubscribe;
  }, [queryClient]);

  const ids: string[] = [];
  for (const query of queryClient.getQueryCache().getAll()) {
    if (query.queryKey[0] !== 'chapterPages') continue;
    const data = query.state.data as ChapterPages | undefined;
    if (data?.chapterId) ids.push(data.chapterId);
  }
  return ids;
}

/* ---------------------------------------------------------------------- */
/* User ratings (T3-3)                                                    */
/* ---------------------------------------------------------------------- */

export function usePanelRating(panelId: string, opts?: QueryOpts<PanelRating | null>) {
  return useQuery<PanelRating | null, ApiClientError>({
    queryKey: queryKeys.panelRating(panelId),
    queryFn: () => api.getPanelRating(panelId),
    staleTime: 60_000,
    ...opts,
  });
}

export function useSetPanelRating() {
  const queryClient = useQueryClient();
  return useMutation<PanelRating, ApiClientError, SetPanelRatingInput>({
    mutationFn: (input) => api.setPanelRating(input),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.panelRating(data.panelId), data);
    },
  });
}

export function useClearPanelRating() {
  const queryClient = useQueryClient();
  return useMutation<{ cleared: boolean }, ApiClientError, string>({
    mutationFn: (panelId) => api.clearPanelRating(panelId),
    onSuccess: (_data, panelId) => {
      queryClient.setQueryData(queryKeys.panelRating(panelId), null);
    },
  });
}

/* ---------------------------------------------------------------------- */
/* Custom tags (T3-4)                                                     */
/* ---------------------------------------------------------------------- */

export function useTags(opts?: QueryOpts<TagWithPanel[]>) {
  return useQuery<TagWithPanel[], ApiClientError>({
    queryKey: queryKeys.tags(),
    queryFn: () => api.getTags(),
    staleTime: 60_000,
    ...opts,
  });
}

export function useTagsByPanel(panelId: string, opts?: QueryOpts<Tag[]>) {
  return useQuery<Tag[], ApiClientError>({
    queryKey: queryKeys.tagsByPanel(panelId),
    queryFn: () => api.getTagsByPanel(panelId),
    staleTime: 60_000,
    ...opts,
  });
}

/** Replace a panel's tag set; invalidates both tag caches. */
export function useSetPanelTags() {
  const queryClient = useQueryClient();
  return useMutation<Tag[], ApiClientError, { panelId: string; names: string[] }>({
    mutationFn: ({ panelId, names }) => api.setPanelTags(panelId, names),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tags() });
      queryClient.setQueryData(queryKeys.tagsByPanel(variables.panelId), _data);
    },
  });
}

/* ---------------------------------------------------------------------- */
/* Bookmark folders / collections (T2-8)                                  */
/* ---------------------------------------------------------------------- */

export function useBookmarkFolders() {
  return useQuery<{ folders: BookmarkFolder[]; defaultId: string | null }, ApiClientError>({
    queryKey: queryKeys.bookmarkFolders(),
    queryFn: () => api.getBookmarkFolders(),
    staleTime: 60_000,
  });
}

export function useBookmarkFolderContents(folderId: string | null) {
  return useQuery<BookmarkFolderContents, ApiClientError>({
    queryKey: queryKeys.bookmarkFolderContents(folderId),
    queryFn: () => api.getBookmarkFolderContents(folderId),
    staleTime: 60_000,
    // Skip the contents fetch when no folder is selected (the "all
    // bookmarks" view uses useBookmarks instead, so the contents query
    // result is unused and would just be a wasted round trip).
    enabled: folderId !== null,
  });
}

export function useCreateBookmarkFolder() {
  const queryClient = useQueryClient();
  return useMutation<BookmarkFolder, ApiClientError, CreateBookmarkFolderInput>({
    mutationFn: (input) => api.createBookmarkFolder(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarkFolders() });
    },
  });
}

export function useRenameBookmarkFolder() {
  const queryClient = useQueryClient();
  return useMutation<BookmarkFolder, ApiClientError, UpdateBookmarkFolderInput>({
    mutationFn: (input) => api.renameBookmarkFolder(input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarkFolderContents(variables.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarkFolders() });
    },
  });
}

export function useDeleteBookmarkFolder() {
  const queryClient = useQueryClient();
  return useMutation<{ deleted: boolean }, ApiClientError, string>({
    mutationFn: (folderId) => api.deleteBookmarkFolder(folderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarkFolders() });
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarkFolderContents(null) });
    },
  });
}

export function useAddBookmarkToFolder() {
  const queryClient = useQueryClient();
  return useMutation<{ added: boolean }, ApiClientError, AddBookmarkToFolderInput>({
    mutationFn: (input) => api.addBookmarkToFolder(input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarkFolderContents(variables.folderId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarkFolderContents(null) });
      // The flat "All bookmarks" view embeds each bookmark's folderIds, so
      // a folder membership change has to refetch the list too.
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarks() });
    },
  });
}

export function useRemoveBookmarkFromFolder() {
  const queryClient = useQueryClient();
  return useMutation<{ removed: boolean }, ApiClientError, RemoveBookmarkFromFolderInput>({
    mutationFn: (input) => api.removeBookmarkFromFolder(input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarkFolderContents(variables.folderId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarkFolderContents(null) });
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarks() });
    },
  });
}

/* ---------------------------------------------------------------------- */
/* Image cache management (T-?)                                           */
/* ---------------------------------------------------------------------- */

/**
 * Live size of the on-disk image cache. Refreshes only on a manual
 * refetch or after a clear mutation — no background polling, so the
 * page stays quiet while idle.
 */
export function useImageCacheStats() {
  return useQuery<ImageCacheSizeInfo, ApiClientError>({
    queryKey: queryKeys.imageCacheStats(),
    queryFn: () => api.getImageCacheSize('both'),
    staleTime: 2_000,
  });
}

/**
 * Read the cache size limit triple (custom override / computed / effective).
 */
export function useImageCacheLimit() {
  return useQuery<ImageCacheLimitInfo, ApiClientError>({
    queryKey: queryKeys.imageCacheLimit(),
    queryFn: () => api.getImageCacheLimit(),
    staleTime: 5_000,
  });
}

/**
 * Set (`maxBytes`) or clear (`null`, back to automatic) the custom cache
 * size limit. Invalidates the limit query and the stats query (the Usage
 * bar reads the effective cap) on success.
 */
export function useSetImageCacheLimit() {
  const queryClient = useQueryClient();
  return useMutation<ImageCacheLimitInfo, ApiClientError, number | null>({
    mutationFn: (maxBytes) => api.setImageCacheLimit(maxBytes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.imageCacheLimit() });
      queryClient.invalidateQueries({ queryKey: queryKeys.imageCacheStats() });
    },
  });
}

/**
 * Read the upstream-fetch concurrency (effective / persisted-override /
 * startup-default triple plus bounds).
 */
export function useImageConcurrency() {
  return useQuery<ImageConcurrencyInfo, ApiClientError>({
    queryKey: queryKeys.imageConcurrency(),
    queryFn: () => api.getImageConcurrency(),
    staleTime: 5_000,
  });
}

/**
 * Set (`concurrency`) or clear (`null`, back to the env default) the
 * upstream-fetch concurrency. Invalidates the concurrency query on success
 * so the reader panel re-reads immediately.
 */
export function useSetImageConcurrency() {
  const queryClient = useQueryClient();
  return useMutation<ImageConcurrencyInfo, ApiClientError, number | null>({
    mutationFn: (concurrency) => api.setImageConcurrency(concurrency),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.imageConcurrency() });
    },
  });
}

/**
 * Clear the on-disk image cache for covers, chapter pages, or both.
 * Invalidates `imageCacheStats` on success so the UI re-reads immediately.
 */
export function useClearImageCache() {
  const queryClient = useQueryClient();
  return useMutation<ImageCacheClearResult, ApiClientError, 'cover' | 'chapter' | 'both'>({
    mutationFn: (what) => api.clearImageCache(what),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.imageCacheStats() });
    },
  });
}

/**
 * Prune LEGACY cache entries — files written before the provenance-tag
 * format existed. They never show up in the per-tag views (so they're
 * invisible weight on the disk cap) and their URL keys are usually stale.
 * Invalidates the same queries as the clear mutations.
 */
export function usePruneLegacyImageCache() {
  const queryClient = useQueryClient();
  return useMutation<ImageCacheClearResult, ApiClientError, void>({
    mutationFn: () => api.pruneLegacyImageCache(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.imageCacheStats() });
      queryClient.invalidateQueries({ queryKey: ['imageCache', 'tags'] });
    },
  });
}

/**
 * Per-tag breakdown for one kind. Returns the list of provenance tags
 * (8-hex hashes) with their size. Refetched manually or on invalidation,
 * never polled in the background.
 */
export function useImageCacheTags(kind: 'cover' | 'chapter') {
  return useQuery<ImageCacheTagSummary[], ApiClientError>({
    queryKey: ['imageCache', 'tags', kind],
    queryFn: async () => (await api.listImageCacheTags(kind)).tags,
    staleTime: 5_000,
  });
}

/**
 * Total cached footprint (cover + chapter pages merged) for a set of panel,
 * in a single round-trip. Panel ids are sent as-is (covers are tagged with
 * the panel id); the global list of cached chapter ids is sent alongside so
 * the server can attribute chapter pages to the panel that owns them (a
 * chapter id and its panel id are different provenance strings with
 * different tag hashes). Returns one row per panel — zeroed for panel with
 * no cached files — so the cache-settings "Your panel" rows can show "X MB /
 * Y files" next to each title. Refreshed via the page's manual Refresh
 * button or after a clear mutation — never polled in the background.
 */
export function useImageCacheTagsSize(
  panelIds: readonly string[],
  chapterTags: readonly string[] = [],
) {
  return useQuery<ImageCacheTagSummary[], ApiClientError>({
    queryKey: queryKeys.imageCacheTagsSize(panelIds, chapterTags),
    queryFn: async () =>
      (await api.getImageCacheTagsSize(panelIds, chapterTags)).sizes,
    enabled: panelIds.length > 0,
    staleTime: 2_000,
  });
}

/**
 * Latest prefetch job per chapter id (any status). The details page uses
 * this to render persisted per-row badges ("12 / 37 cached") after a
 * browser restart, when the downloader's in-memory progress map is gone.
 * Refreshed on invalidation (a run settling) — never polled.
 */
export function usePrefetchJobsByChapters(chapterIds: readonly string[]) {
  return useQuery<Record<string, PrefetchJob>, ApiClientError>({
    queryKey: queryKeys.prefetchByChapters(chapterIds),
    queryFn: async () => (await api.getPrefetchJobsByChapters(chapterIds)).jobs,
    enabled: chapterIds.length > 0,
    staleTime: 30_000,
  });
}

/**
 * Disk truth for chapters whose snapshots claim `completed`: how many of
 * each chapter's pages are actually on disk right now. A job row is a
 * historical record — it still says `completed 31/31` after its files
 * were cleared, evicted, or deleted — so the "done" badge must verify
 * against this instead of trusting the snapshot alone.
 *
 * Keyed under the `prefetch` prefix so a settled download run (which
 * invalidates that prefix) refreshes the verification automatically.
 * Window-focus refetch stays on: alt-tabbing back from Explorer after
 * deleting files re-checks without a manual reload.
 */
export function useChaptersDiskState(
  requests: readonly { chapterId: string; totalPages: number }[],
) {
  return useQuery<Record<string, ChapterDiskState>, ApiClientError>({
    queryKey: [
      'prefetch',
      'disk-state',
      requests.map((r) => `${r.chapterId}:${r.totalPages}`).sort().join('|'),
    ] as const,
    queryFn: () =>
      api.getChaptersDiskState(
        requests.map((r) => ({ chapterTag: r.chapterId, totalPages: r.totalPages })),
      ),
    enabled: requests.length > 0,
    staleTime: 15_000,
  });
}

/**
 * Size of one provenance tag (file count + bytes). Used by the chapter
 * drill-in modal to show "this chapter is X MB / Y pages" before clear.
 * Fetched once per selection — the modal refetches as you drill.
 */
export function useImageCacheTagSize(kind: 'cover' | 'chapter', tag: string | null) {
  return useQuery<ImageCacheKindInfo, ApiClientError>({
    queryKey: ['imageCache', 'tagSize', kind, tag],
    queryFn: () => api.getImageCacheTagSize(kind, tag!),
    enabled: Boolean(tag),
    staleTime: 5_000,
  });
}

/**
 * Clear every file matching a provenance tag. Used for "clear this
 * panel's chapter pages" / "clear this source's covers" actions.
 * Invalidates the stats query and the tag-list query on success.
 */
export function useClearImageCacheByTag() {
  const queryClient = useQueryClient();
  return useMutation<
    ImageCacheClearResult,
    ApiClientError,
    { what: 'cover' | 'chapter' | 'both'; tag: string }
  >({
    mutationFn: ({ what, tag }) => api.clearImageCacheByTag(what, tag),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.imageCacheStats() });
      queryClient.invalidateQueries({ queryKey: ['imageCache', 'tags'] });
      queryClient.invalidateQueries({ queryKey: ['imageCache', 'tagSize'] });
    },
  });
}
