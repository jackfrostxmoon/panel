import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { CardLayout, PanelStatus, SourceSearchResult } from '@panel/shared';
import { useDelayedLoading } from '../hooks/useDelayedLoading';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useDisplaySettings } from '../hooks/useDisplaySettings';
import {
  useBookmarks,
  useBookmarkFolders,
  useLatest,
  useGenreList,
  useLatestSettings,
  useSaveLatestSettings,
} from '../api/hooks';
import { api } from '../api/client';
import { PanelCard, PanelGrid } from '../components/PanelCard';
import { IconChevronDown } from '../components/icons';
import {
  CardLayoutToggle,
  PanelList,
  PanelListRow,
} from '../components/PanelList';
import { hideCoverPreview, showCoverPreview } from '../components/coverPreview';
import { LatestCardActions } from '../components/LatestCardActions';
import { GenreMultiSelect } from '../components/GenreMultiSelect';
import { SearchBar } from '../components/SearchBar';
import { SourceFilter } from '../components/SourceFilter';
import { Switch } from '../components/Switch';
import { EmptyState, ErrorState } from '../components/StateView';
import { DEFAULT_SOURCE, formatDate, sourceLabel } from '../utils/format';

/** Latest source updates with page navigation below the grid. */
export function LatestPage() {
  useDocumentTitle('Latest');
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const pageParam = Number.parseInt(params.get('page') ?? '1', 10);
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  // Always query exactly one source — no fan-out "all sources" mode.
  const source = params.get('source') ?? DEFAULT_SOURCE;

  /** Client-side status + genre filters (mirror the search page). Genre
      constraints are ALSO sent to the API: combo-capable sources filter
      their whole catalog server-side (include = OR), the rest fall back
      to narrowing the fetched page here (plus the exclude filter, always). */
  const [statusFilter, setStatusFilter] = useState<PanelStatus | ''>('');
  const [genreFilter, setGenreFilter] = useState<string[]>([]);
  /** Genres to hide: any result carrying ANY excluded genre is dropped,
      even if it also matches the include filter (exclude wins). */
  const [excludedGenre, setExcludedGenre] = useState<string[]>([]);

  /**
   * Infinite-scroll preference, persisted server-side to
   * `data/display/latest.json`. OFF by default (classic pagination).
   * While a save is in flight the pending value wins so the switch
   * flips instantly instead of waiting for the round-trip.
   */
  const latestSettingsQuery = useLatestSettings();
  const saveLatestSettings = useSaveLatestSettings();
  const infiniteScroll =
    saveLatestSettings.isPending && saveLatestSettings.variables
      ? saveLatestSettings.variables.infiniteScroll
      : (latestSettingsQuery.data?.infiniteScroll ?? false);
  /**
   * Cards/list layout, persisted server-side to `data/display/latest.json`
   * alongside the infinite-scroll toggle. Same pending-wins pattern so the
   * toggle flips instantly instead of waiting for the round-trip.
   */
  const cardLayout: CardLayout =
    saveLatestSettings.isPending && saveLatestSettings.variables
      ? saveLatestSettings.variables.cardLayout
      : (latestSettingsQuery.data?.cardLayout ?? 'cards');
  /**
   * Collapsed refinement filters, persisted server-side to
   * `data/display/latest.json`. Collapsed by default so the toolbar stays
   * compact; same pending-wins pattern as the other toggles.
   */
  const filtersCollapsed: boolean =
    saveLatestSettings.isPending && saveLatestSettings.variables
      ? saveLatestSettings.variables.filtersCollapsed
      : (latestSettingsQuery.data?.filtersCollapsed ?? true);
  /**
   * Don't paint either layout until the persisted choice resolves — a hard
   * refresh would otherwise flash the card grid (the `?? 'cards'` fallback)
   * for a beat even when list mode is stored. Errors fall back to cards.
   */
  const layoutReady =
    (saveLatestSettings.isPending && saveLatestSettings.variables != null) ||
    latestSettingsQuery.isSuccess ||
    latestSettingsQuery.isError;

  // In infinite mode the base query is pinned to page 1 and extra pages
  // are appended below (fetched imperatively so the hook count stays
  // static). The `?page=` param then only records how deep the user has
  // scrolled — a refresh with `?page=N` reloads pages 1..N.
  const latest = useLatest(
    infiniteScroll ? 1 : page,
    source,
    genreFilter.length > 0 ? genreFilter : undefined,
    excludedGenre.length > 0 ? excludedGenre : undefined,
    {
      placeholderData: (previous) => previous,
    },
  );

  /**
   * Extra pages appended by infinite scroll. `extraPages[i]` holds the
   * payload for page `i + 2` (page 1 comes from the `latest` query above).
   * Cleared whenever the result set identity changes or infinite mode
   * turns off.
   */
  const [extraPages, setExtraPages] = useState<SourceSearchResult[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  /** Guards against a stale in-flight fetch appending after a reset. */
  const generationRef = useRef(0);

  const resetExtraPages = () => {
    generationRef.current += 1;
    setExtraPages([]);
    setLoadingMore(false);
    setLoadMoreError(null);
  };

  /**
   * Live mirrors for the infinite-scroll loader below.
   * `loadNextInfinitePage` runs from an IntersectionObserver callback that
   * can outlive its render: `placeholderData` keeps `latest.data`
   * referentially stable across a source switch, so the sentinel effect —
   * and its stale `source`/`params` closure — survives the tap. Reading
   * through refs (plus the post-fetch source check) means a stale callback
   * can neither append another source's page nor navigate the URL back to
   * it (the "source snaps back" bug).
   */
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const genreFilterRef = useRef(genreFilter);
  genreFilterRef.current = genreFilter;
  const excludedGenreRef = useRef(excludedGenre);
  excludedGenreRef.current = excludedGenre;
  const extraPagesRef = useRef(extraPages);
  extraPagesRef.current = extraPages;

  // Fresh result identity (source / server-side filters / mode switch) —
  // drop appended pages so page 2 of the old query never leaks in.
  // NOTE: this effect must NEVER navigate. A second navigation issued
  // here aborts an in-flight push from the event that changed the
  // identity (e.g. changeSource), freezing the grid on the old source.
  // URL writes live exclusively in the event handlers below, one
  // navigation per gesture.
  useEffect(() => {
    resetExtraPages();
  }, [source, genreFilter, excludedGenre, infiniteScroll]);
  const showLoading = useDelayedLoading(latest.isLoading);
  const { settings } = useDisplaySettings();

  // Highlight cards already on the user's shelf + surface their reading
  // progress so each card can render a "Continue" button and a
  // chapter-and-page footer instead of just the latest chapter title.
  // A single `useBookmarks()` query is cheaper + fresher than per-card
  // `useBookmarkByPanel` calls: add/remove elsewhere already invalidates
  // and rewrites this cache, so both signals stay in sync.
  const bookmarks = useBookmarks();
  const foldersQuery = useBookmarkFolders();
  const progressByPanelId = useMemo(() => {
    const map = new Map<string, NonNullable<typeof bookmarks.data>[number]['progress']>();
    for (const bookmark of bookmarks.data ?? []) {
      if (bookmark.progress) map.set(bookmark.panelId, bookmark.progress);
    }
    return map;
    // bookmarks is the stable TanStack Query result object; the actual
    // change driver is bookmarks.data, which the linter can't see.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [bookmarks.data]);
  const bookmarkedIds = useMemo(
    () => new Set((bookmarks.data ?? []).map((b) => b.panelId)),
    [bookmarks.data],
  );
  /** Resolve bookmark → folder names for the latest card folder pills.
   *  Mirrors the bookmarks grid card body so the two views feel related. */
  const folderNamesByPanelId = useMemo(() => {
    const folders = foldersQuery.data?.folders ?? [];
    const map = new Map<string, string[]>();
    for (const bookmark of bookmarks.data ?? []) {
      const names = (bookmark.folderIds ?? [])
        .map((id) => folders.find((f) => f.id === id)?.name)
        .filter((name): name is string => Boolean(name));
      if (names.length > 0) map.set(bookmark.panelId, names);
    }
    return map;
  }, [bookmarks.data, foldersQuery.data]);

  /** Client-side narrowing of the fetched results (see the filter state
      declared above, next to the query). */

  /** All loaded rows in infinite mode (base page + appended pages). */
  const allResults = useMemo(() => {
    const base = latest.data?.results ?? [];
    if (!infiniteScroll || extraPages.length === 0) return base;
    return [...base, ...extraPages.flatMap((p) => p.results)];
  }, [latest.data, extraPages, infiniteScroll]);

  /** Whether another page exists after everything loaded so far. */
  const infiniteHasMore =
    extraPages.length > 0
      ? (extraPages[extraPages.length - 1]?.hasMore ?? false)
      : (latest.data?.hasMore ?? false);

  /** Genres present in the current result set, for the dropdown options. */
  const availableGenres = useMemo(() => {
    const set = new Set<string>();
    for (const panel of allResults) {
      for (const g of panel.genres) set.add(g);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [allResults]);

  /**
   * Dropdown options: the source's full genre catalog when it publishes
   * one, otherwise the genres seen on this page. The catalog also keeps
   * junk labels (e.g. status text leaking into a card's genres) out of
   * the dropdown.
   */
  const genreCatalog = useGenreList(source);
  const genreOptions =
    genreCatalog.data && genreCatalog.data.genres.length > 0
      ? genreCatalog.data.genres
      : availableGenres;

  /** Case-insensitive set of the selected include genres (OR semantics). */
  const includeSet = useMemo(
    () => new Set(genreFilter.map((g) => g.toLowerCase())),
    [genreFilter],
  );
  /** Case-insensitive set of the excluded genres (ANY match drops the card). */
  const excludeSet = useMemo(
    () => new Set(excludedGenre.map((g) => g.toLowerCase())),
    [excludedGenre],
  );

  const filteredResults = useMemo(() => {
    return allResults.filter(
      (m) =>
        (!statusFilter || m.status === statusFilter) &&
        // Genre-less items are kept: the server already filtered by genre,
        // so an empty list means "unknown" (e.g. a skipped enrichment),
        // not "doesn't match". Dropping them would hide genuine matches.
        (includeSet.size === 0 ||
          m.genres.length === 0 ||
          m.genres.some((g) => includeSet.has(g.toLowerCase()))) &&
        (excludeSet.size === 0 ||
          !m.genres.some((g) => excludeSet.has(g.toLowerCase()))),
    );
  }, [allResults, statusFilter, includeSet, excludeSet]);

  const filtersActive = statusFilter !== '' || genreFilter.length > 0 || excludedGenre.length > 0;
  /** Applied-refinement count for the filters disclosure badge. */
  const activeFilterCount =
    (statusFilter !== '' ? 1 : 0) + genreFilter.length + excludedGenre.length;

  // Keyboard paging: ←/↑/A/W = previous page, →/↓/D/S = next page
  // (mirrors the reader's paged-mode navigation keys). Hold Shift with
  // W/S (or ↑/↓) to smooth-scroll instead — see the hold-to-scroll effect
  // below. Paging only runs while results are on screen, skips typing
  // targets and modifier combos, and stays disabled while infinite scroll
  // owns the page flow (Shift-scroll still works there).
  const hasResults = allResults.length > 0;
  const hasMore = latest.data?.hasMore ?? false;
  useEffect(() => {
    if (!hasResults || infiniteScroll) return;

    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const isTypingTarget =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (isTypingTarget) return;

      const key = event.key;
      const isPrevPage =
        key === 'ArrowLeft' || key === 'ArrowUp' || key === 'a' || key === 'A' || key === 'w' || key === 'W';
      const isNextPage =
        key === 'ArrowRight' ||
        key === 'ArrowDown' ||
        key === 'd' ||
        key === 'D' ||
        key === 's' ||
        key === 'S';
      if (isPrevPage && page > 1) {
        event.preventDefault();
        navigate(latestPath(page - 1, source));
      } else if (isNextPage && hasMore) {
        event.preventDefault();
        navigate(latestPath(page + 1, source));
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [page, hasMore, source, hasResults, infiniteScroll, navigate]);

  // Smooth hold-to-scroll: Shift+W / Shift+↑ glides up, Shift+S / Shift+↓
  // glides down (mirrors the reader's Shift+W/S smooth scroll — hold the
  // keys to glide, release to stop). Works in both paged and infinite
  // modes; plain (Shift-less) W/S keeps the paging behavior above.
  const smoothDirRef = useRef<'up' | 'down' | null>(null);
  const smoothRafRef = useRef(0);
  const smoothLastRef = useRef(0);
  useEffect(() => {
    const SPEED_PX_PER_SEC = 3000;

    function stopSmoothScroll() {
      smoothDirRef.current = null;
      cancelAnimationFrame(smoothRafRef.current);
    }

    function tick(now: number) {
      const dir = smoothDirRef.current;
      if (dir === null) return;
      const dt = Math.max((now - smoothLastRef.current) / 1000, 0);
      smoothLastRef.current = now;
      if (dt > 0) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        const next = window.scrollY + (dir === 'up' ? -SPEED_PX_PER_SEC * dt : SPEED_PX_PER_SEC * dt);
        if (next <= 0) {
          window.scrollTo(0, 0);
          stopSmoothScroll();
          return;
        }
        if (next >= max) {
          window.scrollTo(0, Math.max(max, 0));
          stopSmoothScroll();
          return;
        }
        window.scrollBy(0, dir === 'up' ? -SPEED_PX_PER_SEC * dt : SPEED_PX_PER_SEC * dt);
      }
      smoothRafRef.current = requestAnimationFrame(tick);
    }

    function startSmoothScroll(dir: 'up' | 'down') {
      if (smoothDirRef.current === dir) return;
      smoothDirRef.current = dir;
      cancelAnimationFrame(smoothRafRef.current);
      smoothLastRef.current = performance.now();
      smoothRafRef.current = requestAnimationFrame(tick);
    }

    function isTypingTarget(target: HTMLElement | null) {
      return (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      );
    }

    function onKeyDown(event: KeyboardEvent) {
      if (!event.shiftKey || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (isTypingTarget(event.target as HTMLElement | null)) return;
      const key = event.key;
      if (key === 'ArrowUp' || key === 'w' || key === 'W') {
        event.preventDefault();
        startSmoothScroll('up');
      } else if (key === 'ArrowDown' || key === 's' || key === 'S') {
        event.preventDefault();
        startSmoothScroll('down');
      }
    }

    function onKeyUp(event: KeyboardEvent) {
      const key = event.key;
      // Releasing a scroll key — or Shift itself — halts the glide.
      if (
        key === 'Shift' ||
        key === 'ArrowUp' ||
        key === 'ArrowDown' ||
        key === 'w' ||
        key === 'W' ||
        key === 's' ||
        key === 'S'
      ) {
        stopSmoothScroll();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', stopSmoothScroll);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', stopSmoothScroll);
      cancelAnimationFrame(smoothRafRef.current);
      smoothDirRef.current = null;
    };
  }, []);

  /**
   * Append one page in infinite mode and record the new depth in the URL
   * (`?page=N`, replace — no history spam). Failures surface a retry
   * affordance instead of silently stalling the sentinel.
   */
  async function loadNextInfinitePage() {
    if (!infiniteScroll || loadingMore || latest.isLoading) return;
    if (!infiniteHasMore) return;
    // Snapshot live values (see refs above) — never the render closure's.
    const liveSource = sourceRef.current;
    const liveGenres = genreFilterRef.current;
    const liveExcludes = excludedGenreRef.current;
    const next = extraPagesRef.current.length + 2;
    const generation = generationRef.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const payload = await api.latest(
        next,
        liveSource,
        liveGenres.length > 0 ? liveGenres : undefined,
        liveExcludes.length > 0 ? liveExcludes : undefined,
      );
      if (generationRef.current !== generation) return;
      // Source moved on mid-flight (e.g. a pill tap while fetching) — drop
      // the stale page instead of mixing sources or rewriting the URL.
      if (sourceRef.current !== liveSource) return;
      setExtraPages((prev) => [...prev, payload]);
      const nextParams = new URLSearchParams(paramsRef.current);
      nextParams.set('page', String(next));
      setParams(nextParams, { replace: true });
    } catch (error) {
      if (generationRef.current !== generation) return;
      setLoadMoreError(error instanceof Error ? error.message : 'Could not load the next page.');
    } finally {
      if (generationRef.current === generation) setLoadingMore(false);
    }
  }

  // Scroll sentinel: when the marker scrolls into view, pull the next
  // page. Idle until the base page resolves so the observer never fires
  // against an empty grid.
  useEffect(() => {
    if (!infiniteScroll || !latest.isSuccess) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadNextInfinitePage();
        }
      },
      { rootMargin: '600px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // `loadNextInfinitePage` is intentionally invoked, not depended on —
    // it closes over the latest render's state via the effect re-run.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [infiniteScroll, latest.isSuccess, latest.data, extraPages.length, loadingMore]);

  // Deep-link restore: a refresh with `?page=N` while infinite scroll is
  // on backfills pages 2..N so the scroll position survives a reload.
  useEffect(() => {
    if (!infiniteScroll || !latest.isSuccess) return;
    if (page <= 1 || loadingMore) return;
    if (extraPages.length + 1 >= page) return;
    if (!infiniteHasMore) return;
    void loadNextInfinitePage();
    // oxlint-disable-next-line react/exhaustive-deps
  }, [infiniteScroll, latest.isSuccess, page, extraPages.length]);

  function handleInfiniteToggle(next: boolean) {
    if (next) {
      // Start from the current paged position when opting in mid-list.
      const depth = page > 1 ? page : 1;
      resetExtraPages();
      if (depth > 1) {
        const nextParams = new URLSearchParams(params);
        nextParams.set('page', String(depth));
        setParams(nextParams, { replace: true });
      }
    } else {
      // Keep the deepest loaded page as the single paged view so the
      // user's place survives turning infinite scroll off.
      const deepest = extraPages.length + 1;
      resetExtraPages();
      const nextParams = new URLSearchParams(params);
      if (deepest > 1) nextParams.set('page', String(deepest));
      else nextParams.delete('page');
      setParams(nextParams, { replace: true });
    }
    saveLatestSettings.mutate({ infiniteScroll: next, cardLayout, filtersCollapsed });
  }

  function handleLayoutChange(next: CardLayout) {
    if (next === cardLayout) return;
    saveLatestSettings.mutate({ infiniteScroll, cardLayout: next, filtersCollapsed });
  }

  function handleFiltersToggle(next: boolean) {
    if (next === filtersCollapsed) return;
    saveLatestSettings.mutate({ infiniteScroll, cardLayout, filtersCollapsed: next });
  }

  function changeSource(next: string) {
    if (!next) return;
    const nextParams = new URLSearchParams(params);
    nextParams.set('source', next);
    nextParams.delete('page');
    setParams(nextParams);
    // Genre vocabularies are per-source — labels picked for one source
    // may not exist in another, so reset both genre filters on switch.
    setGenreFilter([]);
    setExcludedGenre([]);
  }

  /** Rewind the scroll-depth param after a filter refinement (replace —
      refinements aren't places, so they shouldn't add history entries). */
  function rewindPageParam() {
    if (!params.has('page')) return;
    const nextParams = new URLSearchParams(params);
    nextParams.delete('page');
    setParams(nextParams, { replace: true });
  }

  /** Genre refinements reset the result identity AND the URL depth. */
  function updateGenreFilter(next: string[]) {
    setGenreFilter(next);
    if (infiniteScroll) rewindPageParam();
  }

  /** Genre-exclusion refinements reset the result identity AND the URL depth. */
  function updateExcludedGenre(next: string[]) {
    setExcludedGenre(next);
    if (infiniteScroll) rewindPageParam();
  }

  return (
    <div className="page latest-page">
      <h1 className="sr-only">Latest updates</h1>

      {/* Toolbar DOM mirrors the search page (pills · search · filters);
          CSS `order` reorders desktop to pills · filters · search, and
          `margin-left: auto` on the filters pin them right of the pills. */}
      <div className="latest-toolbar">
        <SourceFilter value={source} onChange={changeSource} />
        {layoutReady && !filtersCollapsed && (
          <div className="latest-toolbar__search">
            {/* Regular size to match the pill-strip height; submits navigate
                to the search page. Hidden with the filters when collapsed. */}
            <SearchBar showPasteButton />
          </div>
        )}
        {layoutReady && latest.isSuccess && latest.data.results.length > 0 && (
          <>
          <div className="search-filters search-filters--toggles" role="group" aria-label="Latest view options">
            {/* Infinite-scroll toggle first — left of the status dropdown.
                Persisted to `data/display/latest.json` on the server. */}
            <span className="search-filters__switch">
              <span className="search-filters__label" id="latest-infinite-scroll-label">
                Infinite scroll
              </span>
              <Switch
                checked={infiniteScroll}
                onChange={handleInfiniteToggle}
                labelledBy="latest-infinite-scroll-label"
                size="sm"
              />
            </span>
            <CardLayoutToggle
              value={cardLayout}
              onChange={handleLayoutChange}
              labelId="latest-layout-label"
            />
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
          </div>
            {!filtersCollapsed && (
          <div className="search-filters search-filters--fields" role="group" aria-label="Refine latest updates">
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
            <GenreMultiSelect
              label="Filter by genre"
              options={genreOptions}
              selected={genreFilter}
              onChange={updateGenreFilter}
              emptyLabel="Any genre"
              pluralLabel="Genres"
            />
            <GenreMultiSelect
              label="Exclude genre"
              options={genreOptions}
              selected={excludedGenre}
              onChange={updateExcludedGenre}
              emptyLabel="Exclude genre"
              pluralLabel="Excluded"
            />
            {filtersActive && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setStatusFilter('');
                  setGenreFilter([]);
                  setExcludedGenre([]);
                }}
              >
                Clear filters
              </button>
            )}
          </div>
            )}
          </>
        )}
      </div>

      {showLoading && <div className="latest-loading" aria-live="polite" />}

      {latest.isError && (
        <ErrorState
          title="Could not load latest updates"
          message={latest.error.message}
          onRetry={() => latest.refetch()}
        />
      )}

      {latest.isSuccess && allResults.length === 0 && (
        <EmptyState title="No updates found" message="Try refreshing in a little while." />
      )}

      {latest.data && allResults.length > 0 && (
        <>
          {filteredResults.length > 0 ? (
            <>
              {!layoutReady ? (
                <div className="latest-loading" aria-live="polite" />
              ) : cardLayout === 'list' ? (
                <PanelList className="panel-list--latest">
                  {filteredResults.map((panel) => {
                    const progress = progressByPanelId.get(panel.id) ?? null;
                    const bookmarked = bookmarkedIds.has(panel.id);
                    return (
                      <PanelListRow
                        key={panel.id}
                        cover={{
                          source: panel.source,
                          coverUrl: panel.coverUrl,
                          panelId: panel.id,
                          title: panel.title,
                        }}
                        title={panel.title}
                        to={`/panel/${encodeURIComponent(panel.id)}?from=latest`}
                        bookmarked={bookmarked}
                        badges={
                          settings.hideCoverBadges ? null : (
                            <>
                              {panel.status !== 'unknown' && (
                                <span
                                  className={`panel-card__status panel-card__status--${panel.status}`}
                                >
                                  {panel.status}
                                </span>
                              )}
                              <span
                                className="panel-card__source"
                                title={`Source: ${sourceLabel(panel.source)}`}
                              >
                                {sourceLabel(panel.source)}
                              </span>
                            </>
                          )
                        }
                        meta={
                          <>
                            {progress ? (
                              <p className="panel-card__meta panel-card__meta--progress">
                                {`${progress.chapterTitle ?? 'Chapter'} · Page ${progress.page + 1}`}
                              </p>
                            ) : (
                              panel.latestChapter && (
                                <p className="panel-card__meta">{panel.latestChapter}</p>
                              )
                            )}
                            {progress && panel.latestChapter && (
                              <p className="panel-card__meta panel-card__meta--latest">
                                Latest · {panel.latestChapter}
                              </p>
                            )}
                            {!progress && panel.updatedAt && (
                              <p className="panel-card__meta">{formatDate(panel.updatedAt)}</p>
                            )}
                          </>
                        }
                        actions={
                          <LatestCardActions
                            panelId={panel.id}
                            title={panel.title}
                            source={panel.source}
                            sourceUrl={panel.sourceUrl}
                            coverUrl={panel.coverUrl}
                            isBookmarked={bookmarked}
                            progress={progress}
                          />
                        }
                        onPreviewShow={showCoverPreview}
                        onPreviewHide={hideCoverPreview}
                      />
                    );
                  })}
                </PanelList>
              ) : (
              <PanelGrid className="panel-grid--latest">
                {filteredResults.map((panel) => {
                  const progress = progressByPanelId.get(panel.id) ?? null;
                  const bookmarked = bookmarkedIds.has(panel.id);
                  const folderNames = folderNamesByPanelId.get(panel.id);
                  return (
                    <PanelCard
                      key={panel.id}
                      panel={panel}
                      bookmarked={bookmarked}
                      from="latest"
                      progress={progress}
                      folderNames={folderNames}
                      hideBookmarkBadge
                      hideBadges={settings.hideCoverBadges}
                      actions={
                        <LatestCardActions
                          panelId={panel.id}
                          title={panel.title}
                          source={panel.source}
                          sourceUrl={panel.sourceUrl}
                          coverUrl={panel.coverUrl}
                          isBookmarked={bookmarked}
                          progress={progress}
                        />
                      }
                      footer={
                        !progress && panel.updatedAt ? (
                          <p className="panel-card__meta">{formatDate(panel.updatedAt)}</p>
                        ) : null
                      }
                    />
                  );
                })}
              </PanelGrid>
              )}
              {infiniteScroll ? (
                <>
                  {/* Sentinel: paged nav is replaced by scroll-appended
                      pages; the marker pulls the next page into view. */}
                  <div ref={sentinelRef} aria-hidden="true" />
                  {loadingMore && <div className="latest-loading" aria-live="polite" />}
                  {loadMoreError && (
                    <ErrorState
                      title="Could not load the next page"
                      message={loadMoreError}
                      onRetry={() => void loadNextInfinitePage()}
                    />
                  )}
                  {!infiniteHasMore && extraPages.length > 0 && (
                    <p className="pagination__page" aria-live="polite">
                      You&apos;re all caught up
                    </p>
                  )}
                </>
              ) : (
                <Pagination page={page} hasMore={latest.data.hasMore} source={source} />
              )}
            </>
          ) : (
            <EmptyState
              title="No matches"
              message="No updates in this page match the selected filters."
            />
          )}
        </>
      )}
    </div>
  );
}

/** URL for a latest-updates page; shared by the pagination links and keyboard nav. */
function latestPath(page: number, source: string): string {
  // Build via URLSearchParams so the source survives paging ("&", not a
  // second "?").
  const query = new URLSearchParams({ source }).toString();
  return page === 1 ? `/latest?${query}` : `/latest?page=${page}&${query}`;
}

function Pagination({ page, hasMore, source }: { page: number; hasMore: boolean; source: string }) {
  return (
    <nav className="pagination" aria-label="Latest updates pages">
      {page > 1 ? (
        <Link
          className="btn btn--ghost btn--sm"
          to={latestPath(page - 1, source)}
          aria-keyshortcuts="ArrowLeft ArrowUp A W"
          title="Previous page (← / ↑)"
        >
          Previous
        </Link>
      ) : (
        <span className="btn btn--ghost btn--sm pagination__disabled">Previous</span>
      )}
      <span className="pagination__page" aria-current="page">
        Page {page}
      </span>
      {hasMore ? (
        <Link
          className="btn btn--ghost btn--sm"
          to={latestPath(page + 1, source)}
          aria-keyshortcuts="ArrowRight ArrowDown D S"
          title="Next page (→ / ↓)"
        >
          Next
        </Link>
      ) : (
        <span className="btn btn--ghost btn--sm pagination__disabled">Next</span>
      )}
    </nav>
  );
}
