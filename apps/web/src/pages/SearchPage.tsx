import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { CardLayout, PanelStatus, SourceSearchResult } from '@panel/shared';
import { useDelayedLoading } from '../hooks/useDelayedLoading';
import { useDisplaySettings } from '../hooks/useDisplaySettings';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  useBookmarks,
  useGenreList,
  useSearch,
  useSearchSettings,
  useSaveSearchSettings,
} from '../api/hooks';
import { useVisibleSource } from '../hooks/useVisibleSource';
import { api } from '../api/client';
import { PanelCard, PanelGrid, type PanelCardProgress } from '../components/PanelCard';
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
import { sourceLabel } from '../utils/format';

/** Search results screen with loading / empty / error states. */
export function SearchPage() {
  useDocumentTitle('Search');
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const query = (params.get('q') ?? '').trim();
  const pageParam = Number.parseInt(params.get('page') ?? '1', 10);
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  // Always query exactly one source — no fan-out "all sources" mode.
  // The default is the first visible source in the user's order (Sources
  // page). A `?source=` naming a hidden source remaps to the default.
  const source = useVisibleSource(params, setParams);

  /** Combined filters: status is client-side only, while the genre pair is
      ALSO sent to the API — combo-capable sources filter server-side
      (include = OR) and the rest fall back to narrowing the fetched page
      here (plus the exclude filter, always). */
  const [statusFilter, setStatusFilter] = useState<PanelStatus | ''>('');
  const [genreFilter, setGenreFilter] = useState<string[]>([]);
  /** Genres to hide: any result carrying ANY excluded genre is dropped,
      even if it also matches the include filter (exclude wins). */
  const [excludedGenre, setExcludedGenre] = useState<string[]>([]);

  /**
   * Infinite-scroll preference, persisted server-side to
   * `data/display/search.json` (independent from the latest-page toggle).
   * OFF by default (classic pagination). While a save is in flight the
   * pending value wins so the switch flips instantly instead of waiting
   * for the round-trip.
   */
  const searchSettingsQuery = useSearchSettings();
  const saveSearchSettings = useSaveSearchSettings();
  const infiniteScroll =
    saveSearchSettings.isPending && saveSearchSettings.variables
      ? saveSearchSettings.variables.infiniteScroll
      : (searchSettingsQuery.data?.infiniteScroll ?? false);
  /**
   * Cards/list layout, persisted server-side to `data/display/search.json`
   * alongside the infinite-scroll toggle. Same pending-wins pattern so the
   * toggle flips instantly instead of waiting for the round-trip.
   */
  const cardLayout: CardLayout =
    saveSearchSettings.isPending && saveSearchSettings.variables
      ? saveSearchSettings.variables.cardLayout
      : (searchSettingsQuery.data?.cardLayout ?? 'cards');
  /**
   * Collapsed refinement filters, persisted server-side to
   * `data/display/search.json`. Collapsed by default so the toolbar stays
   * compact; same pending-wins pattern as the other toggles.
   */
  const filtersCollapsed: boolean =
    saveSearchSettings.isPending && saveSearchSettings.variables
      ? saveSearchSettings.variables.filtersCollapsed
      : (searchSettingsQuery.data?.filtersCollapsed ?? true);
  /**
   * Don't paint either layout until the persisted choice resolves — a hard
   * refresh would otherwise flash the card grid (the `?? 'cards'` fallback)
   * for a beat even when list mode is stored. Errors fall back to cards.
   */
  const layoutReady =
    (saveSearchSettings.isPending && saveSearchSettings.variables != null) ||
    searchSettingsQuery.isSuccess ||
    searchSettingsQuery.isError;

  // In infinite mode the base query is pinned to page 1 and extra pages
  // are appended below (fetched imperatively so the hook count stays
  // static). The `?page=` param then only records how deep the user has
  // scrolled — a refresh with `?page=N` reloads pages 1..N.
  const search = useSearch(
    query,
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
   * payload for page `i + 2` (page 1 comes from the `search` query above).
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
   * can outlive its render: `placeholderData` keeps `search.data`
   * referentially stable across a source switch, so the sentinel effect —
   * and its stale `source`/`params` closure — survives the tap. Reading
   * through refs (plus the post-fetch identity check) means a stale
   * callback can neither append another source's page nor navigate the URL
   * back to it (the "source snaps back" bug).
   */
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const queryRef = useRef(query);
  queryRef.current = query;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const genreFilterRef = useRef(genreFilter);
  genreFilterRef.current = genreFilter;
  const excludedGenreRef = useRef(excludedGenre);
  excludedGenreRef.current = excludedGenre;
  const extraPagesRef = useRef(extraPages);
  extraPagesRef.current = extraPages;

  /**
   * Unmount guard for the infinite-scroll loader below. Navigating away
   * (e.g. Home) while a page fetch is in flight must not let the stale
   * callback rewrite the URL when it resolves — the router's navigate stays
   * valid post-unmount, so an unguarded `setParams` snaps the fresh route
   * back to the old search page. Setup re-arms on StrictMode remounts.
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fresh result identity (query / source / server-side filters / mode
  // switch) — drop appended pages so page 2 of the old query never leaks
  // in.
  // NOTE: this effect must NEVER navigate. A second navigation issued
  // here aborts an in-flight push from the event that changed the
  // identity (e.g. changeSource), freezing the grid on the old source.
  // URL writes live exclusively in the event handlers below, one
  // navigation per gesture.
  useEffect(() => {
    resetExtraPages();
  }, [query, source, genreFilter, excludedGenre, infiniteScroll]);
  const showLoading = useDelayedLoading(search.isLoading);
  const { settings } = useDisplaySettings();

  // Highlight results already on the user's shelf. One `useBookmarks()` query
  // covers every card — add/remove elsewhere already invalidates + rewrites
  // this cache, so the highlight stays in sync with no extra wiring.
  const bookmarks = useBookmarks();
  const bookmarkedIds = useMemo(
    () => new Set((bookmarks.data ?? []).map((b) => b.panelId)),
    [bookmarks.data],
  );
  /** Progress from bookmarks (same shape as LatestPage) so search cards
      can render Continue buttons and the LatestCardActions strip. */
  const progressByPanelId = useMemo(() => {
    const map = new Map<string, PanelCardProgress | null>();
    for (const bookmark of bookmarks.data ?? []) {
      if (bookmark.progress) {
        map.set(bookmark.panelId, {
          chapterId: bookmark.progress.chapterId,
          chapterTitle: bookmark.progress.chapterTitle,
        });
      }
    }
    return map;
  }, [bookmarks.data]);

  /** All loaded rows in infinite mode (base page + appended pages). */
  const allResults = useMemo(() => {
    const base = search.data?.results ?? [];
    if (!infiniteScroll || extraPages.length === 0) return base;
    return [...base, ...extraPages.flatMap((p) => p.results)];
  }, [search.data, extraPages, infiniteScroll]);

  /** Whether another page exists after everything loaded so far. */
  const infiniteHasMore =
    extraPages.length > 0
      ? (extraPages[extraPages.length - 1]?.hasMore ?? false)
      : (search.data?.hasMore ?? false);

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
   * one, otherwise the genres seen on this page.
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
        // Genre-less items are kept: combo-capable sources already
        // filtered server-side, so an empty list means "unknown" (e.g. a
        // skipped enrichment), not "doesn't match".
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

  // Keyboard paging: ←/A = previous page, →/D = next page (mirrors the
  // latest page). Only active while results are on screen, skipped when
  // typing in the search field, a dropdown, or using modifiers — and
  // disabled entirely while infinite scroll owns the page flow.
  const hasResults = allResults.length > 0;
  const hasMore = search.data?.hasMore ?? false;
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

      if ((event.key === 'ArrowLeft' || event.key === 'a') && page > 1) {
        event.preventDefault();
        navigate(searchPath(page - 1, query, source));
      } else if ((event.key === 'ArrowRight' || event.key === 'd') && hasMore) {
        event.preventDefault();
        navigate(searchPath(page + 1, query, source));
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [page, hasMore, query, source, hasResults, infiniteScroll, navigate]);

  /**
   * Append one page in infinite mode and record the new depth in the URL
   * (`?page=N`, replace — no history spam, `q` preserved). Failures
   * surface a retry affordance instead of silently stalling the sentinel.
   */
  async function loadNextInfinitePage() {
    if (!infiniteScroll || loadingMore || search.isLoading) return;
    if (!infiniteHasMore) return;
    // Snapshot live values (see refs above) — never the render closure's.
    const liveQuery = queryRef.current;
    const liveSource = sourceRef.current;
    const liveGenres = genreFilterRef.current;
    const liveExcludes = excludedGenreRef.current;
    const next = extraPagesRef.current.length + 2;
    const generation = generationRef.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const payload = await api.search(
        liveQuery,
        next,
        liveSource,
        liveGenres.length > 0 ? liveGenres : undefined,
        liveExcludes.length > 0 ? liveExcludes : undefined,
      );
      // Navigated away mid-flight (e.g. Home) — drop the stale page
      // instead of rewriting the new route's URL back to this search.
      if (!mountedRef.current) return;
      if (generationRef.current !== generation) return;
      // Query or source moved on mid-flight — drop the stale page instead
      // of mixing result sets or rewriting the URL.
      if (queryRef.current !== liveQuery || sourceRef.current !== liveSource) return;
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
    if (!infiniteScroll || !search.isSuccess) return;
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
  }, [infiniteScroll, search.isSuccess, search.data, extraPages.length, loadingMore]);

  // Deep-link restore: a refresh with `?page=N` while infinite scroll is
  // on backfills pages 2..N so the scroll position survives a reload.
  useEffect(() => {
    if (!infiniteScroll || !search.isSuccess) return;
    if (page <= 1 || loadingMore) return;
    if (extraPages.length + 1 >= page) return;
    if (!infiniteHasMore) return;
    void loadNextInfinitePage();
    // oxlint-disable-next-line react/exhaustive-deps
  }, [infiniteScroll, search.isSuccess, page, extraPages.length]);

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
    saveSearchSettings.mutate({ infiniteScroll: next, cardLayout, filtersCollapsed });
  }

  function handleLayoutChange(next: CardLayout) {
    if (next === cardLayout) return;
    saveSearchSettings.mutate({ infiniteScroll, cardLayout: next, filtersCollapsed });
  }

  function handleFiltersToggle(next: boolean) {
    if (next === filtersCollapsed) return;
    saveSearchSettings.mutate({ infiniteScroll, cardLayout, filtersCollapsed: next });
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
    <div className="page search-page">
      <h1 className="sr-only">Search</h1>

      <div className="search-toolbar">
        {query.length > 0 && <SourceFilter value={source} onChange={changeSource} />}
        <div className="search-toolbar__search">
          <SearchBar initialValue={query} autoFocus={query.length === 0} showPasteButton />
        </div>
          {layoutReady && search.isSuccess && search.data.results.length > 0 && (
            <>
          <div className="search-filters search-filters--toggles" role="group" aria-label="Search view options">
              {/* Infinite-scroll toggle first — left of the status dropdown.
                  Persisted to `data/display/search.json` on the server. */}
              <span className="search-filters__switch">
                <span className="search-filters__label" id="search-infinite-scroll-label">
                  Infinite scroll
                </span>
                <Switch
                  checked={infiniteScroll}
                  onChange={handleInfiniteToggle}
                  labelledBy="search-infinite-scroll-label"
                  size="sm"
                />
              </span>
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
              <CardLayoutToggle
                value={cardLayout}
                onChange={handleLayoutChange}
                labelId="search-layout-label"
              />
          </div>
              {!filtersCollapsed && (
          <div className="search-filters search-filters--fields" role="group" aria-label="Refine results">
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

      {query.length === 0 && (
        <EmptyState title="Search for a panel" message="Type a title above to get started." />
      )}

{query.length > 0 && showLoading && (
        <>
          <p className="page-subtitle">Searching for "{query}"…</p>
          <div className="search-loading" aria-live="polite" />
        </>
      )}

      {search.isError && (
        <ErrorState
          title="Search failed"
          message={search.error.message}
          onRetry={() => search.refetch()}
        />
      )}

      {search.isSuccess && (
        <>
          {filteredResults.length > 0 ? (
            <>
              {!layoutReady ? (
                <div className="search-loading" aria-live="polite" />
              ) : cardLayout === 'list' ? (
                <PanelList className="panel-list--search">
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
                        to={`/panel/${encodeURIComponent(panel.id)}?from=search`}
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
                          progress ? (
                            <p className="panel-card__meta panel-card__meta--progress">
                              {progress.chapterTitle ?? 'Chapter'}
                            </p>
                          ) : (
                            panel.latestChapter && (
                              <p className="panel-card__meta">{panel.latestChapter}</p>
                            )
                          )
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
              <PanelGrid>
                {filteredResults.map((panel) => {
                  const progress = progressByPanelId.get(panel.id) ?? null;
                  const bookmarked = bookmarkedIds.has(panel.id);
                  return (
                    <PanelCard
                      key={panel.id}
                      panel={panel}
                      bookmarked={bookmarked}
                      from="search"
                      progress={progress}
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
                  {loadingMore && <div className="search-loading" aria-live="polite" />}
                  {loadMoreError && (
                    <ErrorState
                      title="Could not load the next page"
                      message={loadMoreError}
                      onRetry={() => void loadNextInfinitePage()}
                    />
                  )}
                  {!infiniteHasMore && extraPages.length > 0 && (
                    <p className="pagination__page" aria-live="polite">
                      No more results
                    </p>
                  )}
                </>
              ) : (
                <Pagination page={page} hasMore={search.data.hasMore} query={query} source={source} />
              )}
            </>
          ) : (
            <EmptyState
              title="Nothing found"
              message="Try a different title, or check the spelling."
            />
          )}
        </>
      )}
    </div>
  );
}

/** URL for a search-results page; shared by the pagination links and keyboard nav. */
function searchPath(page: number, query: string, source: string): string {
  const params = new URLSearchParams({ q: query, source });
  if (page > 1) params.set('page', String(page));
  return `/search?${params.toString()}`;
}

function Pagination({
  page,
  hasMore,
  query,
  source,
}: {
  page: number;
  hasMore: boolean;
  query: string;
  source: string;
}) {
  return (
    <nav className="pagination" aria-label="Search result pages">
      {page > 1 ? (
        <Link
          className="btn btn--ghost btn--sm"
          to={searchPath(page - 1, query, source)}
          aria-keyshortcuts="ArrowLeft A"
          title="Previous page (←)"
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
          to={searchPath(page + 1, query, source)}
          aria-keyshortcuts="ArrowRight D"
          title="Next page (→)"
        >
          Next
        </Link>
      ) : (
        <span className="btn btn--ghost btn--sm pagination__disabled">Next</span>
      )}
    </nav>
  );
}
