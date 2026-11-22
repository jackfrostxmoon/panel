import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { BackupExportScope, Bookmark, CardLayout, PanelStatus } from '@panel/shared';
import { api } from '../api/client';
import {
  useAddBookmark,
  useAddBookmarkToFolder,
  useBookmarkFolders,
  useBookmarks,
  useBookmarksSettings,
  useChapterBookmarkPanels,
  useClearImageCacheByTag,
  useLatest,
  useRemoveBookmark,
  useRemoveBookmarkFromFolder,
  useSaveBookmarksSettings,
  useSourceOrder,
  useTags,
} from '../api/hooks';
import {
  countDumpRows,
  downloadSqlDump,
  isSqlDump,
  parseBookmarkImport,
} from '../utils/bookmarkExport';
import { ALL_BOOKMARKS_ID, BookmarkFolderSelector } from '../components/BookmarkFolderSelector';
import { BackupExportDialog } from '../components/BackupExportDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CoverImage } from '../components/CoverImage';
import { CoverZoomButton } from '../components/CoverZoomButton';
import { DragFolderOverlay } from '../components/DragFolderOverlay';
import { FilterSearchBar } from '../components/FilterSearchBar';
import { FolderPickerDialog } from '../components/FolderPickerDialog';
import { GenreMultiSelect } from '../components/GenreMultiSelect';
import { IconChevronDown, IconFolder, IconTrash } from '../components/icons';
import {
  CardLayoutToggle,
  PanelList,
  PanelListRow,
} from '../components/PanelList';
import { hideCoverPreview, showCoverPreview } from '../components/coverPreview';
import { SourceFilter } from '../components/SourceFilter';
import { Switch } from '../components/Switch';
import { EmptyState, ErrorState } from '../components/StateView';
import { useToast } from '../components/Toast';
import { useActiveFolderContents } from '../hooks/useActiveFolderContents';
import { useDisplaySettings } from '../hooks/useDisplaySettings';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useFastScrollKeys } from '../hooks/useFastScrollKeys';
import { readDefaultFolderId, writeDefaultFolderId } from '../utils/defaultBookmarkFolder';
import { bookmarkMatchesQuery } from '../utils/bookmarkSearch';
import { effectiveHiddenSources, formatBytes, sourceLabel } from '../utils/format';
import { rankByLatestFeed, sortBookmarks, sortByCreatedAt } from '../utils/latestFeedOrder';

/**
 * Initial + incremental render window for the shelf. The filter/sort above
 * runs on the full array, but only this many cards are mounted (and only
 * their covers fetched) until the scroll sentinel appends more — the same
 * scroll-to-load-more feel as the latest page's infinite scroll, except
 * client-side (the shelf arrives as one payload, so there is no next page
 * to fetch).
 */
const PAGE_SIZE = 30;

/**
 * Bookmarks screen: every bookmarked panel as a modern card grid with
 * continue-reading badges, a source filter, and hover-revealed actions.
 */
export function BookmarksPage() {
  useDocumentTitle('Bookmarks');
  // W/S hold-to-glide fast scroll (shared with the latest page).
  useFastScrollKeys();
  const bookmarks = useBookmarks();
  const clearCoverMutation = useClearImageCacheByTag();
  /** Per-panel nonce to bust the browser cache after a cover clear. */
  const [coverNonces, setCoverNonces] = useState<ReadonlyMap<string, number>>(new Map());
  /** Delete the cached cover so a wrong/stale image refetches — same as
   *  the details-page hero trash button. No confirm, nonce refetch. */
  const handleClearCover = (bookmark: Bookmark) => {
    clearCoverMutation.mutate(
      { what: 'cover', tag: bookmark.panelId },
      {
        onSuccess: (result) => {
          setCoverNonces((prev) => {
            const next = new Map(prev);
            next.set(bookmark.panelId, (prev.get(bookmark.panelId) ?? 0) + 1);
            return next;
          });
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
  const removeBookmark = useRemoveBookmark();
  const { toast } = useToast();
  const [pendingRemoval, setPendingRemoval] = useState<Bookmark | null>(null);
  /**
   * Source pill filter — persisted in the URL (`/bookmarks?source=roliascan`)
   * exactly like the latest page, so a refresh, share or back-navigation
   * restores the selection. No param → "All". Pill taps push a history
   * entry; the automatic hidden-source remap below replaces it.
   */
  const [params, setParams] = useSearchParams();
  const sourceFilter = params.get('source') ?? '';
  /** Write the source param, keeping any other params untouched. The
      functional updater reads the latest URL state, so a source change and
      a simultaneous search-param write can't clobber each other. */
  const setSourceFilter = useCallback(
    (next: string, { replace = false }: { replace?: boolean } = {}) => {
      setParams(
        (prev) => {
          const nextParams = new URLSearchParams(prev);
          if (next) nextParams.set('source', next);
          else nextParams.delete('source');
          return nextParams;
        },
        replace ? { replace: true } : undefined,
      );
    },
    [setParams],
  );
  /**
   * Sources hidden via the Sources page toggle — their pills vanish (via
   * SourceFilter) and their cards are filtered out of the grid below.
   */
  const sourceOrder = useSourceOrder();
  const hiddenSources = useMemo(
    () => effectiveHiddenSources(sourceOrder.data?.hidden),
    [sourceOrder.data?.hidden],
  );
  // A toggle flipped while this filter points at the source resets to All
  // (the pill is gone, so the stale value would otherwise show nothing).
  // Replaces the URL entry — an automatic remap isn't a place in history.
  useEffect(() => {
    if (sourceFilter !== '' && hiddenSources.has(sourceFilter)) setSourceFilter('', { replace: true });
  }, [sourceFilter, hiddenSources, setSourceFilter]);
  /**
   * Bookmarks-page settings (`data/display/bookmarks.json`) — declared
   * early because the feed hooks and the shelf-sort memo below read the
   * pending sort toggle. While a save is in flight the pending value wins
   * so the switch flips instantly instead of waiting for the round-trip.
   */
  const bookmarksSettingsQuery = useBookmarksSettings();
  const saveBookmarksSettings = useSaveBookmarksSettings();
  /**
   * Shelf ordering, persisted server-side. On (default) fresh updates
   * bubble to the top; off ignores chapter-cache timestamps and shows
   * most recently added first.
   */
  const sortByLatestUpdate: boolean =
    saveBookmarksSettings.isPending && saveBookmarksSettings.variables
      ? (saveBookmarksSettings.variables.sortByLatestUpdate ?? true)
      : (bookmarksSettingsQuery.data?.sortByLatestUpdate ?? true);
  /**
   * "Ask where to save" — auto-open the Choose folders dialog on the details
   * page after bookmarking. Persisted server-side; threaded through the
   * full-replace saves below so it survives every settings write.
   */
  const autoOpenFolderPicker: boolean =
    saveBookmarksSettings.isPending && saveBookmarksSettings.variables
      ? (saveBookmarksSettings.variables.autoOpenFolderPicker ?? true)
      : (bookmarksSettingsQuery.data?.autoOpenFolderPicker ?? true);
  /**
   * Include-genre mode: when on, a bookmark must carry every selected genre
   * (AND); when off, any selected genre matches (OR). Pending-wins so the
   * switch flips instantly instead of waiting for the round-trip. Declared
   * before the sort memo because the memo reads it.
   */
  const matchAllGenres: boolean =
    saveBookmarksSettings.isPending && saveBookmarksSettings.variables
      ? (saveBookmarksSettings.variables.matchAllGenres ?? false)
      : (bookmarksSettingsQuery.data?.matchAllGenres ?? false);
  /**
   * Latest-updates feed for the single selected source (pages 1–3). Used to
   * re-order the shelf the way the source site itself lists recently
   * updated titles, instead of the local chapter-cache recency sort.
   * Always registered (hook count stays static); disabled — and unfetched —
   * until a pill is picked (and the "Sort by latest update" switch is on),
   * which keeps All-bookmarks traffic at zero. The
   * server caches `latest:<page>:<source>` and persists the last good fetch
   * (`list_cache`), so re-picking a pill is cheap and offline falls back to
   * the last known feed. Pages 2–3 widen the window; a bookmark outside it
   * keeps the default recency order at the bottom.
   */
  const feedSource = sourceFilter !== '' && sortByLatestUpdate ? sourceFilter : undefined;
  const feedPage1 = useLatest(1, feedSource, undefined, undefined, {
    enabled: feedSource !== undefined,
    placeholderData: (previous) => previous,
  });
  const feedPage2 = useLatest(2, feedSource, undefined, undefined, {
    enabled: feedSource !== undefined,
    placeholderData: (previous) => previous,
  });
  const feedPage3 = useLatest(3, feedSource, undefined, undefined, {
    enabled: feedSource !== undefined,
    placeholderData: (previous) => previous,
  });
  const latestFeedPages = useMemo(
    () => [feedPage1.data, feedPage2.data, feedPage3.data],
    [feedPage1.data, feedPage2.data, feedPage3.data],
  );
  /** True while at least one feed page carries results — the ordering
      switches to feed order only then; loading/error/offline silently keep
      the default recency sort. */
  const latestFeedReady = latestFeedPages.some((page) => (page?.results.length ?? 0) > 0);
  /** True while any feed page fetch is in flight — shown as an inline,
      non-blocking badge. The grid stays fully interactive (cards can be
      opened while re-ranking happens in the background). */
  const latestFeedFetching = feedPage1.isFetching || feedPage2.isFetching || feedPage3.isFetching;
  /**
   * Local filter query, mirrored to the URL (`/bookmarks?q=…`) like the
   * search page so refreshes, shared links and back-navigation keep the
   * term. Typing updates a local draft immediately (the shelf filters on
   * every keystroke); a short debounce writes it to the URL with `replace`
   * so the history isn't spammed. An external URL change (back/forward,
   * deep link) flows the other way through the sync effect below.
   */
  const queryParam = params.get('q') ?? '';
  const [query, setQuery] = useState(queryParam);
  /**
   * Last value this page wrote to (or read from) the URL. It keeps the
   * debounced write and the URL→draft sync from fighting: a URL update we
   * just caused must not overwrite newer keystrokes typed while it landed.
   */
  const lastUrlQueryRef = useRef(queryParam);
  useEffect(() => {
    if (queryParam === lastUrlQueryRef.current) return;
    lastUrlQueryRef.current = queryParam;
    setQuery(queryParam);
  }, [queryParam]);
  useEffect(() => {
    if (query === lastUrlQueryRef.current) return;
    const timer = window.setTimeout(() => {
      lastUrlQueryRef.current = query;
      setParams(
        (prev) => {
          const nextParams = new URLSearchParams(prev);
          if (query) nextParams.set('q', query);
          else nextParams.delete('q');
          return nextParams;
        },
        { replace: true },
      );
    }, 150);
    return () => window.clearTimeout(timer);
  }, [query, setParams]);
  /** Custom-tag filter (T3-4): show only bookmarks carrying the selected tag. */
  const [tagFilter, setTagFilter] = useState('');
  /** Status / genre filters (mirror the latest page): narrow the shelf
      client-side by the cached panel metadata. Include is OR; exclude
      wins over include. */
  const [statusFilter, setStatusFilter] = useState<PanelStatus | ''>('');
  const [genreFilter, setGenreFilter] = useState<string[]>([]);
  const [excludedGenre, setExcludedGenre] = useState<string[]>([]);
  /** Bookmarked-chapters filter: narrow the shelf to panels that do (or
      don't) have at least one bookmarked chapter. `all` keeps everything. */
  const [chapterBookmarkFilter, setChapterBookmarkFilter] = useState<'all' | 'with' | 'without'>('all');
  const chapterBookmarkPanels = useChapterBookmarkPanels();
  const allTags = useTags();
  /** Active folder (T2-8). `null` = the user's default folder (Reading
   *  list by default, or whichever folder the user has explicitly
   *  promoted via "Set as default"). `'__all__'` = every bookmark
   *  across every folder (the legacy "show everything" view). */
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  /** User-chosen default folder id (localStorage only). Null until the
   *  folders query resolves or the user picks one — the system default
   *  folder is the implicit default until then. */
  const [userDefaultFolderId, setUserDefaultFolderId] = useState<string | null>(() =>
    readDefaultFolderId(),
  );

  /** All folders + system default id — used by the per-card picker,
   *  drag/drop overlay, and the selector. */
  const allFoldersQuery = useBookmarkFolders();
  const allFolders = useMemo(
    () => allFoldersQuery.data?.folders ?? [],
    [allFoldersQuery.data?.folders],
  );
  const systemDefaultFolderId = allFoldersQuery.data?.defaultId ?? null;

  /** Effective folder shown when `activeFolderId === null`: the user's
   *  chosen default if it still exists (or is the all-bookmarks sentinel),
   *  otherwise the system All bookmarks, otherwise null (loading). */
  const effectiveDefaultFolderId = useMemo(() => {
    if (!userDefaultFolderId) return systemDefaultFolderId;
    if (userDefaultFolderId === ALL_BOOKMARKS_ID) return ALL_BOOKMARKS_ID;
    if (allFolders.some((f) => f.id === userDefaultFolderId)) return userDefaultFolderId;
    return systemDefaultFolderId;
  }, [userDefaultFolderId, allFolders, systemDefaultFolderId]);

  /** True when the active (or default) view is the all-bookmarks list. */
  const viewingAll =
    activeFolderId === ALL_BOOKMARKS_ID ||
    (activeFolderId === null && effectiveDefaultFolderId === ALL_BOOKMARKS_ID);
  const activeFolderQueryId: string | null = viewingAll
    ? null
    : (activeFolderId ?? effectiveDefaultFolderId);
  const folderContents = useActiveFolderContents(
    viewingAll ? null : activeFolderQueryId,
  );

  /** Helper for "Set as default" — also clears the value if the user
   *  passes null (reset to All bookmarks). Local-only: no reader-settings
   *  round trip, so switching the default never blocks the grid. */
  const setAsDefault = useCallback((folderId: string | null) => {
    writeDefaultFolderId(folderId);
    setUserDefaultFolderId(folderId);
  }, []);

  /** Bookmark id currently open in the per-card FolderPicker. */
  const [pickerBookmark, setPickerBookmark] = useState<Bookmark | null>(null);

  // When a folder is active we render its items instead of the flat bookmark list.
  const sourceData = useMemo(
    () =>
      viewingAll
        ? (bookmarks.data ?? [])
        : (folderContents.data?.items ?? []),
    [viewingAll, bookmarks.data, folderContents.data],
  );
  const sourceIsLoading = viewingAll ? bookmarks.isLoading : folderContents.isLoading;
  const { settings } = useDisplaySettings();
  const sourceIsError = viewingAll ? bookmarks.isError : folderContents.isError;

  /** Genres across the bookmarks in view, for the dropdown options. Every
      option matches at least one bookmark by construction. Deduplicated
      case-insensitively (stale rows may carry "action" vs "Action"). */
  const availableGenres = useMemo(() => {
    const seen = new Set<string>();
    const genres: string[] = [];
    const all = sourceData.flatMap((bookmark) => bookmark.genres ?? []);
    for (const genre of all) {
      const key = genre.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      genres.push(genre);
    }
    return genres.sort((a, b) => a.localeCompare(b));
  }, [sourceData]);

  /** Case-insensitive set of the selected include genres (AND semantics). */
  const includeSet = useMemo(
    () => new Set(genreFilter.map((g) => g.toLowerCase())),
    [genreFilter],
  );
  /** Case-insensitive set of the excluded genres (ANY match drops the card). */
  const excludeSet = useMemo(
    () => new Set(excludedGenre.map((g) => g.toLowerCase())),
    [excludedGenre],
  );
  /** Global panel id → bookmarked-chapter count (absent = 0). */
  const chapterBookmarkCountByPanel = useMemo(
    () => new Map((chapterBookmarkPanels.data ?? []).map((s) => [s.panelId, s.count] as const)),
    [chapterBookmarkPanels.data],
  );

  const sorted = useMemo(() => {
    if (!sourceData) return [];
    const needle = query.trim().toLowerCase();
    // Map global panel id → tag names so we can filter bookmarks by tag.
    const panelTags = new Map<string, Set<string>>();
    for (const tag of allTags.data ?? []) {
      for (const panelId of tag.panelIds) {
        if (!panelTags.has(panelId)) panelTags.set(panelId, new Set());
        panelTags.get(panelId)!.add(tag.name);
      }
    }
    const filtered = sourceData.filter(
      (bookmark) =>
        (!sourceFilter || bookmark.source === sourceFilter) &&
        !hiddenSources.has(bookmark.source) &&
        (!needle || bookmarkMatchesQuery(bookmark, needle)) &&
        (!tagFilter || panelTags.get(bookmark.panelId)?.has(tagFilter)) &&
        (!statusFilter || bookmark.status === statusFilter) &&
        (chapterBookmarkFilter === 'all' ||
          ((chapterBookmarkCountByPanel.get(bookmark.panelId) ?? 0) > 0) ===
            (chapterBookmarkFilter === 'with')) &&
        (includeSet.size === 0 ||
          (matchAllGenres
            ? [...includeSet].every((g) =>
                (bookmark.genres ?? []).some((bg) => bg.toLowerCase() === g),
              )
            : (bookmark.genres ?? []).some((g) => includeSet.has(g.toLowerCase())))) &&
        (excludeSet.size === 0 ||
          !(bookmark.genres ?? []).some((g) => excludeSet.has(g.toLowerCase()))),
    );
    // "Sort by latest update" off — ignore chapter-cache timestamps and
    // show most recently added first.
    if (!sortByLatestUpdate) return sortByCreatedAt(filtered);
    // Single-source pill active + a feed page loaded → order by the
    // source's own latest-updates feed (titles outside the fetched window
    // keep the default recency sort behind them).
    if (sourceFilter && latestFeedReady) return rankByLatestFeed(filtered, latestFeedPages);
    return sortBookmarks(filtered);
  }, [sourceData, sourceFilter, hiddenSources, query, tagFilter, statusFilter, chapterBookmarkFilter, chapterBookmarkCountByPanel, includeSet, excludeSet, matchAllGenres, allTags.data, latestFeedReady, latestFeedPages, sortByLatestUpdate]);

  /** Render window into `sorted` (see PAGE_SIZE): only these cards are
   *  mounted, so a 200-title shelf issues ~30 cover fetches up front and
   *  appends more as the sentinel scrolls into view. */
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Fresh result identity (folder / filters / search) — rewind to the
  // first window so page 2 of the old filter never leaks in. Data
  // refetches alone don't reset (that would yank the scroll position).
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [
    viewingAll,
    activeFolderQueryId,
    sourceFilter,
    query,
    tagFilter,
    statusFilter,
    chapterBookmarkFilter,
    genreFilter,
    excludedGenre,
  ]);

  const rendered = useMemo(() => sorted.slice(0, visibleCount), [sorted, visibleCount]);
  const hasMoreToShow = visibleCount < sorted.length;

  // Scroll sentinel (mirrors the latest page): when the marker scrolls
  // into view, widen the window. Idle until at least one card renders so
  // the observer never fires against an empty grid.
  useEffect(() => {
    if (!hasMoreToShow || rendered.length === 0) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((count) => Math.min(count + PAGE_SIZE, sorted.length));
        }
      },
      { rootMargin: '600px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreToShow, rendered.length, sorted.length]);

  /** Folder id → name for the per-card folder pills (one map lookup per
   *  card instead of an `allFolders.find` scan). */
  const folderNameById = useMemo(
    () => new Map(allFolders.map((f) => [f.id, f.name] as const)),
    [allFolders],
  );

  /** Any narrowing filter active (drives the no-matches empty state). */
  const filtersActive =
    sourceFilter !== '' ||
    query.trim() !== '' ||
    tagFilter !== '' ||
    statusFilter !== '' ||
    chapterBookmarkFilter !== 'all' ||
    genreFilter.length > 0 ||
    excludedGenre.length > 0;

  /** Applied-refinement count for the filters disclosure badge (excludes
      the always-visible source pills and title search). */
  const activeFilterCount =
    (tagFilter !== '' ? 1 : 0) +
    (statusFilter !== '' ? 1 : 0) +
    (chapterBookmarkFilter !== 'all' ? 1 : 0) +
    genreFilter.length +
    excludedGenre.length;

  function clearAllFilters() {
    // Bulk reset — refine params, don't litter history with an entry.
    setSourceFilter('', { replace: true });
    setQuery('');
    setTagFilter('');
    setStatusFilter('');
    setChapterBookmarkFilter('all');
    setGenreFilter([]);
    setExcludedGenre([]);
  }

  const handleRemove = async () => {
    if (!pendingRemoval) return;
    try {
      await removeBookmark.mutateAsync({ id: pendingRemoval.id, panelId: pendingRemoval.panelId });
      toast(`Removed "${pendingRemoval.title}" from bookmarks`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not remove bookmark.', 'error');
    } finally {
      setPendingRemoval(null);
    }
  };

  // --- Drag and drop between folders (T2-8) ------------------------------
  const addToFolder = useAddBookmarkToFolder();
  const removeFromFolder = useRemoveBookmarkFromFolder();
  /**
   * Move a bookmark to a target folder. If the bookmark is already in the
   * folder, this is a no-op (the API's onConflictDoNothing returns
   * created=false). Removes from every OTHER folder — including the
   * default All bookmarks — so the bookmark ends up in EXACTLY the chosen
   * folder. The picker dialog remains the way to put a bookmark in
   * multiple folders at once.
   */
  const moveToFolder = useCallback(
    async (bookmark: Bookmark, targetFolderId: string) => {
      const current = new Set(bookmark.folderIds ?? []);
      // Add the new target first so a drop on a folder it already lives in
      // is a silent no-op rather than a remove-then-re-add round trip.
      if (!current.has(targetFolderId)) {
        await addToFolder.mutateAsync({ folderId: targetFolderId, bookmarkId: bookmark.id });
        current.add(targetFolderId);
      }
      // Strip the bookmark from every other folder so it lives in exactly
      // one. The drop is a "move", not an "add" — if the user wants to be
      // in multiple folders they use the FolderPickerDialog on the card.
      const toRemove: string[] = [];
      for (const id of current) {
        if (id === targetFolderId) continue;
        toRemove.push(id);
      }
      for (const folderId of toRemove) {
        await removeFromFolder.mutateAsync({ folderId, bookmarkId: bookmark.id });
      }
      const target = allFolders.find((f) => f.id === targetFolderId);
      toast(`Moved to "${target?.name ?? 'folder'}"`, 'success');
    },
    [addToFolder, removeFromFolder, allFolders, toast],
  );

  /** Maps a single dragged bookmark id → bookmark for use by the drop
   *  targets. The data transfer payload is just the id (we already have
   *  the full list in sourceData). */
  const draggedBookmark = useRef<Bookmark | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** Full-screen folder picker overlay. Open for the entire drag — closed
   *  on drop, Escape, or `dragend` without a successful drop. */
  const [dragOverlayOpen, setDragOverlayOpen] = useState(false);

  const handleDragStart = useCallback(
    (event: React.DragEvent, bookmark: Bookmark) => {
      draggedBookmark.current = bookmark;
      setDraggingId(bookmark.id);
      setDragOverlayOpen(true);
      // Required for Firefox; custom type lets us reject unrelated drops.
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/x-bookmark-id', bookmark.id);
      // A subtle drag image — the browser default is fine, but a muted copy
      // makes the intent clear without grabbing focus.
      const target = event.currentTarget as HTMLElement;
      if (target.firstElementChild) {
        event.dataTransfer.setDragImage(target.firstElementChild as Element, 20, 20);
      }
    },
    [],
  );
  const handleDragEnd = useCallback(() => {
    draggedBookmark.current = null;
    setDraggingId(null);
    setDragOverlayOpen(false);
  }, []);
  const handleDrop = useCallback(
    async (targetFolderId: string) => {
      const bookmark = draggedBookmark.current;
      draggedBookmark.current = null;
      setDraggingId(null);
      setDragOverlayOpen(false);
      if (!bookmark) return;
      try {
        await moveToFolder(bookmark, targetFolderId);
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Could not move bookmark.', 'error');
      }
    },
    [moveToFolder, toast],
  );
  const handleDragCancel = useCallback(() => {
    draggedBookmark.current = null;
    setDraggingId(null);
    setDragOverlayOpen(false);
  }, []);

  // Document-level dragstart/dragend keep the overlay in sync even if
  // the source's onDragEnd never fires (e.g. when the drag is cancelled
  // by the OS). The MIME-type filter rejects unrelated drags (file drops
  // from the desktop, etc.).
  useEffect(() => {
    function onDragStart(event: DragEvent) {
      if (event.dataTransfer?.types.includes('text/x-bookmark-id')) {
        setDragOverlayOpen(true);
      }
    }
    function onDragEnd() {
      setDragOverlayOpen(false);
    }
    document.addEventListener('dragstart', onDragStart);
    document.addEventListener('dragend', onDragEnd);
    return () => {
      document.removeEventListener('dragstart', onDragStart);
      document.removeEventListener('dragend', onDragEnd);
    };
  }, []);

  /** Folders the user can drop onto via the full-screen overlay. Excludes
   *  the default All bookmarks since dropping onto it is a no-op (the
   *  bookmark already lives there). */
  const droppableFolders = useMemo(
    () => allFolders.filter((f) => !f.isDefault),
    [allFolders],
  );

  /** Mobile edit-mode: reveals the per-card Remove buttons. */
  const [manageMode, setManageMode] = useState(false);

  /**
   * Cards/list layout, persisted server-side to `data/display/bookmarks.json`.
   * While a save is in flight the pending value wins so the toggle flips
   * instantly instead of waiting for the round-trip. (`bookmarksSettingsQuery`
   * / `saveBookmarksSettings` are declared near the sort memo above.)
   */
  const cardLayout: CardLayout =
    saveBookmarksSettings.isPending && saveBookmarksSettings.variables
      ? saveBookmarksSettings.variables.cardLayout
      : (bookmarksSettingsQuery.data?.cardLayout ?? 'cards');
  /**
   * Collapsed refinement filters, persisted server-side to
   * `data/display/bookmarks.json`. Collapsed by default so the toolbar
   * stays compact; same pending-wins pattern as the layout toggle.
   */
  const filtersCollapsed: boolean =
    saveBookmarksSettings.isPending && saveBookmarksSettings.variables
      ? saveBookmarksSettings.variables.filtersCollapsed
      : (bookmarksSettingsQuery.data?.filtersCollapsed ?? true);
  /**
   * Don't paint either layout until the persisted choice resolves — a hard
   * refresh would otherwise flash the card grid (the `?? 'cards'` fallback)
   * for a beat even when list mode is stored. Errors fall back to cards.
   * Renders nothing while waiting (the page has no spinner; content is
   * usually still loading in the same window anyway).
   */
  const layoutReady =
    (saveBookmarksSettings.isPending && saveBookmarksSettings.variables != null) ||
    bookmarksSettingsQuery.isSuccess ||
    bookmarksSettingsQuery.isError;

  /**
   * Dedicated search-bar visibility, persisted server-side to
   * `data/display/bookmarks.json` alongside the other toggles. Same
   * pending-wins pattern so the button flips instantly.
   */
  const searchOpen: boolean =
    saveBookmarksSettings.isPending && saveBookmarksSettings.variables
      ? (saveBookmarksSettings.variables.searchOpen ?? false)
      : (bookmarksSettingsQuery.data?.searchOpen ?? false);

  function handleLayoutChange(next: CardLayout) {
    if (next === cardLayout) return;
    saveBookmarksSettings.mutate({ cardLayout: next, filtersCollapsed, searchOpen, sortByLatestUpdate, autoOpenFolderPicker, matchAllGenres });
  }

  function handleFiltersToggle(next: boolean) {
    if (next === filtersCollapsed) return;
    saveBookmarksSettings.mutate({ cardLayout, filtersCollapsed: next, searchOpen, sortByLatestUpdate, autoOpenFolderPicker, matchAllGenres });
  }

  function handleSearchToggle() {
    saveBookmarksSettings.mutate({ cardLayout, filtersCollapsed, searchOpen: !searchOpen, sortByLatestUpdate, autoOpenFolderPicker, matchAllGenres });
  }

  function handleMatchAllGenresToggle(next: boolean) {
    saveBookmarksSettings.mutate({
      cardLayout,
      filtersCollapsed,
      searchOpen,
      sortByLatestUpdate,
      autoOpenFolderPicker,
      matchAllGenres: next,
    });
  }

  // --- Export / Import (.sql dump) --------------------------------------------
  const addBookmark = useAddBookmark();
  const queryClient = useQueryClient();
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  /** Export-scope picker popup (full backup vs bookmarks-only). */
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  const handleExport = async (scope: BackupExportScope) => {
    setExporting(true);
    try {
      const dump = await api.exportBackup(scope);
      downloadSqlDump(dump, scope);
      const count = countDumpRows(dump, 'bookmarks');
      toast(
        scope === 'minimal'
          ? `Exported bookmarks-only backup (.sql) with ${count} bookmark${count === 1 ? '' : 's'}.`
          : `Exported full backup (.sql) with ${count} bookmark${count === 1 ? '' : 's'}.`,
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Export failed.', 'error');
    } finally {
      setExporting(false);
    }
  };

  /** Legacy JSON fallback: files exported before the .sql dump existed. */
  const handleLegacyJsonImport = async (raw: string) => {
    const entries = parseBookmarkImport(raw);
    let added = 0;
    let existed = 0;
    for (const entry of entries) {
      try {
        const result = await addBookmark.mutateAsync({
          panelId: entry.panelId,
          title: entry.title,
          coverUrl: entry.coverUrl,
          source: entry.source,
          sourceUrl: entry.sourceUrl,
        });
        if (result.createdAt === result.updatedAt) added += 1;
        else existed += 1;
      } catch {
        // Skip entries the source layer rejects (e.g. malformed ids).
      }
    }
    toast(`Imported ${added} new bookmark${added === 1 ? '' : 's'}${existed > 0 ? ` (${existed} already saved)` : ''}.`);
  };

  const handleImportFile = async (file: File) => {
    setImporting(true);
    try {
      const raw = await file.text();
      if (isSqlDump(raw)) {
        const result = await api.importBackup(raw, (done, total) =>
          setImportProgress(total > 1 ? `${done}/${total}` : null),
        );
        await queryClient.invalidateQueries();
        const added = result.tables['bookmarks'] ?? 0;
        toast(`Backup restored (.sql) — ${added} bookmark${added === 1 ? '' : 's'} processed.`);
      } else {
        await handleLegacyJsonImport(raw);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Import failed.', 'error');
    } finally {
      setImporting(false);
      setImportProgress(null);
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  return (
    <div className="page">
      <h1 className="sr-only">
        {activeFolderId && activeFolderId !== ALL_BOOKMARKS_ID ? 'Folder' : 'Bookmarks'}
      </h1>

      {/* One unified toolbar: folder picker + source/tag filters + search + import/export. */}
      <div className="bookmarks-toolbar">
        <BookmarkFolderSelector
          activeFolderId={activeFolderId}
          defaultFolderId={userDefaultFolderId ?? systemDefaultFolderId}
          onPick={setActiveFolderId}
          onSetDefault={setAsDefault}
          menuActions={(close) => (
            <>
              <button
                type="button"
                role="menuitem"
                className="bookmark-folder-selector__action"
                disabled={exporting}
                onClick={() => {
                  close();
                  setExportDialogOpen(true);
                }}
              >
                Export (.sql)
              </button>
              <button
                type="button"
                role="menuitem"
                className="bookmark-folder-selector__action"
                disabled={importing}
                onClick={() => {
                  importInputRef.current?.click();
                  close();
                }}
              >
                {importing
                  ? importProgress
                    ? `Importing… ${importProgress}`
                    : 'Importing…'
                  : 'Import (.sql)'}
              </button>
              {sourceData && sourceData.length > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  className={`bookmark-folder-selector__action bookmark-manage-toggle${manageMode ? ' bookmark-manage-toggle--active' : ''}`}
                  aria-pressed={manageMode}
                  onClick={() => {
                    setManageMode((mode) => !mode);
                    close();
                  }}
                >
                  {manageMode ? 'Done' : 'Edit'}
                </button>
              )}
            </>
          )}
        />
        {/* Keep the toolbar mounted when filters narrow the view to nothing:
            hiding it would remove the only way to unselect a genre. */}
        {layoutReady && bookmarks.isSuccess && (bookmarks.data.length > 0 || filtersActive) && (
          <>
            <SourceFilter value={sourceFilter} onChange={setSourceFilter} allowAll />
            <div className="search-filters search-filters--toggles" role="group" aria-label="Bookmarks view options">
              <button
                type="button"
                className={`search-filters__disclosure${filtersCollapsed ? '' : ' search-filters__disclosure--open'}`}
                aria-expanded={!filtersCollapsed}
                aria-label={filtersCollapsed ? 'Show filters' : 'Hide filters'}
                title={filtersCollapsed ? 'Show filters' : 'Hide filters'}
                onClick={() => handleFiltersToggle(!filtersCollapsed)}
              >
                <span>Filters</span>
                {activeFilterCount > 0 && (
                  <span className="search-filters__disclosure-count">{activeFilterCount}</span>
                )}
                <IconChevronDown size={14} />
              </button>
              <button
                type="button"
                className={`search-filters__disclosure search-filters__disclosure--search${searchOpen || query.trim() !== '' ? ' search-filters__disclosure--open' : ''}`}
                aria-expanded={searchOpen}
                aria-label={searchOpen ? 'Hide search' : 'Show search'}
                title={searchOpen ? 'Hide search' : 'Show search'}
                onClick={handleSearchToggle}
              >
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
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <span>Search</span>
              </button>
              <CardLayoutToggle
                value={cardLayout}
                onChange={handleLayoutChange}
                labelId="bookmarks-layout-label"
              />
            </div>
            {!filtersCollapsed && (
            <div className="search-filters search-filters--fields" role="group" aria-label="Refine bookmarks">
              <select
                className={
                  'search-filters__select' + (statusFilter ? ' search-filters__select--active' : '')
                }
                aria-label="Filter by status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as PanelStatus | '')}
              >
                <option value="">Any status</option>
                <option value="ongoing">Ongoing</option>
                <option value="completed">Completed</option>
                <option value="hiatus">Hiatus</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <select
                className={
                  'search-filters__select' + (chapterBookmarkFilter !== 'all' ? ' search-filters__select--active' : '')
                }
                aria-label="Filter by bookmarked chapters"
                value={chapterBookmarkFilter}
                onChange={(e) => setChapterBookmarkFilter(e.target.value as 'all' | 'with' | 'without')}
              >
                <option value="all">Any chapters</option>
                <option value="with">With bookmarked chapters</option>
                <option value="without">Without bookmarked chapters</option>
              </select>
              <GenreMultiSelect
                label="Filter by genre"
                options={availableGenres}
                selected={genreFilter}
                onChange={setGenreFilter}
                emptyLabel="Any genre"
                pluralLabel="Genres"
              />
              <GenreMultiSelect
                label="Exclude genre"
                options={availableGenres}
                selected={excludedGenre}
                onChange={setExcludedGenre}
                emptyLabel="Exclude genre"
                pluralLabel="Excluded"
              />
              {/* AND vs OR only differs with two or more includes. */}
              {genreFilter.length > 1 && (
                <span className="search-filters__switch">
                  <span className="search-filters__label" id="bookmarks-match-all-genres-label">
                    Match all genres
                  </span>
                  <Switch
                    checked={matchAllGenres}
                    onChange={handleMatchAllGenresToggle}
                    labelledBy="bookmarks-match-all-genres-label"
                    size="sm"
                  />
                </span>
              )}
              {!filtersCollapsed && (allTags.data ?? []).length > 0 && (
                <select
                  className="search-filters__select"
                  aria-label="Filter by tag"
                  value={tagFilter}
                  onChange={(e) => setTagFilter(e.target.value)}
                >
                  <option value="">Any tag</option>
                  {(allTags.data ?? []).map((tag) => (
                    <option key={tag.id} value={tag.name}>
                      {tag.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            )}
            {(searchOpen || query.trim() !== '') && (
              <FilterSearchBar
                value={query}
                onChange={setQuery}
                placeholder="Filter by title, author or artist…"
                label="Filter bookmarks by title, author or artist"
              />
            )}
          </>
        )}
        <input
          ref={importInputRef}
          type="file"
          accept=".sql,.json,application/sql,application/json,text/plain"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleImportFile(file);
          }}
        />
      </div>

      {sortByLatestUpdate && sourceFilter && latestFeedFetching && (
        <p className="bookmarks-order-hint bookmarks-order-hint--busy" role="status" aria-live="polite">
          <span className="bookmarks-order-hint__spinner" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" opacity="0.25" />
              <path d="M21 12a9 9 0 0 0-9-9" />
            </svg>
          </span>
          <span>Fetching {sourceLabel(sourceFilter)}&rsquo;s latest updates…</span>
        </p>
      )}
      {sortByLatestUpdate && sourceFilter && latestFeedReady && !latestFeedFetching && (
        <p className="bookmarks-order-hint" role="note">
          Ordered by {sourceLabel(sourceFilter)}&rsquo;s latest updates — titles outside its
          recent window keep the default order.
        </p>
      )}

      {sourceIsError && (
        <ErrorState
          title="Could not load bookmarks"
          message={
            (viewingAll ? bookmarks.error : folderContents.error)?.message ??
            'Unknown error'
          }
          onRetry={() => (viewingAll ? bookmarks.refetch() : folderContents.refetch())}
        />
      )}

      {!sourceIsLoading && !sourceIsError && sourceData.length === 0 && (
        <EmptyState
          title="No bookmarks yet."
          message="Search for a panel and bookmark it to see it here."
          action={
            <Link to="/" className="btn btn--primary">
              Find something to read
            </Link>
          }
        />
      )}

      {!sourceIsLoading && sourceData.length > 0 && sorted.length === 0 && (
        <EmptyState
          title={
            query.trim()
              ? `No bookmarks match “${query.trim()}”`
              : filtersActive
                ? 'No matches'
                : 'No bookmarks from this source'
          }
          message={
            query.trim()
              ? 'Try a different title, author or artist, or clear the filter.'
              : filtersActive
                ? 'No bookmarks match the selected filters.'
                : 'Try another source filter, or bookmark something from it.'
          }
          action={
            filtersActive ? (
              <button type="button" className="btn btn--primary" onClick={clearAllFilters}>
                Clear filters
              </button>
            ) : undefined
          }
        />
      )}

      {/* The grid paints without waiting for the persisted layout choice
          (which resolves a beat later) — only the toolbar toggles wait for
          `layoutReady`, so first paint isn't blocked on settings I/O. */}
      {sourceData.length > 0 && sorted.length > 0 && rendered.length > 0 && (
        <>
          {cardLayout === 'list' ? (
            <PanelList className="panel-list--bookmarks">
              {rendered.map((bookmark) => {
                const progressLabel = bookmark.progress
                  ? (bookmark.progress.chapterTitle ?? 'Chapter')
                  : 'Not started yet';
                const folderNames = (bookmark.folderIds ?? [])
                  .map((id) => folderNameById.get(id))
                  .filter((name): name is string => Boolean(name));
                const isDragging = draggingId === bookmark.id;
                return (
                  <PanelListRow
                    key={bookmark.id}
                    cover={{
                      source: bookmark.source,
                      coverUrl: bookmark.coverUrl,
                      panelId: bookmark.panelId,
                      title: bookmark.title,
                    }}
                    title={bookmark.title}
                    to={`/panel/${encodeURIComponent(bookmark.panelId)}?from=bookmarks`}
                    className={isDragging ? 'bookmark-card--dragging' : undefined}
                    draggable
                    onDragStart={(e) => handleDragStart(e, bookmark)}
                    onDragEnd={handleDragEnd}
                    badges={
                      settings.hideCoverBadges ? null : (
                        <>
                          {bookmark.status && bookmark.status !== 'unknown' && (
                            <span
                              className={`panel-card__status panel-card__status--${bookmark.status}`}
                            >
                              {bookmark.status}
                            </span>
                          )}
                          <span
                            className="panel-card__source"
                            title={`Source: ${sourceLabel(bookmark.source)}`}
                          >
                            {sourceLabel(bookmark.source)}
                          </span>
                          {folderNames.length > 0 && (
                            <ul
                              className="bookmark-card__folders"
                              aria-label={`Folders: ${folderNames.join(', ')}`}
                            >
                              {folderNames.slice(0, 3).map((name) => (
                                <li key={name} className="bookmark-card__folder-pill" title={name}>
                                  <IconFolder size={11} />
                                  <span>{name}</span>
                                </li>
                              ))}
                              {folderNames.length > 3 && (
                                <li className="bookmark-card__folder-pill bookmark-card__folder-pill--more">
                                  +{folderNames.length - 3}
                                </li>
                              )}
                            </ul>
                          )}
                        </>
                      )
                    }
                    meta={
                      <>
                        <p className="panel-card__meta panel-card__meta--progress">{progressLabel}</p>
                        {bookmark.latestChapter && (
                          <p className="panel-card__meta panel-card__meta--latest">
                            Latest · {bookmark.latestChapter}
                          </p>
                        )}
                      </>
                    }
                    actions={
                      <>
                        {bookmark.progress && (
                          <Link
                            to={`/read/${encodeURIComponent(bookmark.progress.chapterId)}`}
                            className="btn btn--primary btn--sm bookmark-card__continue"
                            aria-label={`Continue reading ${bookmark.title}`}
                            title="Continue reading"
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="currentColor"
                              aria-hidden="true"
                            >
                              <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86Z" />
                            </svg>
                            <span className="bookmark-card__action-label">Continue</span>
                          </Link>
                        )}
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm bookmark-card__folder"
                          onClick={() => setPickerBookmark(bookmark)}
                          aria-label={`Move ${bookmark.title} to a folder`}
                          title="Move to folder"
                        >
                          <IconFolder size={14} />
                          <span className="bookmark-card__action-label">Folder</span>
                        </button>
                        <Link
                          to={`/panel/${encodeURIComponent(bookmark.panelId)}?from=bookmarks`}
                          className="btn btn--ghost btn--sm bookmark-card__open"
                          aria-label={`Open ${bookmark.title}`}
                          title="Open panel"
                        >
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
                            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                          </svg>
                          <span className="bookmark-card__action-label">Open</span>
                        </Link>
                        <button
                          type="button"
                          className="btn btn--danger-ghost btn--sm bookmark-card__remove"
                          onClick={() => setPendingRemoval(bookmark)}
                          aria-label={`Remove ${bookmark.title} from bookmarks`}
                          title="Remove from bookmarks"
                        >
                          <svg
                            className="bookmark-card__remove-icon"
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
                            <path d="M3 6h18" />
                            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                            <path d="M10 11v6" />
                            <path d="M14 11v6" />
                          </svg>
                          <span className="bookmark-card__action-label">Remove</span>
                        </button>
                      </>
                    }
                    onPreviewShow={showCoverPreview}
                    onPreviewHide={hideCoverPreview}
                  />
                );
              })}
            </PanelList>
          ) : (
          <ul
            className={`bookmark-grid${manageMode ? ' bookmark-grid--manage' : ''}`}
            role="list"
          >
            {rendered.map((bookmark, index) => {
              const progressLabel = bookmark.progress
                ? (bookmark.progress.chapterTitle ?? 'Chapter')
                : 'Not started yet';
              const folderNames = (bookmark.folderIds ?? [])
                .map((id) => folderNameById.get(id))
                .filter((name): name is string => Boolean(name));
              const isDragging = draggingId === bookmark.id;
              return (
              <li
                key={bookmark.id}
                className={`bookmark-card${isDragging ? ' bookmark-card--dragging' : ''}`}
                draggable
                onDragStart={(e) => handleDragStart(e, bookmark)}
                onDragEnd={handleDragEnd}
              >
              <div className="bookmark-card__media">
                <Link
                  to={`/panel/${encodeURIComponent(bookmark.panelId)}?from=bookmarks`}
                  className="bookmark-card__cover"
                  aria-label={`Open ${bookmark.title}`}
                >
                  <CoverImage
                    source={bookmark.source}
                    coverUrl={bookmark.coverUrl}
                    panelId={bookmark.panelId}
                    title={bookmark.title}
                    eager={index < 6}
                    fallbackClassName="bookmark-card__fallback"
                    cacheNonce={coverNonces.get(bookmark.panelId)}
                  />

                  <span className="bookmark-card__shade" aria-hidden="true" />

                  {/* Cover badges — nested in the cover (like PanelCard) so
                      they anchor to the image even when mobile flattens the
                      media wrapper with display:contents. Hidden when the
                      user toggles "Hide cover badges" on the Cache Settings
                      page. */}
                  {settings.hideCoverBadges ? null : (
                    <>
                      {bookmark.status && bookmark.status !== 'unknown' && (
                        <span className={`panel-card__status panel-card__status--${bookmark.status}`}>
                          {bookmark.status}
                        </span>
                      )}
                      <span
                        className="panel-card__source"
                        title={`Source: ${sourceLabel(bookmark.source)}`}
                      >
                        {sourceLabel(bookmark.source)}
                      </span>
                      {folderNames.length > 0 && (
                        <ul
                          className="bookmark-card__folders"
                          aria-label={`Folders: ${folderNames.join(', ')}`}
                        >
                          {folderNames.slice(0, 3).map((name) => (
                            <li key={name} className="bookmark-card__folder-pill" title={name}>
                              <IconFolder size={11} />
                              <span>{name}</span>
                            </li>
                          ))}
                          {folderNames.length > 3 && (
                            <li className="bookmark-card__folder-pill bookmark-card__folder-pill--more">
                              +{folderNames.length - 3}
                            </li>
                          )}
                        </ul>
                      )}
                    </>
                  )}
                </Link>

                {/* Cover-zoom: opens the cover in the interactive lightbox —
                    LEFT side, opposite the trash button. Portal-rendered, so
                    it escapes the card's overflow. */}
                <CoverZoomButton
                  source={bookmark.source}
                  coverUrl={bookmark.coverUrl}
                  panelId={bookmark.panelId}
                  title={bookmark.title}
                  belowStatus={!settings.hideCoverBadges}
                  cacheNonce={coverNonces.get(bookmark.panelId)}
                />

                {/* Cover-clear: delete the cached cover (same action as
                    the details-page hero trash). Sits outside the cover
                    link so it never navigates. */}
                <button
                  type="button"
                  className={`panel-card__cover-clear bookmark-card__cover-clear${settings.hideCoverBadges ? '' : ' panel-card__cover-clear--below-source'}`}
                  onClick={() => handleClearCover(bookmark)}
                  disabled={clearCoverMutation.isPending || !bookmark.coverUrl}
                  aria-label="Delete cached cover image and refetch"
                  title="Delete cached cover image and refetch"
                >
                  <IconTrash size={15} />
                </button>

                <div className="bookmark-card__actions">
                  {bookmark.progress && (
                    <Link
                      to={`/read/${encodeURIComponent(bookmark.progress.chapterId)}`}
                      className="btn btn--primary btn--sm bookmark-card__continue"
                      aria-label={`Continue reading ${bookmark.title}`}
                      title="Continue reading"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86Z" />
                      </svg>
                      <span className="bookmark-card__action-label">Continue</span>
                    </Link>
                  )}
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm bookmark-card__folder"
                    onClick={() => setPickerBookmark(bookmark)}
                    aria-label={`Move ${bookmark.title} to a folder`}
                    title="Move to folder"
                  >
                    <IconFolder size={14} />
                    <span className="bookmark-card__action-label">Folder</span>
                  </button>
                  <Link
                    to={`/panel/${encodeURIComponent(bookmark.panelId)}?from=bookmarks`}
                    className="btn btn--ghost btn--sm bookmark-card__open"
                    aria-label={`Open ${bookmark.title}`}
                    title="Open panel"
                  >
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
                      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                    </svg>
                    <span className="bookmark-card__action-label">Open</span>
                  </Link>
                  <button
                    type="button"
                    className="btn btn--danger-ghost btn--sm bookmark-card__remove"
                    onClick={() => setPendingRemoval(bookmark)}
                    aria-label={`Remove ${bookmark.title} from bookmarks`}
                    title="Remove from bookmarks"
                  >
                    <svg
                      className="bookmark-card__remove-icon"
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
                      <path d="M3 6h18" />
                      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                      <path d="M10 11v6" />
                      <path d="M14 11v6" />
                    </svg>
                    <span className="bookmark-card__action-label">Remove</span>
                  </button>
                </div>
              </div>

              {/* Stretched link: covers the whole card so a click anywhere
                  opens the details page — same behaviour as the latest page's
                  PanelCard. Interactive elements (action buttons, remove) sit
                  above it via z-index and remain individually clickable. */}
              <Link
                to={`/panel/${encodeURIComponent(bookmark.panelId)}?from=bookmarks`}
                className="bookmark-card__stretched"
                aria-label={`Open ${bookmark.title}`}
                draggable={false}
              />

              <div className="bookmark-card__body">
                <h3 className="panel-card__title bookmark-card__title">
                  {bookmark.title}
                </h3>
                <p className="panel-card__meta panel-card__meta--progress">{progressLabel}</p>
                {bookmark.latestChapter && (
                  <p className="panel-card__meta panel-card__meta--latest">
                    Latest · {bookmark.latestChapter}
                  </p>
                )}
              </div>
            </li>
              );
            })}
        </ul>
          )}
          {/* Scroll window: pulls the next PAGE_SIZE cards into view (same
              marker pattern as the latest page's infinite scroll). */}
          <div ref={sentinelRef} aria-hidden="true" />
          {!hasMoreToShow && sorted.length > PAGE_SIZE && (
            <p className="pagination__page" aria-live="polite">
              You&apos;re all caught up
            </p>
          )}
        </>
      )}

      <ConfirmDialog
        open={pendingRemoval !== null}
        title="Remove bookmark?"
        message={`"${pendingRemoval?.title ?? ''}" will be removed from your bookmarks. Your reading progress is kept.`}
        confirmLabel="Remove"
        danger
        onConfirm={handleRemove}
        onCancel={() => setPendingRemoval(null)}
      />

      <BackupExportDialog
        open={exportDialogOpen}
        exporting={exporting}
        onPick={(scope) => {
          setExportDialogOpen(false);
          void handleExport(scope);
        }}
        onCancel={() => setExportDialogOpen(false)}
      />

      <FolderPickerDialog
        open={pickerBookmark !== null}
        bookmark={
          pickerBookmark
            ? { id: pickerBookmark.id, folderIds: pickerBookmark.folderIds ?? [] }
            : null
        }
        onClose={() => setPickerBookmark(null)}
      />

      <DragFolderOverlay
        open={dragOverlayOpen && droppableFolders.length > 0}
        bookmarkTitle={
          draggedBookmark.current?.title ||
          (draggingId && sourceData.find((b) => b.id === draggingId)?.title) ||
          ''
        }
        onDrop={handleDrop}
        onCancel={handleDragCancel}
      />
    </div>
  );
}
