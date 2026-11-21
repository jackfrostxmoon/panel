import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { BULK_CHAPTER_LIMIT, parseGlobalId, type Chapter } from '@panel/shared';
import { useChapters, usePanel, useRecentProgress, useLatestProgressForPanel, useProgressForPanel, useChapterBookmarks, useAddChapterBookmarks, useAddChapterBookmark, useRemoveChapterBookmark, useBulkMarkChaptersRead, useClearProgress, useReadingListByPanel, useUpsertReadingList, useRemoveReadingList, usePanelRating, useImageCacheTags, usePrefetchJobsByChapters, useChaptersDiskState, useRecordRecentlyViewed, useBookmarkByPanel, useCacheSettings, useTagsByPanel, useClearImageCacheByTag } from '../api/hooks';
import { ShareDialog } from '../components/ShareDialog';
import { CoverLightbox } from '../components/CoverLightbox';
import { useDelayedLoading } from '../hooks/useDelayedLoading';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useChapterDownloader } from '../hooks/useChapterDownloader';
import { useDownloadSettings } from '../hooks/useDownloadSettings';
import { api } from '../api/client';
import { safeExternalUrl } from '../utils/safeExternalUrl';
import { DEFAULT_READER_SETTINGS, type ReaderSettings } from '../reader/settings';
import { resolveDownloadPageConcurrency } from '../download/pageConcurrency';
import { BookmarkFolderPicker, BookmarkToggle } from '../components/BookmarkButton';
import { ReadingListStatusControl } from '../components/ReadingListStatus';
import { ChapterList } from '../components/ChapterList';
import { CoverImage } from '../components/CoverImage';
import { ChapterBookmarkActions } from '../components/ChapterBookmarkActions';
import { ChapterDownloadActions } from '../components/ChapterDownloadActions';
import { ChapterOrderDialog } from '../components/ChapterOrderDialog';
import { sortChaptersForDownload, type ChapterOrder } from '../download/order';
import { compareChaptersAscending } from '../reader/navigation';
import { Switch } from '../components/Switch';
import { useDetailsSettings, useSaveDetailsSettings } from '../api/hooks';
import { StarRating } from '../components/StarRating';
import { TagEditor, TagChipItems } from '../components/TagEditor';
import { EmptyState, ErrorState } from '../components/StateView';
import { useToast } from '../components/Toast';
import { IconChevronDown, IconChevronUp, IconCheck, IconDownload, IconUndo, IconX, IconBookmark, IconTrash, IconZoomIn } from '../components/icons';
import { SearchElsewhereMenu } from '../components/SearchElsewhereMenu';
import { chapterLabel, formatBytes, getProxiedImageUrl } from '../utils/format';
import { useIncognito } from '../hooks/useIncognito';
import { recordRecentlyViewed } from '../utils/recentlyViewed';
import { cacheTagPrefix } from '../utils/sha256';

import { readListMode, writeListMode, LIST_MODES, type ChapterListMode } from '../utils/listMode';

const LIST_MODE_LABELS: Record<ChapterListMode, string> = {
  newest: 'Newest',
  oldest: 'Oldest',
  'bookmark-newest': 'Bookmarked Newest',
  'bookmark-oldest': 'Bookmarked Oldest',
};

/** Sections that can hand off to the details page, for the breadcrumb trail. */
const SECTION_CRUMBS: Record<string, { label: string; to: string }> = {
  latest: { label: 'Latest updates', to: '/latest' },
  search: { label: 'Search', to: '/search' },
  bookmarks: { label: 'Bookmarks', to: '/bookmarks' },
};

function crumbHref(to: string, params: URLSearchParams, panelId: string): string {
  const query = new URLSearchParams(params);
  const parsed = parseGlobalId(panelId);
  
  // Clean up the 'from' param as it's only relevant on the details page
  query.delete('from');
  
  if (to === '/latest') {
    if (parsed) query.set('source', parsed.source);
  } else if (to === '/search') {
    // Return to search when "Search" breadcrumb is clicked
    // Preserve the original search query (q) and page from the current URL
    const originalQ = params.get('q');
    if (originalQ) {
      query.set('q', originalQ);
    }
    
    // Keep the page parameter if it exists (preserve search context)
    const pageParam = params.get('page');
    if (pageParam) {
      query.set('page', pageParam);
    }
    
    // Preserve source if available
    if (parsed) query.set('source', parsed.source);
  } else if (to === '/bookmarks') {
    // For bookmarks, clean up from param
    if (parsed) query.set('source', parsed.source);
  }
  
  const suffix = query.toString();
  return suffix ? `${to}?${suffix}` : to;
}

/**
 * Panel details page with professional modern UI/UX.
   * Features: responsive hero layout, progressive disclosure,
   * smooth animations, full keyboard navigation, and comprehensive accessibility.
  */
export function PanelDetailsPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [params] = useSearchParams();
  const from = params.get('from');
  const panel = usePanel(id);
  const chapters = useChapters(id);
  // Unconditional: the unified genres + tags chip row needs the count
  // to decide what to render. No fetch until the panel page mounts.
  const panelTags = useTagsByPanel(id);
  const clearCoverMutation = useClearImageCacheByTag();
  const [coverNonce, setCoverNonce] = useState(0);
  // Manual-refresh spinner state. Cached refetches can settle in <100ms, so
  // the icon would barely flicker — hold the spin for at least MIN_MS after
  // the click so the feedback is actually perceivable.
  const MIN_REFRESH_SPIN_MS = 700;
  // One-shot background revalidation after open — never a polling loop.
  const REVALIDATE_DELAY_MS = 3_000;
  const [refreshSpinning, setRefreshSpinning] = useState(false);
  const refreshSpinStartedAt = useRef(0);
  /** Set by the Refresh button so the one-shot revalidation below skips it. */
  const manualRefreshRef = useRef(false);
  const recent = useRecentProgress();
  const showPanelLoading = useDelayedLoading(panel.isLoading);
  const showChaptersLoading = useDelayedLoading(chapters.isLoading);

  // Tab title: "Mousou Shoujo" — falls back to "Panel Reader" while loading.
  useDocumentTitle(panel.data?.title ?? null);
  const [filter, setFilter] = useState('');
  const [showAllGenres, setShowAllGenres] = useState(false);
  const [showMoreSynopsis, setShowMoreSynopsis] = useState(false);
  /** Alternative-titles clamp: expanded only via the toggle; the clamp
      itself applies whenever collapsed so truncation can be measured. */
  const [showAllAltTitles, setShowAllAltTitles] = useState(false);
  const altTitlesRef = useRef<HTMLElement>(null);
  const [isAltTitlesTruncated, setIsAltTitlesTruncated] = useState(false);
  /**
   * Single cycling list control, persisted per browser (localStorage) so the
   * chosen view survives reloads and applies to every panel's details page.
   * Cycles: Newest → Oldest → Bookmarked Newest → Bookmarked Oldest.
   * `sortOrder` / `listFilter` derive from it for the list pipeline.
   */
  const [listMode, setListMode] = useState<ChapterListMode>(readListMode);
  // Persist on every change (and once on mount, normalizing invalid storage).
  useEffect(() => {
    writeListMode(listMode);
  }, [listMode]);
  const sortOrder: 'newest' | 'oldest' =
    listMode === 'oldest' || listMode === 'bookmark-oldest' ? 'oldest' : 'newest';
  const listFilter: 'all' | 'bookmarked' = listMode.startsWith('bookmark') ? 'bookmarked' : 'all';
  const [showAllChapters, setShowAllChapters] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedChapterIds, setSelectedChapterIds] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const synopsisRef = useRef<HTMLParagraphElement>(null);
  const [isSynopsisTruncated, setIsSynopsisTruncated] = useState(false);
  const fromSection = from ? SECTION_CRUMBS[from] : undefined;
  /** Share dialog (QR code + link). */
  const [shareOpen, setShareOpen] = useState(false);
  /** Cover lightbox (full-viewport view of the hero cover). */
  const [coverZoomOpen, setCoverZoomOpen] = useState(false);
  /** Batch chapter-bookmark actions (lives next to the sort control). */
  const [showChapterActions, setShowChapterActions] = useState(false);
  /** Details-page preferences (server-persisted; flips instantly via pending variables). */
  const detailsSettingsQuery = useDetailsSettings();
  const saveDetailsSettings = useSaveDetailsSettings();
  const detailsSettings =
    saveDetailsSettings.isPending && saveDetailsSettings.variables
      ? saveDetailsSettings.variables
      : (detailsSettingsQuery.data ?? { showFillerLabels: true });

  const chapterBookmarks = useChapterBookmarks(id);
  /** Bookmark state for gating the folder-picker toolbar segment. */
  const bookmarkQuery = useBookmarkByPanel(id);
  const bookmark = bookmarkQuery.data;
  /** Reading-list status for this panel (T1-5). */
  const readingListQuery = useReadingListByPanel(id);
  const readingListEntry = readingListQuery.data;
  const upsertReadingList = useUpsertReadingList();
  const removeReadingList = useRemoveReadingList();
  /** User star rating (T3-3). */
  const ratingQuery = usePanelRating(id);

  /**
   * Bulk image-cache downloader — single source of truth for both the
   * per-row download button (rendered by `ChapterList`) and the bulk
   * "Download all / unread" panel (rendered inside the actions toggle).
   * One chapter at a time, sequential pages within (3-page window).
   */
  const downloader = useChapterDownloader();
  /**
   * User-tunable pacing for bulk downloads (wait between chapters).
   * Owned here — not inside the downloader — so the `ChapterDownloadActions`
   * panel can mutate it inline without the downloader caring about UI.
   */
  const downloadSettingsState = useDownloadSettings();
  /**
   * Saved reader settings (same server file the reader page edits). Drives
   * the download width when the download mode is `follow-reader` — the
   * reader page itself is never written from here, only read, so its
   * behaviour can't regress from this wiring.
   */
  const [readerSettings, setReaderSettings] = useState<ReaderSettings>(DEFAULT_READER_SETTINGS);
  useEffect(() => {
    let alive = true;
    api
      .getReaderSettings()
      .then((saved) => {
        if (alive) setReaderSettings(saved);
      })
      .catch(() => {
        // Keep defaults when the file is missing/unreachable.
      });
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'panel-reader:settings:sync') {
        api
          .getReaderSettings()
          .then((saved) => {
            if (alive) setReaderSettings(saved);
          })
          .catch(() => {});
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      alive = false;
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  /** Effective pages-in-flight for every download started from this page. Performance mode pins the 16-page maximum with no chapter pacing. */
  const cacheSettings = useCacheSettings();
  const performanceMode = cacheSettings.data?.performanceMode ?? false;
  const effectivePageConcurrency = useMemo(
    () => resolveDownloadPageConcurrency(readerSettings, downloadSettingsState.settings, { performanceMode }),
    [readerSettings, downloadSettingsState.settings, performanceMode],
  );
  /**
   * Push mid-run pacing changes to the in-flight batch. Jobs snapshot the
   * interval at enqueue time, so without this switching Off → 30s while
   * chapter 1 downloads still chains chapter 2 instantly. No-op while
   * idle; failures are swallowed inside `updateInterval` (best-effort).
   */
  const pacingMs = performanceMode ? 0 : downloadSettingsState.settings.chapterIntervalMs;
  const isBatchDownloading = downloader.isDownloading;
  const pushPacing = downloader.updateInterval;
  useEffect(() => {
    if (!isBatchDownloading) return;
    void pushPacing(pacingMs);
  }, [pacingMs, isBatchDownloading, pushPacing]);

  /**
   * Server-side chapter-image cache snapshot. Used to keep the per-row
   * download button in its "done" (red) state across page refreshes —
   * the in-memory `downloader.progress` map is empty after a reload, but
   * the on-disk ImageCache survives restarts, so any chapter whose pages
   * were downloaded in a previous session should still render as done.
   *
   * `useImageCacheTags` returns every cached provenance tag (chapter
   * global-id → 8-hex hash). It is fetched once per mount and refreshed on
   * invalidation (cache clears / settled download runs) — it is not polled,
   * so the page makes no recurring background requests for it.
   */
  const cachedChapterTags = useImageCacheTags('chapter');
  const cachedChapterPrefixes = useMemo(() => {
    const set = new Set<string>();
    for (const t of cachedChapterTags.data ?? []) set.add(t.tag);
    return set;
  }, [cachedChapterTags.data]);
  /** True when the server has at least one cached page for this chapter. */
  const isChapterCached = useCallback(
    (chapterId: string) => cachedChapterPrefixes.has(cacheTagPrefix(chapterId)),
    [cachedChapterPrefixes],
  );

  /**
   * Chapters the user has opened for this panel. The per-panel progress
   * list is the primary source (uncapped); the global recent list is only
   * a fallback while it loads or when a row was saved before the
   * per-panel endpoint existed. Relying on `recent` alone dropped markers
   * once the panel fell out of the top-N window.
   */
  const progressForPanel = useProgressForPanel(id);
  const readChapterIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of progressForPanel.data ?? []) {
      ids.add(entry.chapterId);
    }
    // Fallback while the per-panel query loads (or offline cache gaps).
    for (const entry of recent.data ?? []) {
      if (entry.panelId === id) ids.add(entry.chapterId);
    }
    return ids;
  }, [progressForPanel.data, recent.data, id]);

  const bookmarkedChapterIds = useMemo(() => {
    const ids = new Set<string>();
    for (const bookmark of chapterBookmarks.data ?? []) {
      ids.add(bookmark.chapterId);
    }
    return ids;
  }, [chapterBookmarks.data]);

  // Per-panel latest progress — the Continue button's primary source. The
  // global recent list is capped (top 10), so a panel read days ago falls
  // out of it and Continue silently vanishes even though the progress row
  // is intact (the bookmark card next to it still shows "Chapter 16.1 ·
  // Page 10" because it joins per-panel). The recent list stays as a
  // fallback for rows saved before this endpoint existed.
  const latestForPanel = useLatestProgressForPanel(id);
  const continueEntry = useMemo(
    () =>
      latestForPanel.data ??
      (recent.data ?? []).find((entry) => entry.panelId === id) ??
      null,
    [latestForPanel.data, recent.data, id],
  );

  /** Resolve the "Continue Reading" subtext: look up the chapter by id to
   *  get its number, falling back to the progress entry's chapterTitle.
   *  Sources sometimes store raw tokens (e.g. "#206") as the title, so we
   *  prefer the chapter number when it's available — `Ch. 206` reads much
   *  better than `#206` next to a primary CTA. */
  const continueChapter = useMemo(() => {
    if (!continueEntry || !chapters.data) return null;
    return chapters.data.find((c) => c.id === continueEntry.chapterId) ?? null;
  }, [continueEntry, chapters.data]);
  const continueLabel = continueChapter
    ? chapterLabel(continueChapter.chapterNumber, continueChapter.title)
    : continueEntry?.chapterTitle || 'Latest chapter';

  /**
   * "Mark Until Here" target — every chapter before the user's current
   * (Continue Reading) chapter that isn't already marked read. Hidden
   * when there's no current chapter, no numbered chapters before it, or
   * they're already all read. Post-metadata extras (null chapterNumber)
   * are excluded since they can't be ordered relative to the current one.
   */
  const markUntil = useMemo(() => {
    if (!continueChapter || continueChapter.chapterNumber === null) return null;
    const currentNumber = continueChapter.chapterNumber;
    const targets: Chapter[] = [];
    for (const c of chapters.data ?? []) {
      if (
        c.chapterNumber !== null &&
        c.chapterNumber < currentNumber &&
        c.id !== continueChapter.id &&
        !readChapterIds.has(c.id)
      ) {
        targets.push(c);
      }
    }
    if (targets.length === 0) return null;
    return {
      chapters: targets,
      currentLabel: chapterLabel(continueChapter.chapterNumber, continueChapter.title),
    };
  }, [continueChapter, chapters.data, readChapterIds]);

  /**
   * Oldest / newest chapter. Null numbers are resolved from the title
   * (see `compareChaptersAscending`) rather than sorted into a corner, so
   * untagged prefetch-persisted chapters take their real position. The
   * list is copied before sorting: the old inline `.sort()` calls below
   * mutated the cached array in place.
   */
  const firstChapter = useMemo(() => {
    const list = chapters.data;
    if (!list || list.length === 0) return null;
    return [...list].sort(compareChaptersAscending)[0] ?? null;
  }, [chapters.data]);
  const latestChapter = useMemo(() => {
    const list = chapters.data;
    if (!list || list.length === 0) return null;
    return [...list].sort((a, b) => compareChaptersAscending(b, a))[0] ?? null;
  }, [chapters.data]);

const filteredAndSortedChapters = useMemo(() => {
    let list = chapters.data ?? [];
    if (listFilter === 'bookmarked') {
      list = list.filter((c) => bookmarkedChapterIds.has(c.id));
    }
    const q = filter.trim().toLowerCase();
    if (q) {
      list = list.filter((c) => c.title.toLowerCase().includes(q));
    }
    list = [...list].sort((a, b) =>
      sortOrder === 'newest'
        ? compareChaptersAscending(b, a)
        : compareChaptersAscending(a, b),
    );
    return list;
  }, [chapters.data, filter, sortOrder, listFilter, bookmarkedChapterIds]);

  // Show only the first 5 chapters until the user expands the list.
  const visibleChapters = useMemo(() => {
    return showAllChapters
      ? filteredAndSortedChapters
      : filteredAndSortedChapters.slice(0, 5);
  }, [filteredAndSortedChapters, showAllChapters]);

  /**
   * Latest prefetch job per chapter (any status). Powers the persisted
   * per-row badges ("12 / 37 cached") after a browser restart, when the
   * downloader's in-memory progress map is gone. Scoped to the filtered
   * list so long series don't fetch snapshots for chapters the user
   * filtered out; refreshed whenever a run settles (the downloader
   * invalidates the `prefetch` prefix).
   */
  const snapshotChapterIds = useMemo(
    () => filteredAndSortedChapters.map((c) => c.id),
    [filteredAndSortedChapters],
  );
  const prefetchSnapshots = usePrefetchJobsByChapters(snapshotChapterIds);
  // Memoized so the adapter below doesn't recompute on every render while
  // the query is still pending (`?? {}` would mint a fresh identity).
  const snapshotByChapter = useMemo(
    () => prefetchSnapshots.data ?? {},
    [prefetchSnapshots.data],
  );

  /**
   * Disk verification for every chapter whose snapshot claims `completed`.
   * A job row is history, not truth — it still reads `completed 31/31`
   * after its files were cleared, evicted, or deleted from the cache
   * folder — so the "done" badge and its label verify against what's
   * actually on disk. Scoped to the filtered list like the snapshots;
   * one batched round-trip, refreshed whenever a download run settles
   * (the `prefetch`-prefixed key) or the window regains focus.
   */
  const diskVerifyRequests = useMemo(
    () =>
      filteredAndSortedChapters
        .map((c) => ({
          chapterId: c.id,
          totalPages: snapshotByChapter[c.id]?.totalPages ?? 0,
        }))
        .filter(
          (r) =>
            r.totalPages > 0 && snapshotByChapter[r.chapterId]?.status === 'completed',
        ),
    [filteredAndSortedChapters, snapshotByChapter],
  );
  const diskStateQuery = useChaptersDiskState(diskVerifyRequests);
  // Memoized so the adapter below doesn't recompute on every render while
  // the query is still pending.
  const diskByChapter = useMemo(
    () => diskStateQuery.data ?? {},
    [diskStateQuery.data],
  );

  /**
   * Adapter object passed into <ChapterList> so each row can show its own
   * download button + call back into the parent's downloader. Kept
   * stable (useMemo) so the row components don't re-render on every
   * progress tick — they only re-render when their specific chapter's
   * progress entry changes.
   *
   * In-memory progress always wins; the persisted job snapshots below
   * are the fallback that keeps badges honest across page reloads.
   */
  const chapterListDownloader = useMemo(
    () => ({
      isActive: (chapterId: string) => {
        const p = downloader.progress[chapterId];
        return (
          downloader.activeChapterIds.includes(chapterId) ||
          p?.state === 'fetching-payload' ||
          p?.state === 'downloading'
        );
      },
      // A chapter is "done" when the current in-memory run finished clean,
      // when its last server job completed with zero failures AND a disk
      // re-check confirms every page is still on disk, or when the
      // server's on-disk ImageCache still has at least one of its pages
      // from a previous run — the latter keeps a plausible "done" style
      // visible after a page refresh for chapters with no job row at all.
      // The disk check matters because a job row is history: it still
      // says `completed` after its files were cleared, evicted, or
      // deleted, which used to freeze the badge on a lie ("Already
      // cached (31 / 31)" with an empty folder). While the re-check is
      // still loading we stay optimistic (trust the snapshot) so the
      // badge doesn't flicker on every page open.
      isDone: (chapterId: string) => {
        if (downloader.progress[chapterId]?.state === 'done') return true;
        const snap = snapshotByChapter[chapterId];
        if (snap?.status === 'completed' && snap.failedPages === 0) {
          if (snap.totalPages > 0) {
            const disk = diskByChapter[chapterId];
            if (disk) return disk.cachedCount >= disk.totalPages;
          }
          return true;
        }
        return isChapterCached(chapterId);
      },
      isCancelled: (chapterId: string) => {
        if (downloader.progress[chapterId]?.state === 'cancelled') return true;
        return snapshotByChapter[chapterId]?.status === 'cancelled';
      },
      isFailed: (chapterId: string) => {
        if (downloader.progress[chapterId]?.state === 'failed') return true;
        const snap = snapshotByChapter[chapterId];
        return snap?.status === 'failed' || (snap?.status === 'completed' && snap.failedPages > 0);
      },
      progressLabel: (chapterId: string) => {
        const p = downloader.progress[chapterId];
        if (p) {
          if (p.state === 'downloading') return `${p.current} / ${p.total}`;
          if (p.state === 'fetching-payload') return 'preparing…';
          // After the run settles, surface how many of the chapter's pages
          // are actually on disk. A partial download shows as "12 / 37
          // cached" so the user sees at a glance that a retry is needed.
          if (p.cachedPages > 0 || p.failedPages > 0) {
            const known = p.cachedPages + p.failedPages;
            return `${p.cachedPages} / ${known} cached`;
          }
          return null;
        }
        // No in-memory entry (fresh page load, or a run from another tab):
        // fall back to the persisted job snapshot so the badge survives
        // browser restarts. A partial last run reads as "12 / 37 cached"
        // with the failed icon; a clean one reads "37 / 37 cached".
        // Completed snapshots report the disk-verified count when it's
        // available, so a cleared/evicted chapter honestly reads
        // "0 / 31 cached" instead of parroting the stale job row.
        const snap = snapshotByChapter[chapterId];
        if (!snap || snap.totalPages === 0) return null;
        if (snap.status === 'completed' || snap.status === 'failed') {
          if (snap.status === 'completed') {
            const disk = diskByChapter[chapterId];
            if (disk) return `${disk.cachedCount} / ${disk.totalPages} cached`;
          }
          return `${snap.cachedPages} / ${snap.totalPages} cached`;
        }
        return null;
      },
      startOne: (chapter: Chapter) => {
        // Single-chapter taps start immediately — pacing (`chapterIntervalMs`)
        // only spaces chapters *within* a bulk batch, so holding a manual
        // download back by that wait just made single taps feel stuck when
        // the user had configured e.g. 2m between chapters. The job itself
        // lives server-side, so a refresh mid-run no longer kills it.
        void downloader.downloadChapters([chapter], {
          chapterIntervalMs: 0,
          delayFirstMs: 0,
          pageConcurrency: effectivePageConcurrency,
        }).then((result) => {
          if (result.cancelled) return;
          // Per-row failures are visible via the failed icon state on the
          // row itself; no toast — would be noise for the most common case.
        }).catch((error: unknown) => {
          if ((error as { name?: string })?.name === 'AbortError') return;
          // Per-row failures are visible via the failed icon state.
        });
      },
      cancelOne: () => {
        downloader.cancel();
      },
    }),
    [downloader, isChapterCached, snapshotByChapter, diskByChapter, effectivePageConcurrency],
  );

  /**
   * True when the Continue target's images are already fully on disk
   * (the same "done" signal as the per-row download badge). Clicking
   * Continue then performs a full document load instead of SPA
   * navigation, so the reader boots fresh against the warm ImageCache
   * — the requested auto-refresh. Uncached chapters keep the fast SPA
   * transition.
   */
  const continueIsCached = useMemo(
    () => (continueEntry ? chapterListDownloader.isDone(continueEntry.chapterId) : false),
    [continueEntry, chapterListDownloader],
  );

  /**
   * Multi-select toggle: clicking a chapter row (or the per-row checkbox)
   * adds it to the set, clicking again removes it. Exiting the mode
   * clears the set so the next session starts blank.
   */
  const handleToggleSelected = useCallback((chapterId: string) => {
    setSelectedChapterIds((prev) => {
      const next = new Set(prev);
      if (next.has(chapterId)) next.delete(chapterId);
      else next.add(chapterId);
      return next;
    });
  }, []);
  const handleSelectAllVisible = useCallback(() => {
    setSelectedChapterIds(new Set(visibleChapters.map((c) => c.id)));
  }, [visibleChapters]);
  const handleClearSelection = useCallback(() => {
    setSelectedChapterIds(new Set());
  }, []);
  /** Exit select mode; the next time the user re-enters, the set is empty. */
  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedChapterIds(new Set());
  }, []);
  /**
   * Resolve the selected chapter ids to chapter objects in their current
   * display order, then fire the batch download. Skips ids that are no
   * longer in the chapter list (e.g. the user selected, then the data
   * refetched and dropped one). Empty selection is a no-op.
   */
  const selectedChapters = useMemo(() => {
    if (selectedChapterIds.size === 0) return [] as Chapter[];
    // Filter (not map by id) so the result preserves the current display
    // order, and ids that have since been dropped by a refetch are skipped.
    return visibleChapters.filter((c) => selectedChapterIds.has(c.id));
  }, [selectedChapterIds, visibleChapters]);
  /* Selection-mode download asks for a direction too: the batch order is the
     download order, and `selectedChapters` carries the list's display order,
     so without this the Newest/Oldest view toggle would decide it silently. */
  const handleDownloadSelected = useCallback(
    async (order: ChapterOrder, batchOverride?: Chapter[]) => {
      const batch = sortChaptersForDownload(batchOverride ?? selectedChapters, order);
      if (batch.length === 0) {
        toast('No chapters selected', 'info');
        return;
      }
      try {
        const result = await downloader.downloadChapters(batch, {
          chapterIntervalMs: pacingMs,
          pageConcurrency: effectivePageConcurrency,
          order,
        });
      if (result.cancelled) {
        toast(
          `Download stopped — ${result.done} chapter${result.done === 1 ? '' : 's'} cached so far.`,
          'info',
        );
      } else if (result.failed > 0) {
        toast(
          `Downloaded ${result.done} — ${result.failed} failed (some pages skipped).`,
          'success',
        );
      } else if (result.failedPages > 0) {
        toast(
          `Downloaded ${result.done}, but ${result.failedPages} page(s) failed — re-run to retry them.`,
          'info',
        );
      } else {
        toast(
          `Downloaded ${result.done} chapter${result.done === 1 ? '' : 's'}. They'll open instantly next time.`,
          'success',
        );
      }
      // Successful (or at least attempted) download drops the selection so the
      // user sees the row icons flip to "done" without stale highlights.
      handleClearSelection();
    } catch (error) {
        toast(error instanceof Error ? error.message : 'Download failed.', 'error');
      }
    },
    [
      selectedChapters,
      downloader,
      pacingMs,
      effectivePageConcurrency,
      toast,
      handleClearSelection,
    ],
  );

  /** Batch awaiting a direction choice from the order dialog; null = closed. */
  const [selectedOrderPrompt, setSelectedOrderPrompt] = useState(false);
  const requestSelectedDownload = useCallback(() => {
    if (selectedChapters.length === 0) {
      toast('No chapters selected', 'info');
      return;
    }
    setSelectedOrderPrompt(true);
  }, [selectedChapters.length, toast]);

  /** Hook for the multi-select "Bookmark selected" button. */
  const addChapterBookmarks = useAddChapterBookmarks();
  /**
   * Bulk-bookmark every currently-selected chapter. The API caps the payload
   * at `BULK_CHAPTER_LIMIT` chapters (same constant on the server's Zod
   * schema), so a long panel is sent in chunks; the final toast reports the
   * total bookmarked. On success the multi-select mode is exited so the row
   * checkboxes disappear and the page returns to its normal state.
   */
  const handleBookmarkSelected = useCallback(async () => {
    const batch = selectedChapters;
    if (batch.length === 0) {
      toast('No chapters selected', 'info');
      return;
    }
    let total = 0;
    try {
      for (let i = 0; i < batch.length; i += BULK_CHAPTER_LIMIT) {
        const result = await addChapterBookmarks.mutateAsync({
          panelId: id,
          chapters: batch.slice(i, i + BULK_CHAPTER_LIMIT).map((ch) => ({
            chapterId: ch.id,
            title: ch.title,
            chapterNumber: ch.chapterNumber,
            sourceUrl: ch.sourceUrl,
            publishedAt: ch.publishedAt,
          })),
        });
        total += result.length;
      }
      toast(
        `Bookmarked ${total} chapter${total === 1 ? '' : 's'}.`,
        'success',
      );
      exitSelectionMode();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not bookmark chapters.', 'error');
    }
  }, [selectedChapters, addChapterBookmarks, id, toast, exitSelectionMode]);

  /** Hook for the multi-select "Mark read selected" / "Unmark selected" buttons. */
  const bulkMarkSelected = useBulkMarkChaptersRead();
  /**
   * Bulk-mark every currently-selected chapter as read. Reuses the same
   * `/api/progress/bulk` endpoint as "Mark All Read", chunked
   * by `BULK_CHAPTER_LIMIT`. Clears the selection (stays in select mode)
   * so the row read-markers update without stale highlights.
   */
  const handleMarkSelectedRead = useCallback(async () => {
    const batch = selectedChapters;
    if (batch.length === 0) {
      toast('No chapters selected', 'info');
      return;
    }
    let markedRead = 0;
    try {
      for (let i = 0; i < batch.length; i += BULK_CHAPTER_LIMIT) {
        const result = await bulkMarkSelected.mutateAsync({
          panelId: id,
          chapters: batch
            .slice(i, i + BULK_CHAPTER_LIMIT)
            .map((ch) => ({ chapterId: ch.id, read: true })),
        });
        markedRead += result.markedRead;
      }
      toast(
        `Marked ${markedRead} chapter${markedRead === 1 ? '' : 's'} read.`,
        'success',
      );
      handleClearSelection();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not mark chapters read.', 'error');
    }
  }, [selectedChapters, bulkMarkSelected, id, toast, handleClearSelection]);

  /**
   * Bulk-unmark every currently-selected chapter, the
   * counterpart to `handleMarkSelectedRead` and "Unmark All".
   */
  const handleMarkSelectedUnread = useCallback(async () => {
    const batch = selectedChapters;
    if (batch.length === 0) {
      toast('No chapters selected', 'info');
      return;
    }
    let markedUnread = 0;
    try {
      for (let i = 0; i < batch.length; i += BULK_CHAPTER_LIMIT) {
        const result = await bulkMarkSelected.mutateAsync({
          panelId: id,
          chapters: batch
            .slice(i, i + BULK_CHAPTER_LIMIT)
            .map((ch) => ({ chapterId: ch.id, read: false })),
        });
        markedUnread += result.markedUnread;
      }
      toast(
        `Unmarked ${markedUnread} chapter${markedUnread === 1 ? '' : 's'}.`,
        'success',
      );
      handleClearSelection();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not unmark chapters.', 'error');
    }
  }, [selectedChapters, bulkMarkSelected, id, toast, handleClearSelection]);

  /**
   * Per-chapter action from the long-press context menu. Owns the single-
   * chapter mutations + toast reporting so `ChapterList` stays a renderer.
   * Page also holds the per-chapter add/remove bookmark hooks (the bulk
   * `addChapterBookmarks` is used by `handleBookmarkSelected` above).
   */
  const addChapterBookmark = useAddChapterBookmark();
  const removeChapterBookmark = useRemoveChapterBookmark();
  const bulkMarkOne = useBulkMarkChaptersRead();
  const handleChapterAction = useCallback(
    async (
      kind: 'read' | 'unread' | 'bookmark' | 'unbookmark',
      chapter: Chapter,
    ) => {
      if (!id) return;
      try {
        if (kind === 'read') {
          await bulkMarkOne.mutateAsync({
            panelId: id,
            chapters: [{ chapterId: chapter.id, read: true }],
          });
          toast('Marked read', 'success');
        } else if (kind === 'unread') {
          await bulkMarkOne.mutateAsync({
            panelId: id,
            chapters: [{ chapterId: chapter.id, read: false }],
          });
          toast('Marked unread', 'success');
        } else if (kind === 'bookmark') {
          await addChapterBookmark.mutateAsync({
            panelId: id,
            chapterId: chapter.id,
            title: chapter.title,
            chapterNumber: chapter.chapterNumber,
            sourceUrl: chapter.sourceUrl,
            publishedAt: chapter.publishedAt,
          });
          toast('Chapter bookmarked', 'success');
        } else {
          await removeChapterBookmark.mutateAsync({ panelId: id, chapterId: chapter.id });
          toast('Chapter bookmark removed');
        }
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Action failed', 'error');
      }
    },
    [id, addChapterBookmark, removeChapterBookmark, bulkMarkOne, toast],
  );

  // Check if synopsis is truncated. The collapsed paragraph is always
  // clamped (.truncated) so scrollHeight > clientHeight is measurable;
  // while expanded leave the flag alone so the toggle never vanishes.
  // Re-measured on container resize (viewport switch, sidebar toggle) —
  // a stale measurement after a desktop→mobile flip hid the button
  // until refresh. Effect re-runs on toggle, so the closure stays correct.
  useEffect(() => {
    const el = synopsisRef.current;
    if (!el) return;
    const measure = () => {
      if (showMoreSynopsis) return;
      setIsSynopsisTruncated(el.scrollHeight > el.clientHeight);
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [panel.data?.description, showMoreSynopsis]);

  /** Alternative-titles toggle: the joined string is the effect dep so a
      panel swap/revalidation re-measures. Re-measured on container resize
      so a viewport switch (desktop→mobile) can't leave a stale truncation
      flag behind. While expanded we don't touch the flag — otherwise the
      button would vanish on the next refetch and trap the user in the
      expanded state. */
  const altTitlesJoined = panel.data?.altTitles.join(' · ') ?? '';
  useEffect(() => {
    const el = altTitlesRef.current;
    if (!el) {
      setIsAltTitlesTruncated(false);
      return;
    }
    const measure = () => {
      if (showAllAltTitles) return;
      setIsAltTitlesTruncated(el.scrollHeight > el.clientHeight);
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [altTitlesJoined, showAllAltTitles]);

  // Recently-viewed rail: record this panel tap so the home page can
  // surface it. Written to the server history AND the local rail — the
  // server row is what survives browser clears and device switches, the
  // local write keeps the rail instant and covers offline reads.
  const recordHistory = useRecordRecentlyViewed();
  useEffect(() => {
    if (panel.data) {
      recordRecentlyViewed({
        id: panel.data.id,
        title: panel.data.title,
        coverUrl: panel.data.coverUrl,
        source: panel.data.source,
        sourceUrl: panel.data.sourceUrl,
        status: panel.data.status,
        latestChapter: panel.data.latestChapter,
        updatedAt: panel.data.updatedAt,
      });
      recordHistory.mutate({
        panelId: panel.data.id,
        title: panel.data.title,
        coverUrl: panel.data.coverUrl,
        source: panel.data.source,
        sourceUrl: panel.data.sourceUrl,
        status: panel.data.status,
      });
    }
    // oxlint-disable-next-line react/exhaustive-deps -- record once per loaded panel; recordHistory is stable.
  }, [panel.data]);

  // Navigate to chapter with proper encoding
  const navigateToChapter = useCallback(
    (chapterId: string) => {
      navigate(`/read/${encodeURIComponent(chapterId)}`);
    },
    [navigate],
  );

  /**
   * Single delayed revalidation. The API serves the cached DB row instantly
   * on open, then revalidates live in the background — so the first paint
   * can be one chapter behind until the server's refresh lands. Refetch
   * panel + chapters once, ~3s after open, instead of polling every 2s for
   * 40s: the manual Refresh button covers anything later, so the page
   * otherwise stays quiet (the repeated `/chapters` requests in the network
   * panel came from that old loop). Keyed on `id`, so switching panels
   * re-arms it; the cleanup drops the pending timer on unmount.
   */
  const panelRefetchRef = useRef(panel.refetch);
  panelRefetchRef.current = panel.refetch;
  const chaptersRefetchRef = useRef(chapters.refetch);
  chaptersRefetchRef.current = chapters.refetch;
  // End the manual-refresh spin only once the fetch settles AND at least
  // MIN_REFRESH_SPIN_MS have elapsed since the click.
  useEffect(() => {
    if (!refreshSpinning || chapters.isFetching) return;
    const remaining = Math.max(0, MIN_REFRESH_SPIN_MS - (Date.now() - refreshSpinStartedAt.current));
    const timer = window.setTimeout(() => setRefreshSpinning(false), remaining);
    return () => window.clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-deps -- MIN_REFRESH_SPIN_MS is a constant of this component.
  }, [refreshSpinning, chapters.isFetching]);
  useEffect(() => {
    manualRefreshRef.current = false;
    const timer = window.setTimeout(() => {
      // A manual refresh already covered this window — don't fetch twice.
      if (manualRefreshRef.current) return;
      void Promise.all([panelRefetchRef.current(), chaptersRefetchRef.current()]);
    }, REVALIDATE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-deps -- once-per-panel timer; live query values via refs.
  }, [id]);

  // Handle keyboard navigation for chapter list
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, chapterId: string) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        navigateToChapter(chapterId);
      }
    },
    [navigateToChapter],
  );

  // Clear read tracker (reading progress) for this panel
  const clearProgress = useClearProgress();

  const handleClearReadTracker = useCallback(async () => {
    try {
      await clearProgress.mutateAsync(id);
      toast('Reading progress cleared', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not clear read tracker.', 'error');
    }
  }, [id, clearProgress, toast]);

  /** Reading-list upsert (T1-5): add or move between Want to Read / Reading / Completed.
      Declared before the early returns so the hook order stays stable. */
  const handleReadingListUpsert = useCallback(
    async (input: { panelId: string; status: 'want_to_read' | 'reading' | 'completed' }) => {
      const m = panel.data;
      if (!m) return;
      try {
        await upsertReadingList.mutateAsync({
          panelId: input.panelId,
          status: input.status,
          title: m.title,
          coverUrl: m.coverUrl,
          source: m.source,
          sourceUrl: m.sourceUrl,
        });
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Could not update reading list.', 'error');
      }
    },
    [upsertReadingList, panel.data, toast],
  );

  /** Remove this panel from the reading list (T1-5). */
  const handleReadingListRemove = useCallback(async () => {
    const m = panel.data;
    try {
      await removeReadingList.mutateAsync(id);
      toast(`Removed "${m?.title ?? 'Panel'}" from the reading list`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not remove from the reading list.', 'error');
    }
  }, [removeReadingList, id, panel.data, toast]);

  if (showPanelLoading) return null;
  if (panel.isError) return <DetailsError error={panel.error} onRetry={panel.refetch} />;
  if (!panel.data) return null;

  const m = panel.data;
  const tagCount = (panelTags.data ?? []).length;
  const showUnifiedChips = m.genres.length > 0 || tagCount > 0;

  // Delete the cached cover so a wrong/stale image gets refetched. The
  // nonce busts the browser's immutable max-age on the proxied URL.
  const proxiedCover = getProxiedImageUrl(m.source, m.coverUrl, 'cover', m.id);
  const backdropCover = proxiedCover && coverNonce > 0
    ? `${proxiedCover}${proxiedCover.includes('?') ? '&' : '?'}_retry=${coverNonce}`
    : proxiedCover;
  const handleClearCover = () => {
    clearCoverMutation.mutate(
      { what: 'cover', tag: m.id },
      {
        onSuccess: (result) => {
          setCoverNonce((n) => n + 1);
          toast(
            `Cleared ${result.entryCount.toLocaleString()} cached cover file${result.entryCount === 1 ? '' : 's'} (${formatBytes(result.totalBytes)}) — refetching.`,
            'success',
          );
        },
        onError: (error) =>
          toast(error instanceof Error ? error.message : 'Could not clear the cover cache.', 'error'),
      },
    );
  };

  // Floating page nav (only while the full chapter list is expanded).
  const scrollToEnd = () =>
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  const scrollToTop = () =>
    window.scrollTo({
      top: 0,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });

  // Prepare display genres
  const displayGenres = showAllGenres ? m.genres : m.genres.slice(0, 8);
  const hasMoreGenres = m.genres.length > 8;

  return (
    <div className="page panel-details" aria-labelledby="panel-title">
      {/* Breadcrumb Navigation */}
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <ol className="breadcrumb__list">
          <li className="breadcrumb__item">
            <Link to="/" className="breadcrumb__link" aria-label="Go to home page">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
              Home
            </Link>
          </li>
          <li className="breadcrumb__separator" aria-hidden="true">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </li>
          {fromSection && (
            <>
              <li className="breadcrumb__item">
                <Link to={crumbHref(fromSection.to, params, id)} className="breadcrumb__link">
                  {fromSection.label}
                </Link>
              </li>
              <li className="breadcrumb__separator" aria-hidden="true">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </li>
            </>
          )}
          <li className="breadcrumb__item breadcrumb__item--current" aria-current="page">
            {m.title}
          </li>
        </ol>
      </nav>

      {/* Hero Section - Cover & Metadata */}
      <header className="panel-details__hero" role="banner">
        {/* T3-8: blurred cover backdrop with a gradient wash so the hero
            picks up the title's palette without hurting text contrast. */}
        {panel.data?.coverUrl && (
          <div
            className="panel-details__backdrop"
            aria-hidden="true"
            style={{
              backgroundImage: backdropCover
                ? `url(${backdropCover})`
                : undefined,
            }}
          />
        )}
        <div className="panel-details__cover-wrapper">
          <div className="panel-details__cover" aria-hidden="true">
            {/* Silent background retry; initials fallback only after retries exhaust */}
            <CoverImage
              source={m.source}
              coverUrl={m.coverUrl}
              panelId={m.id}
              title={m.title}
              eager
              imgClassName="cover-image"
              fallbackClassName="panel-card__cover-fallback"
              cacheNonce={coverNonce}
            />

            {/* Cover gradient overlay */}
            <div className="panel-details__cover-gradient" aria-hidden="true" />
          </div>
          <button
            type="button"
            className="panel-details__cover-zoom"
            onClick={() => setCoverZoomOpen(true)}
            disabled={!m.coverUrl}
            aria-label="View cover image full screen"
            title="View cover image full screen"
          >
            <IconZoomIn size={16} />
          </button>
          <button
            type="button"
            className="panel-details__cover-clear"
            onClick={handleClearCover}
            disabled={clearCoverMutation.isPending || !m.coverUrl}
            aria-label="Delete cached cover image and refetch"
            title="Delete cached cover image and refetch"
          >
            <IconTrash size={16} />
          </button>
        </div>

        <div className="panel-details__info">
          <div className="panel-details__header">
            <h1 id="panel-title" className="panel-details__title">
              {m.title}
            </h1>
            <SearchElsewhereMenu
              title={m.title}
              altTitles={m.altTitles}
              authors={m.authors}
              artists={m.artists}
            />
          </div>

          <dl className="panel-details__meta">
            {m.altTitles.length > 0 && (
              <div className="meta-group">
                <dt className="meta-label">Alternative titles</dt>
                <dd
                  ref={altTitlesRef}
                  id="alt-titles-value"
                  className={`meta-value meta-value--alt${!showAllAltTitles ? ' alt-titles--clamped' : ''}${!showAllAltTitles && isAltTitlesTruncated ? ' alt-titles--faded' : ''}`}
                >
                  {altTitlesJoined}
                </dd>
                {isAltTitlesTruncated && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm alt-titles__toggle"
                    onClick={() => setShowAllAltTitles(!showAllAltTitles)}
                    aria-expanded={showAllAltTitles}
                    aria-controls="alt-titles-value"
                  >
                    {showAllAltTitles ? (
                      <>
                        Show less
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <polyline points="18 15 12 9 6 15" />
                        </svg>
                      </>
                    ) : (
                      <>
                        Show more
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </>
                    )}
                  </button>
                )}
              </div>
            )}
            {m.authors.length > 0 && (
              <div className="meta-group">
                <dt className="meta-label">Author</dt>
                <dd className="meta-value">{m.authors.join(', ')}</dd>
              </div>
            )}
            {m.artists.length > 0 && (
              <div className="meta-group">
                <dt className="meta-label">Artist</dt>
                <dd className="meta-value">{m.artists.join(', ')}</dd>
              </div>
            )}
            <div className="meta-group">
              <dt className="meta-label">Status</dt>
              <dd className="meta-value">
                <span className={`status-pill status-pill--${m.status}`}>
                  {m.status.charAt(0).toUpperCase() + m.status.slice(1)}
                </span>
              </dd>
            </div>
            {m.updatedAt && (
              <div className="meta-group">
                <dt className="meta-label">Updated</dt>
                <dd className="meta-value">
                  <time dateTime={m.updatedAt}>
                    {new Date(m.updatedAt).toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </time>
                </dd>
              </div>
            )}
            <div className="meta-group">
              <dt className="meta-label">Chapters</dt>
              <dd className="meta-value">
                <strong>{(chapters.data ?? []).length}</strong> chapters
              </dd>
            </div>
            <div className="meta-group">
              <dt className="meta-label">Source</dt>
              <dd className="meta-value">
                {safeExternalUrl(m.sourceUrl) ? (
                  <a
                    href={safeExternalUrl(m.sourceUrl) ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="source-link"
                    aria-label={`View on ${m.source}`}
                  >
                    {m.source}
                    <svg
                      className="link-external-icon"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </a>
                ) : (
                  // Remote data produced a non-http(s) or unparseable URL —
                  // render the label without a link rather than trust it.
                  m.source
                )}
              </dd>
            </div>
          </dl>

          {/* Genres + tags share one chip row (tags fold in when present) */}
          {showUnifiedChips && (
            <div className="panel-details__genres">
              <div className="genre-list-header">
                <span className="genre-list-label">{m.genres.length > 0 ? 'Genres' : 'Tags'}</span>
                <span className="genre-count">
                  {m.genres.length > 0 ? m.genres.length : tagCount}
                </span>
              </div>
              <ul className="genre-list" role="list" id="genre-list">
                {displayGenres.map((genre) => (
                  <li key={genre}>
                    <Link
                      to={`/latest?source=${encodeURIComponent(m.source)}&genre=${encodeURIComponent(genre)}`}
                      className="genre-chip"
                      title={`Browse ${genre} in Latest`}
                    >
                      {genre}
                    </Link>
                  </li>
                ))}
                {hasMoreGenres && (
                  <li>
                    <button
                      type="button"
                      className="genre-chip genre-chip--toggle"
                      onClick={() => setShowAllGenres(!showAllGenres)}
                      aria-expanded={showAllGenres}
                      aria-controls="genre-list"
                    >
                      {showAllGenres ? (
                        <>
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            aria-hidden="true"
                          >
                            <polyline points="18 15 12 9 6 15" />
                          </svg>
                          Show less
                        </>
                      ) : (
                        <>
                          +{m.genres.length - 8} more
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            aria-hidden="true"
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </>
                      )}
                    </button>
                  </li>
                )}
                {/* Tag chips fold into the genres row; the toggle follows them */}
                <TagChipItems panelId={id} />
                {/* + Add tag chip rides at the tail of the row */}
                <li className="genre-list__tag-add">
                  <TagEditor panelId={id} toggleOnly />
                </li>
              </ul>
            </div>
          )}

          {/* Fallback: no genres and no tags yet — keep the standalone tags
              section so the list can be seeded from here. */}
          {!showUnifiedChips && <TagEditor panelId={id} />}

          {/* Action Buttons */}
          <div className="panel-details__actions">
            <div className="panel-details__primary-actions">
              {continueEntry && (
                <Link
                  to={`/read/${encodeURIComponent(continueEntry.chapterId)}`}
                  className="btn btn--primary btn--lg btn--continue"
                  aria-label={`Continue reading ${continueLabel}`}
                  onClick={(e) => {
                    if (!continueIsCached) return;
                    // Chapter is fully cached: full document load instead of
                    // SPA navigation, so the reader auto-refreshes once
                    // against the warm ImageCache.
                    e.preventDefault();
                    window.location.assign(e.currentTarget.href);
                  }}
                >
                  <span className="btn-icon" aria-hidden="true">
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  </span>
                  <div className="btn-text-group">
                    <span className="btn-text">Continue Reading</span>
                    <span className="btn-subtext">{continueLabel}</span>
                  </div>
                </Link>
              )}
              {firstChapter && (
                <Link
                  to={`/read/${encodeURIComponent(firstChapter.id)}`}
                  className="btn btn--primary btn--lg btn--outline"
                  aria-label="Read from beginning"
                >
                  <span className="btn-icon" aria-hidden="true">
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <polygon points="19 20 9 12 19 4 19 20" />
                      <line x1="5" y1="19" x2="5" y2="5" />
                    </svg>
                  </span>
                  <div className="btn-text-group">
                    <span className="btn-text">Read First</span>
                    <span className="btn-subtext">
                      {firstChapter.chapterNumber != null
                        ? `Chapter ${firstChapter.chapterNumber}`
                        : (firstChapter.title || 'First chapter')}
                    </span>
                  </div>
                </Link>
              )}
              {latestChapter && (
                <Link
                  to={`/read/${encodeURIComponent(latestChapter.id)}`}
                  className="btn btn--primary btn--lg btn--outline"
                  aria-label="Read latest chapter"
                >
                  <span className="btn-icon" aria-hidden="true">
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <polygon points="5 3 19 12 5 21 5 3" />
                      <line x1="19" y1="19" x2="19" y2="5" />
                    </svg>
                  </span>
                  <div className="btn-text-group">
                    <span className="btn-text">Read Latest</span>
                    <span className="btn-subtext">
                      {latestChapter.chapterNumber != null
                        ? `Chapter ${latestChapter.chapterNumber}`
                        : (latestChapter.title || 'Latest chapter')}
                    </span>
                  </div>
                </Link>
              )}
            </div>
            <div className="panel-details__toolbar" role="toolbar" aria-label="Panel actions">
              <div className="panel-details__toolbar-item panel-details__toolbar-item--bookmark">
                <BookmarkToggle panel={m} />
              </div>
              {bookmark && (
                <div className="panel-details__toolbar-item panel-details__toolbar-item--bookmark-folders">
                  <BookmarkFolderPicker panel={m} />
                </div>
              )}
              <div className="panel-details__toolbar-item panel-details__toolbar-item--rating">
                <StarRating panelId={id} rating={ratingQuery.data?.rating ?? null} />
              </div>
              <div className="panel-details__toolbar-item panel-details__toolbar-item--status">
                <ReadingListStatusControl
                  panelId={id}
                  current={readingListEntry?.status ?? null}
                  onUpsert={handleReadingListUpsert}
                  onRemove={handleReadingListRemove}
                />
              </div>
              <div className="panel-details__toolbar-item panel-details__toolbar-item--share">
                <button
                  type="button"
                  className="btn btn--ghost btn--icon-only"
                  aria-label="Share this panel"
                  onClick={() => setShareOpen(true)}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <circle cx="18" cy="5" r="3" />
                    <circle cx="6" cy="12" r="3" />
                    <circle cx="18" cy="19" r="3" />
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Synopsis Section */}
      {m.description && (
        <section
          className="panel-details__section panel-details__synopsis"
          aria-labelledby="synopsis-heading"
        >
          <header className="section-header">
            <h2 id="synopsis-heading" className="section-title">
              Synopsis
            </h2>
          </header>
          <div className="panel-details__description-wrapper">
            <p
              ref={synopsisRef}
              className={`panel-details__description${!showMoreSynopsis ? ' truncated' : ''}${!showMoreSynopsis && isSynopsisTruncated ? ' truncated--faded' : ''}`}
            >
              {m.description}
            </p>
            {isSynopsisTruncated && (
              <button
                type="button"
                className="btn btn--ghost btn--sm alt-titles__toggle synopsis__toggle"
                onClick={() => setShowMoreSynopsis(!showMoreSynopsis)}
                aria-expanded={showMoreSynopsis}
              >
                {showMoreSynopsis ? (
                  <>
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                    Show less
                  </>
                ) : (
                  <>
                    Show more
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </>
                )}
              </button>
            )}
          </div>
        </section>
      )}

      {/* Chapters Section with Sticky Header */}
      <section
        className="panel-details__section panel-details__chapters"
        aria-labelledby="chapters-heading"
      >
        <header className="section-header">
          <div className="section-heading">
            <h2 id="chapters-heading" className="section-title">
              Chapter List
            </h2>
            <button
              type="button"
              className={`chapter-list__refresh${
                refreshSpinning || chapters.isFetching ? ' chapter-list__refresh--busy' : ''
              }`}
              onClick={() => {
                refreshSpinStartedAt.current = Date.now();
                manualRefreshRef.current = true;
                setRefreshSpinning(true);
                // Refresh metadata (chapter count / latest chapter) too, not
                // just the list — the page no longer polls in the background.
                void Promise.all([panel.refetch(), chapters.refetch()]);
              }}
              aria-label="Refresh details and chapter list"
              title="Refresh details and chapter list"
              aria-busy={refreshSpinning || chapters.isFetching}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
          </div>
          <div className="section-controls">
            <div className="sort-toggle" role="group" aria-label="Chapter list controls">
              {/* Single cycling list control: Newest → Oldest →
                  Bookmarked Newest → Bookmarked Oldest → back around.
                  Bookmarked modes only filter the list; every row stays
                  readable in every mode. */}
              <button
                type="button"
                className={`sort-toggle__option${listMode.startsWith('bookmark') ? ' sort-toggle__option--accent-active' : ' sort-toggle__option--active'}`}
                onClick={() =>
                  setListMode((mode) => {
                    const idx = LIST_MODES.indexOf(mode);
                    return LIST_MODES[(idx + 1) % LIST_MODES.length] ?? 'newest';
                  })
                }
                aria-label={`Chapter list: ${LIST_MODE_LABELS[listMode]}${listMode.startsWith('bookmark') ? ` (${bookmarkedChapterIds.size} bookmarked)` : ''}. Activate to switch.`}
                title={`Chapter list: ${LIST_MODE_LABELS[listMode]}${listMode.startsWith('bookmark') ? ` (${bookmarkedChapterIds.size} bookmarked)` : ''} — click to cycle Newest → Oldest → Bookmarked Newest → Bookmarked Oldest`}
              >
                {(() => {
                  const ascending = listMode === 'oldest' || listMode === 'bookmark-oldest';
                  return (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      {ascending ? (
                        <>
                          <path d="m7 15 5 5 5-5" />
                          <path d="M12 20V4" />
                        </>
                      ) : (
                        <>
                          <path d="m7 9 5-5 5 5" />
                          <path d="M12 4v16" />
                        </>
                      )}
                    </svg>
                  );
                })()}
                {listMode.startsWith('bookmark') ? 'Bookmarked' : LIST_MODE_LABELS[listMode]}
              </button>
              {id && (
                <button
                  type="button"
                  className={`chapter-actions-toggle${showChapterActions ? ' chapter-actions-toggle--active' : ''}`}
                  onClick={() => setShowChapterActions((open) => !open)}
                  aria-expanded={showChapterActions}
                  aria-controls="chapter-bookmark-actions"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polygon points="12 2 2 7 12 12 22 7 12 2" />
                    <polyline points="2 17 12 22 22 17" />
                    <polyline points="2 12 12 17 22 12" />
                  </svg>
                  Actions
                  <span className="chapter-actions-toggle__chevron" aria-hidden="true">
                    <IconChevronDown size={14} />
                  </span>
                </button>
              )}
            </div>
            <div className="chapter-filter-wrapper">
              <div className="search-input-wrapper">
                <svg
                  className="search-icon"
                  aria-hidden="true"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  id="chapter-filter"
                  type="search"
                  className="input chapter-filter"
                  placeholder="Filter chapters…"
                  aria-label="Filter chapters by title"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                {filter && (
                  <button
                    type="button"
                    className="search-clear"
                    onClick={() => setFilter('')}
                    aria-label="Clear filter"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        </header>

{showChapterActions && (
          <div id="chapter-bookmark-actions" className="chapter-list__actions-panel">
            <ChapterBookmarkActions
              panelId={id}
              // Bulk panels act on the full filtered list, NOT the
              // collapsed 5-row slice — "Bookmark All (50)" means all 50,
              // no "Show more" needed first. The filter is still
              // respected (a search for "c200" scopes every bulk button
              // to the matches). Per-row checkboxes and the multi-select
              // toolbar intentionally stay on `visibleChapters` — they
              // operate on rendered rows.
              chapters={filteredAndSortedChapters}
              bookmarkedCount={
                [...bookmarkedChapterIds].filter((chapterId) =>
                  filteredAndSortedChapters.some((c) => c.id === chapterId),
                ).length
              }
              onClearReadTracker={handleClearReadTracker}
              markUntil={markUntil}
              /* The "Select chapters" entry button is now a sibling of the
                 "Mark All Read" pair, so the two bulk actions sit next to
                 each other in the same row. */
              selectChaptersSlot={
                <ChapterSelectEntryButton
                  chapters={filteredAndSortedChapters}
                  onEnter={() => setSelectionMode(true)}
                />
              }
            />
            <ChapterDownloadActions
              panelId={id}
              chapters={filteredAndSortedChapters}
              readChapterIds={readChapterIds}
              downloader={downloader}
              isChapterDone={chapterListDownloader.isDone}
              downloadSettings={downloadSettingsState.settings}
              onDownloadSettingsChange={downloadSettingsState.update}
              readerSettings={readerSettings}
              effectivePageConcurrency={effectivePageConcurrency}
              performanceMode={performanceMode}
            />
            <div className="chapter-list__actions-display">
              <span className="chapter-controls__filler">
                <span id="chapter-filler-toggle" className="chapter-controls__filler-label">
                  Show filler labels
                </span>
                <Switch
                  size="sm"
                  checked={detailsSettings.showFillerLabels}
                  labelledBy="chapter-filler-toggle"
                  onChange={(showFillerLabels) =>
                    saveDetailsSettings.mutate({ ...detailsSettings, showFillerLabels })
                  }
                />
              </span>
            </div>
            {/* Once selection mode is on, the multi-select toolbar
                (Select all / Bookmark N / Download N / Cancel) swaps in
                below the main action row. */}
            <ChapterOrderDialog
              open={selectedOrderPrompt}
              batchLabel={selectedChapters.length === 1 ? 'selected chapter' : 'selected chapters'}
              chapters={selectedChapters}
              isDone={chapterListDownloader.isDone}
              onPick={(order, scoped) => {
                setSelectedOrderPrompt(false);
                void handleDownloadSelected(order, scoped);
              }}
              onCancel={() => setSelectedOrderPrompt(false)}
            />
            <ChapterSelectActions
              chapters={visibleChapters}
              selectionMode={selectionMode}
              onExit={exitSelectionMode}
              selectedCount={selectedChapterIds.size}
              onSelectAll={handleSelectAllVisible}
              onClearSelection={handleClearSelection}
              onBookmarkSelected={handleBookmarkSelected}
              onDownloadSelected={requestSelectedDownload}
              onMarkSelectedRead={handleMarkSelectedRead}
              onMarkSelectedUnread={handleMarkSelectedUnread}
              isDownloading={downloader.isDownloading}
              isBookmarking={addChapterBookmarks.isPending}
              isMarking={bulkMarkSelected.isPending}
            />
          </div>
        )}

        {showChaptersLoading ? (
          <div className="chapters-loading" aria-live="polite" />
        ) : chapters.isError ? (
          <ErrorState
            title="Could not load chapters"
            message={chapters.error.message}
            onRetry={() => chapters.refetch()}
          />
        ) : filteredAndSortedChapters.length === 0 ? (
          <EmptyState
            title={
              listFilter === 'bookmarked'
                ? filter
                  ? 'No bookmarked chapters match your filter.'
                  : 'No bookmarked chapters yet.'
                : filter
                  ? 'No chapters match your filter.'
                  : 'No chapters found.'
            }
            message={
              listFilter === 'bookmarked'
                ? filter
                  ? undefined
                  : 'Bookmark chapters with the bookmark button on each row — they will show up here.'
                : filter
                  ? undefined
                  : "This source doesn't have any chapters yet."
            }
          />
        ) : (
          <div className={`chapter-list-container${selectionMode ? ' chapter-list-container--selecting' : ''}`}>
            <ChapterList
              chapters={visibleChapters}
              readChapterIds={readChapterIds}
              bookmarkedChapterIds={bookmarkedChapterIds}
              panelId={id}
              sortOrder={sortOrder}
              onChapterClick={navigateToChapter}
              onKeyDown={handleKeyDown}
              onChapterAction={handleChapterAction}
              onReadChapter={navigateToChapter}
              downloader={showChapterActions ? chapterListDownloader : undefined}
              selectionMode={selectionMode}
              selectedIds={selectedChapterIds}
              onToggleSelected={handleToggleSelected}
            />
          </div>
        )}
        {!showChaptersLoading && !chapters.isError && filteredAndSortedChapters.length > 5 && (
          <button
            type="button"
            className="btn btn--ghost btn--sm alt-titles__toggle chapter-list__toggle"
            onClick={() => setShowAllChapters((open) => !open)}
            aria-expanded={showAllChapters}
          >
            {showAllChapters ? (
              <>
                Show less
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="18 15 12 9 6 15" />
                </svg>
              </>
            ) : (
              <>
                Show more
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </>
            )}
          </button>
        )}
        {showAllChapters && filteredAndSortedChapters.length > 5 && (
          <div className="page-floating-nav" role="group" aria-label="Page navigation">
            <button
              type="button"
              className="page-floating-nav__btn"
              onClick={scrollToTop}
              aria-label="Scroll to top of page"
              title="Scroll to top"
            >
              <IconChevronUp size={18} />
            </button>
            <button
              type="button"
              className="page-floating-nav__btn"
              onClick={scrollToEnd}
              aria-label="Scroll to end of page"
              title="Scroll to end"
            >
              <IconChevronDown size={18} />
            </button>
          </div>
        )}
      </section>
      {shareOpen && (
        <ShareDialog
          title={panel.data?.title ?? id}
          url={window.location.href}
          onClose={() => setShareOpen(false)}
        />
      )}
      {coverZoomOpen && backdropCover && (
        <CoverLightbox
          title={panel.data?.title ?? id}
          src={backdropCover}
          onClose={() => setCoverZoomOpen(false)}
        />
      )}

    </div>
  );
}

/**
 * Entry button for the multi-select mode. Now lives in the same row as
 * "Mark All Read" (rendered via `ChapterBookmarkActions`'s
 * `selectChaptersSlot` prop), so the two bulk-action entry points read
 * as siblings. The active multi-select toolbar (Select all / Bookmark N
 * / Download N / Cancel) is rendered separately by `ChapterSelectActions`.
 */
function ChapterSelectEntryButton({
  chapters,
  onEnter,
}: {
  chapters: Chapter[];
  onEnter: () => void;
}) {
  return (
    <button
      type="button"
      className="btn btn--ghost btn--sm chapter-select-actions__entry"
      onClick={onEnter}
      disabled={chapters.length === 0}
      aria-label="Enter chapter multi-select mode"
      title="Pick a few chapters to bookmark or download them in one batch"
    >
      <span aria-hidden="true">
        <IconCheck size={14} />
      </span>
      Select chapters
    </button>
  );
}

/**
 * Multi-select toolbar — only renders when selection mode is active. The
 * "Select chapters" entry button that previously lived in this component
 * has moved to `ChapterSelectEntryButton` so it can sit next to "Mark All
 * Read" in the same row. While active, this toolbar drives the per-row
 * checkbox state.
 *
 * The download reuses the same `useChapterDownloader` instance the
 * per-row icons and the bulk "Download all" panel share, so a selected
 * batch and a "Download all" batch serialize through the same queue.
 */
function ChapterSelectActions({
  chapters,
  selectionMode,
  onExit,
  selectedCount,
  onSelectAll,
  onClearSelection,
  onBookmarkSelected,
  onDownloadSelected,
  onMarkSelectedRead,
  onMarkSelectedUnread,
  isDownloading,
  isBookmarking,
  isMarking,
}: {
  chapters: Chapter[];
  selectionMode: boolean;
  onExit: () => void;
  selectedCount: number;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBookmarkSelected: () => void;
  onDownloadSelected: () => void;
  onMarkSelectedRead: () => void;
  onMarkSelectedUnread: () => void;
  isDownloading: boolean;
  isBookmarking: boolean;
  isMarking: boolean;
}) {
  const { enabled: incognito } = useIncognito();
  if (!selectionMode) return null;

  const allSelected = chapters.length > 0 && selectedCount === chapters.length;
  const noSelection = selectedCount === 0;
  const busy = isDownloading || isBookmarking || isMarking;

  return (
    <div
      className="chapter-select-actions"
      role="toolbar"
      aria-label="Chapter multi-select actions"
    >
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={allSelected ? onClearSelection : onSelectAll}
        disabled={chapters.length === 0}
        aria-label={
          allSelected
            ? 'Clear selection across all visible chapters'
            : `Select all ${chapters.length} visible chapters`
        }
        title={allSelected ? 'Clear selection' : 'Select all visible'}
      >
        <span aria-hidden="true">
          <IconCheck size={14} />
        </span>
        {allSelected ? 'Clear' : `Select all (${chapters.length})`}
      </button>

      {!incognito && (
      <button
        type="button"
        className="btn btn--ghost btn--sm chapter-select-actions__bookmark"
        onClick={onBookmarkSelected}
        disabled={noSelection || busy}
        aria-label={`Bookmark ${selectedCount} selected chapter${selectedCount === 1 ? '' : 's'}`}
        title={
          noSelection
            ? 'Pick at least one chapter to bookmark'
            : isBookmarking
              ? 'Bookmarking in progress'
              : 'Bookmark the selected chapters'
        }
      >
        <span aria-hidden="true">
          <IconBookmark size={14} />
        </span>
        Bookmark selected ({selectedCount})
      </button>
      )}

      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={onMarkSelectedRead}
        disabled={noSelection || busy}
        aria-label={`Mark ${selectedCount} selected chapter${selectedCount === 1 ? '' : 's'} as read`}
        title={
          noSelection
            ? 'Pick at least one chapter to mark read'
            : isMarking
              ? 'Marking in progress'
              : 'Mark the selected chapters as read'
        }
      >
        <span aria-hidden="true">
          <IconCheck size={14} />
        </span>
        Mark read selected ({selectedCount})
      </button>

      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={onMarkSelectedUnread}
        disabled={noSelection || busy}
        aria-label={`Unmark ${selectedCount} selected chapter${selectedCount === 1 ? '' : 's'} (clear read state)`}
        title={
          noSelection
            ? 'Pick at least one chapter to unmark'
            : isMarking
              ? 'Marking in progress'
              : 'Clear the read state for the selected chapters'
        }
      >
        <span aria-hidden="true">
          <IconUndo size={14} />
        </span>
        Unmark selected ({selectedCount})
      </button>

      <button
        type="button"
        className="btn btn--primary btn--sm"
        onClick={onDownloadSelected}
        disabled={noSelection || busy}
        aria-label={`Download ${selectedCount} selected chapter${selectedCount === 1 ? '' : 's'}`}
        title={
          noSelection
            ? 'Pick at least one chapter to download'
            : isDownloading
              ? 'A download is already running'
              : 'Download the selected chapters'
        }
      >
        <span aria-hidden="true">
          <IconDownload size={14} />
        </span>
        Download selected ({selectedCount})
      </button>

      <button
        type="button"
        className="btn btn--ghost btn--sm chapter-select-actions__cancel"
        onClick={onExit}
        aria-label="Exit multi-select mode"
        title="Exit multi-select mode"
      >
        <span aria-hidden="true">
          <IconX size={14} />
        </span>
        Cancel
      </button>
    </div>
  );
}

function DetailsError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="page panel-details" aria-labelledby="error-heading">
      <ErrorState title="Could not load this panel" message={error.message} onRetry={onRetry} />
    </div>
  );
}
