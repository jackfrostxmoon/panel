import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { PanelStatus } from '@panel/shared';
import { useDelayedLoading } from '../hooks/useDelayedLoading';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useDisplaySettings } from '../hooks/useDisplaySettings';
import { useBookmarks, useBookmarkFolders, useLatest, useGenreList } from '../api/hooks';
import { PanelCard, PanelGrid } from '../components/PanelCard';
import { LatestCardActions } from '../components/LatestCardActions';
import { SearchBar } from '../components/SearchBar';
import { SourceFilter } from '../components/SourceFilter';
import { EmptyState, ErrorState } from '../components/StateView';
import { DEFAULT_SOURCE, formatDate } from '../utils/format';

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
      constraints are ALSO sent to the API: sources with server-side genre
      filtering search their whole catalog, the rest fall back to narrowing
      the fetched page here (plus the exclude filter, always). */
  const [statusFilter, setStatusFilter] = useState<PanelStatus | ''>('');
  const [genreFilter, setGenreFilter] = useState('');
  /** Genres to hide: any result carrying the excluded genre is dropped,
      even if it also matches the include filter (exclude wins). */
  const [excludedGenre, setExcludedGenre] = useState('');

  const latest = useLatest(page, source, genreFilter || undefined, excludedGenre || undefined, {
    placeholderData: (previous) => previous,
  });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /** Genres present in the current result set, for the dropdown options. */
  const availableGenres = useMemo(() => {
    const set = new Set<string>();
    for (const panel of latest.data?.results ?? []) {
      for (const g of panel.genres) set.add(g);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [latest.data]);

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

  const filteredResults = useMemo(() => {
    const results = latest.data?.results ?? [];
    return results.filter(
      (m) =>
        (!statusFilter || m.status === statusFilter) &&
        // Genre-less items are kept: the server already filtered by genre,
        // so an empty list means "unknown" (e.g. a skipped enrichment),
        // not "doesn't match". Dropping them would hide genuine matches.
        (!genreFilter ||
          m.genres.length === 0 ||
          m.genres.some((g) => g.toLowerCase() === genreFilter.toLowerCase())) &&
        (!excludedGenre ||
          !m.genres.some((g) => g.toLowerCase() === excludedGenre.toLowerCase())),
    );
  }, [latest.data, statusFilter, genreFilter, excludedGenre]);

  const filtersActive = statusFilter !== '' || genreFilter !== '' || excludedGenre !== '';

  // Keyboard paging: ←/A = previous page, →/D = next page (mirrors the
  // reader's navigation keys). Only active while results are on screen and
  // skipped when typing in an input or using modifier combos.
  const hasResults = (latest.data?.results.length ?? 0) > 0;
  const hasMore = latest.data?.hasMore ?? false;
  useEffect(() => {
    if (!hasResults) return;

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
        navigate(latestPath(page - 1, source));
      } else if ((event.key === 'ArrowRight' || event.key === 'd') && hasMore) {
        event.preventDefault();
        navigate(latestPath(page + 1, source));
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [page, hasMore, source, hasResults, navigate]);

  function changeSource(next: string) {
    if (!next) return;
    const nextParams = new URLSearchParams(params);
    nextParams.set('source', next);
    nextParams.delete('page');
    setParams(nextParams);
    // Genre vocabularies are per-source — a label picked for one source
    // may not exist in another, so reset both genre filters on switch.
    setGenreFilter('');
    setExcludedGenre('');
  }

  return (
    <div className="page latest-page">
      <h1 className="sr-only">Latest updates</h1>

      {/* Toolbar DOM mirrors the search page (pills · search · filters);
          CSS `order` reorders desktop to pills · filters · search, and
          `margin-left: auto` on the filters pin them right of the pills. */}
      <div className="latest-toolbar">
        <SourceFilter value={source} onChange={changeSource} />
        <div className="latest-toolbar__search">
          {/* Regular size to match the pill-strip height; submits navigate
              to the search page. */}
          <SearchBar showPasteButton />
        </div>
        {latest.isSuccess && latest.data.results.length > 0 && (
          <div className="search-filters" role="group" aria-label="Refine latest updates">
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
                'search-filters__select' + (genreFilter ? ' search-filters__select--active' : '')
              }
              aria-label="Filter by genre"
              value={genreFilter}
              onChange={(e) => setGenreFilter(e.target.value)}
            >
              <option value="">Any genre</option>
              {genreOptions.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <select
              className={
                'search-filters__select' + (excludedGenre ? ' search-filters__select--active' : '')
              }
              aria-label="Exclude genre"
              value={excludedGenre}
              onChange={(e) => setExcludedGenre(e.target.value)}
            >
              <option value="">Exclude genre</option>
              {genreOptions.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            {filtersActive && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setStatusFilter('');
                  setGenreFilter('');
                  setExcludedGenre('');
                }}
              >
                Clear filters
              </button>
            )}
          </div>
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

      {latest.isSuccess && latest.data.results.length === 0 && (
        <EmptyState title="No updates found" message="Try refreshing in a little while." />
      )}

      {latest.data && latest.data.results.length > 0 && (
        <>
          {filteredResults.length > 0 ? (
            <>
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
              <Pagination page={page} hasMore={latest.data.hasMore} source={source} />
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
          to={latestPath(page + 1, source)}
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
