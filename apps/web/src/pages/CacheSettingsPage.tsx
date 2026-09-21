import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import type { Bookmark, Chapter } from '@panel/shared';
import {
  chapterLabel,
  formatBytes,
  sourceLabel,
} from '../utils/format';
import { cacheTagPrefix } from '../utils/sha256';
import {
  useCacheSettings,
  useSaveCacheSettings,
  useClearImageCache,
  useClearImageCacheByTag,
  useClearRecentlyViewed,
  useImageCacheTags,
  useImageCacheTagsSize,
  useImageCacheStats,
  useImageCacheLimit,
  useSetImageCacheLimit,
  usePruneLegacyImageCache,
  useCachedChapterIds,
  useChapters,
  useBookmarks,
  useProgressForPanel,
  useChapterBookmarks,
} from '../api/hooks';
import type { ImageCacheTagSummary } from '../api/client';
import { chapterIdsForSelectedTags } from '../utils/imageCache';
import { useToast } from '../components/Toast';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState, ErrorState } from '../components/StateView';
import { FilterSearchBar } from '../components/FilterSearchBar';
import { Switch } from '../components/Switch';
import {
  IconArrowLeft,
  IconChevronRight,
  IconExternal,
  IconTrash,
  IconX,
} from '../components/icons';
import {
  loadRecentlyViewed,
  clearRecentlyViewed,
  type RecentlyViewedEntry,
} from '../utils/recentlyViewed';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

/**
 * Image cache management — full-page view of the on-disk proxied-image
 * cache. Lets the user see how full the cache is, how its size breaks
 * down by kind (covers / chapter pages), and selectively clear at three
 * granularities:
 *
 *   - kind (covers / chapter pages / both)
 *   - source (clear one source's covers or chapter pages)
 *   - per-panel and per-chapter (drill-in via a modal)
 *
 * Reached from the home page widget's "Open cache settings" link. No
 * topbar entry.
 */
type ClearKind = 'cover' | 'chapter' | 'both';

/** Live-refresh poll interval — matches the page's freshness expectations. */
const LIVE_REFRESH_MS = 5_000;

export function CacheSettingsPage() {
  useDocumentTitle('Image cache');
  const { toast } = useToast();
  const stats = useImageCacheStats();
  const limitQuery = useImageCacheLimit();
  const setLimitMutation = useSetImageCacheLimit();
  const coverTags = useImageCacheTags('cover');
  const chapterTags = useImageCacheTags('chapter');
  const bookmarksQuery = useBookmarks();
  /**
   * Live-refresh preference, persisted server-side to
   * `data/display/cache.json`. OFF by default (manual refresh). While a
   * save is in flight the pending value wins so the switch flips
   * instantly instead of waiting for the round-trip.
   */
  const cacheSettingsQuery = useCacheSettings();
  const saveCacheSettings = useSaveCacheSettings();
  const liveRefresh =
    saveCacheSettings.isPending && saveCacheSettings.variables
      ? saveCacheSettings.variables.liveRefresh
      : (cacheSettingsQuery.data?.liveRefresh ?? false);

  function handleLiveToggle(next: boolean) {
    if (next === liveRefresh) return;
    saveCacheSettings.mutate({ liveRefresh: next });
    // Refresh immediately on opting in — otherwise the first poll lands
    // a full interval later and the toggle feels dead.
    if (next) refetchAllRef.current();
  }

  /**
   * Latest refetch-all closure for the live interval below. Kept in a ref
   * (mirroring the reader's *Ref pattern) because the query result objects
   * are referentially new every render — depending on them would reset the
   * interval on every render and it would never fire.
   */
  const refetchAllRef = useRef(() => {});
  refetchAllRef.current = () => {
    void stats.refetch();
    void limitQuery.refetch();
    void coverTags.refetch();
    void chapterTags.refetch();
    void tagsSizeQuery.refetch();
    void bookmarksQuery.refetch();
  };

  /* Live refresh: re-poll every stats/size query on an interval. Manual
     mode (default) only refetches on mount and after clear actions. */
  useEffect(() => {
    if (!liveRefresh) return;
    const id = window.setInterval(() => refetchAllRef.current(), LIVE_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [liveRefresh]);
  const clearMutation = useClearImageCache();
  const clearByTagMutation = useClearImageCacheByTag();
  const clearRecentlyViewedMutation = useClearRecentlyViewed();
  const pruneLegacyMutation = usePruneLegacyImageCache();
  const [pendingClear, setPendingClear] = useState<ClearKind | null>(null);
  const [drillPanel, setDrillPanel] = useState<Bookmark | null>(null);
  /** Local title filter for the "Your panel" list — narrows the rows down
      without a server round-trip so it stays snappy even with hundreds of
      bookmarks. Empty string means "no filter". */
const [panelQuery, setPanelQuery] = useState('');
  /** Hide 0 B rows in the "Your panel" list. ON by default (see loader). */
  const [hideUncached, setHideUncached] = useState(loadPanelHideUncached);

  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_HIDE_UNCACHED_KEY, hideUncached ? '1' : '0');
    } catch {
      // Storage blocked — the toggle just won't survive a reload.
    }
  }, [hideUncached]);

  const isPending =
    clearMutation.isPending || clearByTagMutation.isPending || pruneLegacyMutation.isPending;

  // Per-kind breakdown. The stats endpoint always returns both kinds.
  const cover = stats.data?.cover ?? { entryCount: 0, totalBytes: 0 };
  const chapter = stats.data?.chapter ?? { entryCount: 0, totalBytes: 0 };
  const total = stats.data?.totalBytes ?? 0;
  const cap = stats.data?.capBytes ?? 0;
  const usedPercent = cap > 0 ? Math.min(100, Math.round((total / cap) * 100)) : 0;
  const totalEntries = stats.data?.entryCount ?? 0;

  /**
   * Custom size-limit override. `limitGb` is the GB text field, seeded from
   * the server value until the user edits it (and re-seeded after a
   * successful save so it always reflects what's stored).
   */
  const customLimitBytes = limitQuery.data?.customMaxBytes ?? null;
  const computedLimitBytes = limitQuery.data?.computedCapBytes ?? 0;
  const [limitGb, setLimitGb] = useState<string | null>(null);
  const shownLimitGb =
    limitGb ?? String(Math.round(((customLimitBytes ?? computedLimitBytes) / 1024 ** 3) * 100) / 100);

  async function doSaveLimit() {
    const gb = Number.parseFloat(shownLimitGb);
    if (!Number.isFinite(gb)) {
      toast('Enter a limit size in GB (e.g. 8).', 'error');
      return;
    }
    const bytes = Math.round(gb * 1024 ** 3);
    if (bytes < 64 * 1024 * 1024 || bytes > 1024 ** 4) {
      toast('The limit must be between 0.0625 GB (64 MB) and 1024 GB (1 TB).', 'error');
      return;
    }
    try {
      await setLimitMutation.mutateAsync(bytes);
      setLimitGb(null);
      toast(`Cache size limit set to ${formatBytes(bytes)}.`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not update the cache size limit.', 'error');
    }
  }

  async function doClearLimit() {
    try {
      await setLimitMutation.mutateAsync(null);
      setLimitGb(null);
      toast('Cache size limit is automatic again.', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not update the cache size limit.', 'error');
    }
  }

  /**
   * LEGACY cache entries: files written before the provenance-tag format.
   * The headline stat counts every file on disk, while the per-tag lists
   * (covers + chapter pages) only know about tagged ones — the difference
   * is exactly the legacy set. They never show up in any per-panel /
   * per-chapter view and their URL keys are usually stale (tokenized
   * sources rotate their URLs), so they're invisible dead weight.
   */
  const taggedEntries =
    (coverTags.data?.reduce((sum, t) => sum + t.entryCount, 0) ?? 0) +
    (chapterTags.data?.reduce((sum, t) => sum + t.entryCount, 0) ?? 0);
  const legacyEntries = Math.max(0, totalEntries - taggedEntries);

  async function doPruneLegacy() {
    try {
      const result = await pruneLegacyMutation.mutateAsync();
      toast(
        `Pruned ${result.entryCount.toLocaleString()} legacy cache file(s) (${formatBytes(result.totalBytes)} freed).`,
        'success',
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not prune legacy cache files.', 'error');
    }
  }

  // "Your panel" list. The user's bookmarks (fetched from the API via
  // TanStack Query) are the authoritative source — every panel the user
  // has explicitly saved shows up here, including ones they never opened
  // the details page for (which the old "recently viewed" rail missed).
  // While the bookmarks query is loading or when the user has no
  // bookmarks yet, fall back to the localStorage "recently viewed" list
  // (read best-effort, never throws) so the section isn't a blank slate
  // for a brand-new install. Once bookmarks resolve, the row order is
  // server-controlled ("recently updated first" by `updatedAt desc`).
  const yourPanel = useMemo<Bookmark[]>(() => {
    const bookmarks = bookmarksQuery.data ?? [];
    if (bookmarks.length > 0) {
      // Bookmark order is already "recently updated first" (server-side
      // orderBy updatedAt desc), so keep it as-is.
      return bookmarks;
    }
    // Fallback: no bookmarks yet (e.g. brand-new install, API still
    // loading) — fall back to recently-viewed so the section isn't
    // empty when the user has at least opened a panel. We project the
    // localStorage shape to the Bookmark shape so the rest of the page
    // (drill-in, doClearByTag) can treat every row uniformly.
    const recent = loadRecentlyViewed();
    return recent.map(toBookmarkFallback);
  }, [bookmarksQuery.data]);

  /** Provenance tag for each row's cover — `entry.panelId` is the global panel
      * id (`<source>:<nativeId>`), which is exactly the tag the proxy bakes
      * into cached cover filenames. Passed to the batched size endpoint so the
      * list shows every panel's total footprint in one round-trip. */
  const panelIds = useMemo<string[]>(
    () => yourPanel.map((entry) => entry.panelId),
    [yourPanel],
  );

  /** Global ids of every chapter the user has already opened (and thus cached
      * on disk). Sent alongside the panel ids so the server can attribute each
      * cached chapter's pages to the panel that owns them — a chapter id and
      * its panel id are different provenance strings with different tag
      * hashes, so the per-panel size query can only match chapter pages once
      * they've been resolved server-side. */
  const cachedChapterIds = useCachedChapterIds();

  /** Total cached footprint per panel (cover + chapter pages merged), in a
       * single round-trip. Zeroed rows for panel with no cached files, so the
       * list renders a stable "0 B / 0 files" instead of omitting the row.
       * Refreshed by the Live-refresh toggle's interval — in manual mode a
       * just-cleared row updates on revisit or after a clear action. */
  const tagsSizeQuery = useImageCacheTagsSize(panelIds, cachedChapterIds);

  /** 8-hex-tag-hash → total-size lookup for the "Your panel" rows. The
      * server returns rows keyed by the hash, so we hash each panel id the
      * same way `cacheTagPrefix` does (matching the server's `tagPrefix`) and
      * build the map once per render — a panel with no cached files simply
      * isn't in the map and reads as zero. */
  const panelSizeByTag = useMemo(() => {
    const m = new Map<string, ImageCacheTagSummary>();
    for (const row of tagsSizeQuery.data ?? []) m.set(row.tag, row);
    return m;
  }, [tagsSizeQuery.data]);

  /** Look up a row's total cached footprint (cover + chapter pages). */
  const panelTotal = (entry: Bookmark): ImageCacheTagSummary => {
    const tag = cacheTagPrefix(entry.panelId);
    return (
      panelSizeByTag.get(tag) ?? {
        tag,
        entryCount: 0,
        totalBytes: 0,
      }
    );
  };

  /** Filtered view of `yourPanel` — matches the trimmed query against the
      title, the source code (mk/nk/rk/…) and the friendly source label
      ("MangaKatana") so a user can type either. Empty query = passthrough.
      On top, the Hide-uncached toggle drops 0 B rows — but only once the
      size data has arrived, so rows never vanish-then-pop-back while the
      sizes are still loading. */
  const filteredYourPanel = useMemo<Bookmark[]>(() => {
    const needle = panelQuery.trim().toLowerCase();
    const textFiltered = !needle
      ? yourPanel
      : yourPanel.filter((entry) => {
          const title = entry.title.toLowerCase();
          const code = entry.source.toLowerCase();
          const label = sourceLabel(entry.source).toLowerCase();
          return title.includes(needle) || code.includes(needle) || label.includes(needle);
        });
    if (!hideUncached || tagsSizeQuery.data == null) return textFiltered;
    return textFiltered.filter((entry) => panelTotal(entry).entryCount > 0);
    // panelTotal reads the size map (driven by tagsSizeQuery.data), which
    // the linter can't see through the function boundary.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [yourPanel, panelQuery, hideUncached, tagsSizeQuery.data]);

  /** True only when the filter is hiding rows — drives the result-count
      chip and the "no matches" empty state. */
  const isFiltering = panelQuery.trim().length > 0;

  /** Titles with at least one cached file — the summary's "n cached" tag.
      Mirrors the ghosted/uncached rows below. */
  const cachedPanelCount = yourPanel.reduce(
    (count, entry) => count + (panelTotal(entry).entryCount > 0 ? 1 : 0),
    0,
  );

  async function doClear(what: ClearKind) {
    try {
      const result = await clearMutation.mutateAsync(what);
      const label =
        what === 'cover' ? 'cover images' :
        what === 'chapter' ? 'chapter images' :
        'cached images';
      toast(
        `Cleared ${result.entryCount.toLocaleString()} ${label} (${formatBytes(result.totalBytes)} freed).`,
        'success',
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not clear the image cache.', 'error');
    }
  }

  async function doClearByTag(what: 'cover' | 'chapter' | 'both', tag: string, label: string) {
    try {
      const result = await clearByTagMutation.mutateAsync({ what, tag });
      const kindLabel = what === 'cover' ? 'cover images' : what === 'chapter' ? 'chapter pages' : 'cached images';
      toast(`Cleared ${result.entryCount.toLocaleString()} ${kindLabel} for ${label} (${formatBytes(result.totalBytes)} freed).`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not clear the image cache.', 'error');
    }
  }

  /**
   * Clear a hand-picked list of chapter global ids (the rows the user
   * ticked in the drill-in dialog, resolved from their tag hashes — the
   * API only accepts raw provenance strings, not 8-hex hashes). The API
   * has no batch endpoint, so we clear one chapter at a time and
   * aggregate the totals. We bail on the first failure to avoid leaving
   * the cache in a half-cleared state the user thinks is complete.
   */
  async function clearSelectedChapters(panelTitle: string, chapterIds: string[]) {
    if (chapterIds.length === 0) return;
    let totalFiles = 0;
    let totalBytes = 0;
    for (const tag of chapterIds) {
      try {
        const result = await clearByTagMutation.mutateAsync({ what: 'chapter', tag });
        totalFiles += result.entryCount;
        totalBytes += result.totalBytes;
      } catch (error) {
        toast(
          `Cleared ${totalFiles.toLocaleString()} chapters of ${panelTitle} (${formatBytes(totalBytes)}) before an error stopped the batch.`,
          'error',
        );
        if (error instanceof Error) {
          console.error('clearSelectedChapters partial failure:', error);
        }
        return;
      }
    }
    toast(
      `Cleared ${chapterIds.length} ${chapterIds.length === 1 ? 'chapter' : 'chapters'} of ${panelTitle} (${totalFiles.toLocaleString()} files, ${formatBytes(totalBytes)} freed).`,
      'success',
    );
  }

  if (stats.isError) {
    return (
      <div className="page cache-settings" aria-labelledby="cache-settings-title">
        <ErrorState
          title="Could not load cache stats"
          message={stats.error.message}
          onRetry={() => void stats.refetch()}
        />
      </div>
    );
  }

  const isEmpty = total === 0 && totalEntries === 0;

  return (
    <div className="page cache-settings" aria-labelledby="cache-settings-title">
      <header className="page-header page-header--split">
        <div className="cache-settings__title-group">
          <Link to="/" className="cache-settings__back-link" aria-label="Back to home">
            <IconArrowLeft size={16} />
            <span>Back</span>
          </Link>
          <h1 id="cache-settings-title" className="cache-settings__title">Image cache</h1>
          <p className="cache-settings__subtitle">
            Storage for covers and chapter pages the API has proxied. Re-visits are served
            from disk, so a warm cache makes the app feel instant.
          </p>
        </div>
        <div className="cache-settings__actions">
          <span className="search-filters__switch">
            <span className="search-filters__label" id="cache-live-refresh-label">
              Live refresh
            </span>
            <Switch
              checked={liveRefresh}
              onChange={handleLiveToggle}
              labelledBy="cache-live-refresh-label"
              size="sm"
            />
          </span>
        </div>
      </header>

      {isEmpty ? (
        <EmptyState
          title="The image cache is empty"
          message="Covers and chapter pages you visit will be saved here automatically."
        />
      ) : (
        <>
          <section className="cache-settings__section" aria-labelledby="cache-usage-heading">
            <header className="section-header">
              <h2 id="cache-usage-heading" className="section-title">Usage</h2>
            </header>
            <div className="cache-settings__usage">
              <div className="cache-settings__usage-summary">
                <span className="cache-settings__usage-size">{formatBytes(total)}</span>
                {cap > 0 ? (
                  <span className="cache-settings__usage-cap">of {formatBytes(cap)}</span>
                ) : null}
                <span className="cache-settings__usage-percent">{usedPercent}%</span>
              </div>
              <div
                className="cache-settings__bar"
                role="progressbar"
                aria-valuenow={usedPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Cache usage: ${usedPercent}% of ${formatBytes(cap)}`}
              >
                <div className="cache-settings__bar-fill" style={{ width: `${usedPercent}%` }} />
              </div>
              <dl className="cache-settings__breakdown">
                <div className="cache-settings__breakdown-row">
                  <dt>Covers</dt>
                  <dd>
                    <strong>{formatBytes(cover.totalBytes)}</strong>
                    <span className="cache-settings__breakdown-meta">
                      {cover.entryCount.toLocaleString()} files
                    </span>
                  </dd>
                </div>
                <div className="cache-settings__breakdown-row">
                  <dt>Chapter pages</dt>
                  <dd>
                    <strong>{formatBytes(chapter.totalBytes)}</strong>
                    <span className="cache-settings__breakdown-meta">
                      {chapter.entryCount.toLocaleString()} files
                    </span>
                  </dd>
                </div>
              </dl>
            </div>
          </section>

          <section className="cache-settings__section" aria-labelledby="cache-limit-heading">
            <header className="section-header">
              <h2 id="cache-limit-heading" className="section-title">Maximum size</h2>
            </header>
            <p className="cache-settings__help">
              Eviction cap for the whole cache. By default the server derives it
              from free disk space ({formatBytes(computedLimitBytes)} right now);
              set a custom limit to pin it. Lowering the cap below current usage
              evicts the coldest entries immediately.
            </p>
            <div className="cache-settings__limit-row">
              <label className="cache-settings__limit-label" htmlFor="cache-limit-gb">
                Limit (GB)
              </label>
              <input
                id="cache-limit-gb"
                className="cache-settings__limit-input"
                type="number"
                min={0.0625}
                step={0.1}
                inputMode="decimal"
                value={shownLimitGb}
                onChange={(e) => setLimitGb(e.target.value)}
                disabled={limitQuery.isPending || setLimitMutation.isPending}
                aria-describedby="cache-limit-mode"
              />
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void doSaveLimit()}
                disabled={limitQuery.isPending || setLimitMutation.isPending}
              >
                {setLimitMutation.isPending ? 'Saving…' : 'Save'}
              </button>
              {customLimitBytes !== null && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void doClearLimit()}
                  disabled={limitQuery.isPending || setLimitMutation.isPending}
                >
                  Use automatic
                </button>
              )}
            </div>
            <p className="cache-settings__limit-meta" id="cache-limit-mode">
              {customLimitBytes !== null
                ? `Custom limit ${formatBytes(customLimitBytes)} (automatic would be ${formatBytes(computedLimitBytes)})`
                : `Automatic limit ${formatBytes(computedLimitBytes)}`}
            </p>
          </section>

          <section className="cache-settings__section" aria-labelledby="cache-actions-heading">
            <header className="section-header">
              <h2 id="cache-actions-heading" className="section-title">Clear all</h2>
            </header>
            <p className="cache-settings__help">
              Bulk actions for everything. Clearing frees disk space; the next visit
              re-fetches the same images from the source. Chapter pages are cached under
              a stable per-chapter key, so downloaded chapters survive source URL
              rotations — no re-download needed after the source refreshes its links.
            </p>
            <div className="cache-settings__actions-grid">
              <button
                type="button"
                className="cache-settings__action"
                disabled={isPending || cover.entryCount === 0}
                onClick={() => doClear('cover')}
                aria-label={`Clear all ${cover.entryCount} cached cover images`}
              >
                <span className="cache-settings__action-head">
                  <span className="cache-settings__action-title">Clear covers</span>
                  <IconTrash size={16} aria-hidden="true" />
                </span>
                <span className="cache-settings__action-meta">
                  {cover.entryCount.toLocaleString()} files · {formatBytes(cover.totalBytes)}
                </span>
              </button>
              <button
                type="button"
                className="cache-settings__action"
                disabled={isPending || chapter.entryCount === 0}
                onClick={() => doClear('chapter')}
                aria-label={`Clear all ${chapter.entryCount} cached chapter pages`}
              >
                <span className="cache-settings__action-head">
                  <span className="cache-settings__action-title">Clear chapter pages</span>
                  <IconTrash size={16} aria-hidden="true" />
                </span>
                <span className="cache-settings__action-meta">
                  {chapter.entryCount.toLocaleString()} files · {formatBytes(chapter.totalBytes)}
                </span>
              </button>
              <button
                type="button"
                className="cache-settings__action"
                disabled={isPending || legacyEntries === 0}
                onClick={() => void doPruneLegacy()}
                aria-label={`Prune ${legacyEntries} legacy cache files`}
                title="Remove old-format cache files that no longer appear in any per-panel view"
              >
                <span className="cache-settings__action-head">
                  <span className="cache-settings__action-title">Prune legacy files</span>
                  <IconTrash size={16} aria-hidden="true" />
                </span>
                <span className="cache-settings__action-meta">
                  {legacyEntries.toLocaleString()} unlisted file{legacyEntries === 1 ? '' : 's'}
                </span>
              </button>
              <button
                type="button"
                className="cache-settings__action cache-settings__action--danger"
                disabled={isPending || totalEntries === 0}
                onClick={() => setPendingClear('both')}
                aria-label={`Clear all ${totalEntries} cached images`}
              >
                <span className="cache-settings__action-head">
                  <span className="cache-settings__action-title">Clear everything</span>
                  <IconTrash size={16} aria-hidden="true" />
                </span>
                <span className="cache-settings__action-meta">
                  {totalEntries.toLocaleString()} files · {formatBytes(total)}
                </span>
              </button>
            </div>
          </section>

          <details
            className="cache-settings__section cache-settings__section--collapsible"
            aria-labelledby="cache-panel-heading"
          >
            <summary className="cache-settings__section-summary">
              <span
                className="cache-settings__caret"
                aria-hidden="true"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M3.5 4.75 6 7.25l2.5-2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="cache-settings__section-title">
                <span className="cache-settings__eyebrow" aria-hidden="true">
                  Inventory
                </span>
                <h2 id="cache-panel-heading" className="cache-settings__section-heading">
                  Your panel
                </h2>
              </span>
              {yourPanel.length > 0 && (
                <span className="cache-settings__section-counter" aria-live="polite">
                  {isFiltering ? (
                    <>
                      <strong className="cache-settings__section-counter-num">
                        {filteredYourPanel.length} <span>of {yourPanel.length}</span>
                      </strong>
                      <span className="cache-settings__section-counter-caption">
                        matching
                      </span>
                    </>
                  ) : (
                    <>
                      <strong className="cache-settings__section-counter-num">
                        {yourPanel.length}
                      </strong>
                      <span className="cache-settings__section-counter-caption">
                        {yourPanel.length === 1 ? 'title' : 'titles'}
                        {cachedPanelCount > 0 ? ` · ${cachedPanelCount} cached` : ''}
                      </span>
                    </>
                  )}
                </span>
              )}
            </summary>
            <div className="cache-settings__section-body">
              <div className="cache-settings__section-body-inner">
                {yourPanel.length > 0 && (
                  <div className="cache-settings__panel-toolbar">
                    <FilterSearchBar
                      value={panelQuery}
                      onChange={setPanelQuery}
                      placeholder="Filter your panel…"
                      label="Filter your panel by title or source"
                    />
                    <span className="search-filters__switch">
                      <span className="search-filters__label" id="cache-hide-uncached-label">
                        Hide uncached
                      </span>
                      <Switch
                        checked={hideUncached}
                        onChange={setHideUncached}
                        labelledBy="cache-hide-uncached-label"
                        size="sm"
                      />
                    </span>
                  </div>
                )}
                <p className="cache-settings__help">
                  One row per panel in your bookmarks. Rows still holding bytes on disk
                  show their footprint in full colour — clearing a title dims it out.
                  Click a row for the per-chapter breakdown, or clear a title's covers
                  / chapter pages in one click.
                </p>
                {yourPanel.length === 0 ? (
                  <p className="cache-settings__empty">
                    Bookmark a panel first; it'll show up here for selective clearing.
                    (Until then, opening a panel on the details page is enough for it to
                    appear as a recently-viewed row.)
                  </p>
                ) : filteredYourPanel.length === 0 ? (
                  <p className="cache-settings__empty">
                    {isFiltering ? (
                      <>
                        No panel match “{panelQuery.trim()}”. Clear the filter to see all{' '}
                        {yourPanel.length}.
                      </>
                    ) : (
                      <>
                        Every title is uncached right now. Turn off “Hide uncached”
                        above to list them anyway.
                      </>
                    )}
                  </p>
                ) : (
                  <ul className="cache-settings__panel-list" role="list">
                    {filteredYourPanel.map((entry, index) => {
                      const total = panelTotal(entry);
                      const isCached = total.entryCount > 0;
                      return (
                        <li
                          key={entry.id}
                          className={
                            'cache-settings__panel-row' +
                            (isCached ? '' : ' cache-settings__panel-row--uncached')
                          }
                          style={{ '--row-index': index } as CSSProperties}
                        >
                          <button
                            type="button"
                            className="cache-settings__panel-info"
                            onClick={() => setDrillPanel(entry)}
                            aria-label={`Open chapter breakdown for ${entry.title}`}
                          >
                            <span className="cache-settings__panel-text">
                              <span className="cache-settings__panel-title">{entry.title}</span>
                              <span className="cache-settings__panel-meta">
                                <span className="cache-settings__source-code">{entry.source}</span>
                                <span className="cache-settings__source-name">{sourceLabel(entry.source)}</span>
                              </span>
                            </span>
                            <IconChevronRight className="cache-settings__panel-chevron" size={14} />
                          </button>

                          <div className="cache-settings__panel-footprint">
                            <strong className="cache-settings__panel-bytes">
                              {formatBytes(total.totalBytes)}
                            </strong>
                            <span className="cache-settings__panel-files">
                              {isCached
                                ? `${total.entryCount.toLocaleString()} ${total.entryCount === 1 ? 'file' : 'files'}`
                                : 'Not cached'}
                            </span>
                          </div>

                          <div className="cache-settings__panel-actions">
                            <button
                              type="button"
                              className="cache-settings__row-action"
                              disabled={isPending}
                              onClick={() => doClearByTag('cover', entry.panelId, entry.title)}
                              aria-label={`Clear cached cover for ${entry.title}`}
                            >
                              <IconTrash size={12} aria-hidden="true" />
                              <span>Clear cover</span>
                            </button>
                            <button
                              type="button"
                              className="cache-settings__row-action"
                              disabled={isPending}
                              onClick={() => doClearByTag('chapter', entry.panelId, entry.title)}
                              aria-label={`Clear cached chapter pages for ${entry.title}`}
                            >
                              <IconTrash size={12} aria-hidden="true" />
                              <span>Clear chapters</span>
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </details>

        </>
      )}

      <ConfirmDialog
        open={pendingClear === 'both'}
        title="Clear all cached images?"
        message={`This deletes ${totalEntries.toLocaleString()} files (${formatBytes(total)}). The next visit re-fetches the same images from the source.`}
        confirmLabel="Clear all"
        cancelLabel="Cancel"
        danger
        onConfirm={() => {
          setPendingClear(null);
          void doClear('both');
          // After a full image-cache purge, the recently-viewed rail (local
          // storage + server-side /api/recently-viewed) has no warm image
          // evidence left to display. Clear both so it stays consistent with
          // disk truth — but keep failures best-effort so the image clear
          // never rolls back. The mutation writes the TanStack Query cache
          // (queryKeys.recentlyViewed) to [] so the home page rail updates
          // without a refetch.
          clearRecentlyViewed();
          void clearRecentlyViewedMutation.mutateAsync();
        }}
        onCancel={() => setPendingClear(null)}
      />

      {drillPanel ? (
        <PanelDrillDialog
          panel={drillPanel}
          chapterTags={chapterTags.data ?? []}
          isClearing={isPending}
          onClose={() => setDrillPanel(null)}
          onClearCover={() => {
            if (!drillPanel) return;
            void doClearByTag('cover', drillPanel.panelId, drillPanel.title);
          }}
          onClearChapter={() => {
            if (!drillPanel) return;
            void doClearByTag('chapter', drillPanel.panelId, drillPanel.title);
          }}
          onClearSelected={(chapterIds) => {
            if (!drillPanel) return;
            void clearSelectedChapters(drillPanel.title, chapterIds);
          }}
          onClearOne={(chapterId, label) => {
            // For chapter pages, the cache tag IS the chapter's global id
            // (e.g. `mk:solo-leveling.21708~c200`). The API hashes it the
            // same way as `cacheTagPrefix` on the client, so passing the
            // raw chapter id clears exactly that chapter's files.
            void doClearByTag('chapter', chapterId, label);
          }}
        />
      ) : null}
    </div>
  );
}
/**
 * localStorage key for the drill-in dialog's "Cached only" filter. A plain
 * boolean flag (not part of the reader settings) so the preference sticks
 * across dialogs without a settings migration.
 */
const DRILL_CACHED_ONLY_KEY = 'panel-cache:drill-cached-only:v1';

function loadDrillCachedOnly(): boolean {
  try {
    return window.localStorage.getItem(DRILL_CACHED_ONLY_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * localStorage key for the "Your panel" list's "Hide uncached" toggle.
 * Same plain-flag pattern as the drill dialog above. ON by default (only
 * an explicit `'0'` shows 0 B rows), so fresh installs open on the
 * titles actually holding bytes.
 */
const PANEL_HIDE_UNCACHED_KEY = 'panel-cache:hide-uncached:v1';

function loadPanelHideUncached(): boolean {
  try {
    return window.localStorage.getItem(PANEL_HIDE_UNCACHED_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * Per-panel drill-in dialog. Lists the panel's chapters with friendly
 * labels and lets the user clear individual chapters (or any selection
 * of them) from the on-disk cache without touching the rest.
 *
 * Each cached image carries an 8-hex-char provenance tag derived from
 * the chapter's global id (e.g. `mk:solo-leveling.21708~c200`). We
 * compute that same prefix on the client (`cacheTagPrefix`) so we can
 * pair every chapter on the panel's list with the live tag-size data
 * the API returns.
 */
function PanelDrillDialog({
  panel,
  chapterTags,
  isClearing,
  onClose,
  onClearCover,
  onClearChapter,
  onClearSelected,
  onClearOne,
}: {
  panel: Bookmark;
  chapterTags: ImageCacheTagSummary[];
  isClearing: boolean;
  onClose: () => void;
  onClearCover: () => void;
  onClearChapter: () => void;
  /** Clear a list of chapter global ids (the chapters the user selected). */
  onClearSelected: (chapterIds: string[]) => void;
  /** Clear a single chapter by its global id (per-row action). */
  onClearOne: (chapterId: string, label: string) => void;
}) {
  // NOTE: `panel.panelId` is the global panel id (`<source>:<nativeId>`) the
  // chapters endpoint expects. `panel.id` is the bookmark row uuid — passing
  // it here used to fail global-id validation with "Couldn't load the
  // chapter list" even when chapter pages were cached on disk.
  const chaptersQuery = useChapters(panel.panelId);
  // Offline fallback sources: when the live chapter list can't load (source
  // down + nothing in the metadata cache yet), we can still list the
  // chapters the user actually touched — progress rows, chapter bookmarks,
  // and the in-memory reader cache — joined against the on-disk tag sizes
  // so only chapters with real files show up.
  const progressQuery = useProgressForPanel(panel.panelId);
  const chapterBookmarksQuery = useChapterBookmarks(panel.panelId);
  const cachedChapterIds = useCachedChapterIds();

  // Build a tag-prefix → tag-summary lookup once per render so we can
  // decorate each chapter with its current cache size, and so we can
  // figure out which cached tags don't belong to any chapter.
  const tagByPrefix = useMemo(() => {
    const m = new Map<string, ImageCacheTagSummary>();
    for (const t of chapterTags) m.set(t.tag, t);
    return m;
  }, [chapterTags]);

  // Decoded chapter rows: take every chapter the API knows about and
  // pair it with its current cache size. Sorted ascending by chapter
  // number when known (matches the panel-details page convention of
  // oldest-first for ascending chapter numbers).
  const chapterRows = useMemo(() => {
    const chapters = chaptersQuery.data ?? [];
    return chapters.map((ch: Chapter) => {
      const tag = cacheTagPrefix(ch.id);
      const cached = tagByPrefix.get(tag) ?? null;
      return { chapter: ch, tag, cached };
    });
  }, [chaptersQuery.data, tagByPrefix]);

  // Fallback rows for when the live chapter list can't load (source down
  // and nothing in the metadata cache yet): rebuild the touched chapters
  // from reading progress, chapter bookmarks, and the in-memory reader
  // cache, then keep only the ones with real files on disk. This is why
  // a panel with downloaded pages still shows per-chapter rows instead of
  // a dead-end "Couldn't load the chapter list".
  const fallbackRows = useMemo(() => {
    if (!chaptersQuery.isError) return [];
    const labels = new Map<string, string>();
    for (const p of progressQuery.data ?? []) {
      if (p.chapterId && !labels.has(p.chapterId)) {
        labels.set(p.chapterId, p.chapterTitle ?? p.chapterId);
      }
    }
    for (const b of chapterBookmarksQuery.data ?? []) {
      if (b.chapterId && !labels.has(b.chapterId)) labels.set(b.chapterId, b.chapterId);
    }
    const prefix = `${panel.panelId}~`;
    for (const id of cachedChapterIds) {
      if (id.startsWith(prefix) && !labels.has(id)) labels.set(id, id);
    }
    const rows: { chapter: Chapter; tag: string; cached: ImageCacheTagSummary | null }[] = [];
    for (const [chapterId, label] of labels) {
      const tag = cacheTagPrefix(chapterId);
      const cached = tagByPrefix.get(tag) ?? null;
      if (!cached) continue;
      rows.push({
        chapter: {
          id: chapterId,
          panelId: panel.panelId,
          source: panel.source,
          title: label,
          chapterNumber: null,
          sourceUrl: '',
          publishedAt: null,
        },
        tag,
        cached,
      });
    }
    rows.sort((a, b) => a.chapter.id.localeCompare(b.chapter.id));
    return rows;
  }, [
    chaptersQuery.isError,
    progressQuery.data,
    chapterBookmarksQuery.data,
    cachedChapterIds,
    tagByPrefix,
    panel.panelId,
    panel.source,
  ]);

  // Selection state, keyed by tag hash (the same value we send to the
  // API). Tag hashes are unique within a panel, so selection survives
  // re-sorts and the polling hook pushing in fresh data.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // "Cached only" filter — hides the uncached rows so a long chapter index
  // collapses to just the chapters holding bytes on disk. Persisted to
  // localStorage (best-effort) so it sticks across dialogs.
  const [cachedOnly, setCachedOnly] = useState<boolean>(loadDrillCachedOnly);
  useEffect(() => {
    try {
      window.localStorage.setItem(DRILL_CACHED_ONLY_KEY, cachedOnly ? '1' : '0');
    } catch {
      /* best-effort — filtering still works for this session */
    }
  }, [cachedOnly]);

  const showChaptersLoading =
    chaptersQuery.isLoading && chapterRows.length === 0;
  const showChaptersError =
    !chaptersQuery.isLoading && chaptersQuery.isError && chapterRows.length === 0;
  // When the full list fails but we recovered cached rows from local
  // history, show those instead of the dead-end error.
  const showFallbackRows = showChaptersError && fallbackRows.length > 0;
  // Rows actually rendered: the live list, or the fallback when live fails.
  const displayRows = showFallbackRows ? fallbackRows : chapterRows;

  const visibleCached = displayRows.filter((r) => r.cached !== null);
  const visibleCachedTags = visibleCached.map((r) => r.tag);
  const allCachedSelected =
    visibleCachedTags.length > 0 && visibleCachedTags.every((h) => selected.has(h));
  const hasAnyCached = visibleCached.length > 0;
  // Rows actually painted: the full list, or just the cached ones when the
  // filter is on. Selection ("select all", footer) keeps operating on every
  // cached chapter, so toggling the filter never loses a ticked row.
  const visibleRows = cachedOnly ? visibleCached : displayRows;

  function toggleVisibleSelection() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allCachedSelected) {
        for (const h of visibleCachedTags) next.delete(h);
      } else {
        for (const h of visibleCachedTags) next.add(h);
      }
      return next;
    });
  }

  function toggleRow(hash: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }

  function handleClearSelected() {
    if (selected.size === 0) return;
    // The API takes raw chapter ids, not the 8-hex hashes the checkboxes
    // are keyed by — resolve first (see chapterIdsForSelectedTags).
    const ids = chapterIdsForSelectedTags(displayRows, selected);
    setSelected(new Set());
    if (ids.length === 0) return;
    onClearSelected(ids);
  }

  // Sum the size of currently-selected tags so the footer shows a
  // meaningful "X MB across N chapters" line before the user clicks.
  const selectedTotalBytes = useMemo(() => {
    let total = 0;
    for (const hash of selected) total += tagByPrefix.get(hash)?.totalBytes ?? 0;
    return total;
  }, [selected, tagByPrefix]);

  return (
    <div
      className="cache-settings__modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="drill-title"
      onClick={onClose}
    >
      <div className="cache-settings__modal" onClick={(e) => e.stopPropagation()}>
        <header className="cache-settings__modal-head">
          <div>
            <h2 id="drill-title" className="cache-settings__modal-title">{panel.title}</h2>
            <p className="cache-settings__modal-subtitle">
              <span className="cache-settings__source-code">{panel.source}</span>
              {sourceLabel(panel.source)} · {panel.panelId}
            </p>
          </div>
          <div className="cache-settings__modal-head-actions">
            <Link
              to={`/panel/${encodeURIComponent(panel.panelId)}`}
              target="_blank"
              rel="noreferrer"
              className="cache-settings__modal-close"
              aria-label={`Open ${panel.title} details in new tab`}
              title="Open details in new tab"
            >
              <IconExternal size={18} />
            </Link>
            <button
              type="button"
              className="cache-settings__modal-close"
              onClick={onClose}
              aria-label="Close dialog"
            >
              <IconX size={18} />
            </button>
          </div>
        </header>

        <div className="cache-settings__modal-body">
          <div className="cache-settings__modal-actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={onClearCover}>
              Clear cover only
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onClearChapter}>
              Clear all chapter pages
            </button>
          </div>

          {showChaptersLoading ? (
            <p className="cache-settings__empty">Loading chapter list…</p>
          ) : showChaptersError && !showFallbackRows ? (
            <p className="cache-settings__empty">
              Couldn't load the chapter list — you can still clear everything above.
            </p>
          ) : null}

          {!showChaptersLoading && (!showChaptersError || showFallbackRows) ? (
            <>
              {showFallbackRows ? (
                <p className="cache-settings__help">
                  The live chapter list couldn't be reached, so this shows the{' '}
                  {fallbackRows.length} cached{' '}
                  {fallbackRows.length === 1 ? 'chapter' : 'chapters'} from your
                  reading history instead. Clearing here removes the on-disk
                  pages; the full list returns once the source is reachable.
                </p>
              ) : (
                <p className="cache-settings__help">
                  Each row is one chapter. The cache badge shows how much space it
                  currently uses; tick the cached chapters you want to remove, or
                  click the trash icon to clear a single chapter. The rest of the
                  panel's cache is left untouched.
                </p>
              )}

              <ul className="cache-settings__tag-list" role="list">
                {displayRows.length > 0 ? (
                  <li className="cache-settings__list-filter">
                    <label className="cache-settings__tag-checkbox">
                      <input
                        type="checkbox"
                        checked={cachedOnly}
                        onChange={(e) => setCachedOnly(e.target.checked)}
                        disabled={!hasAnyCached}
                        aria-label={
                          cachedOnly
                            ? 'Show all chapters'
                            : `Show only the ${visibleCached.length} cached ${visibleCached.length === 1 ? 'chapter' : 'chapters'}`
                        }
                      />
                      <span className="cache-settings__tag-select-all">Cached only</span>
                    </label>
                    <span className="cache-settings__action-meta">
                      {cachedOnly
                        ? `${visibleRows.length} of ${displayRows.length}`
                        : `${visibleCached.length} cached`}
                    </span>
                  </li>
                ) : null}
                <li className="cache-settings__tag-row cache-settings__tag-row--head">
                  <label className="cache-settings__tag-checkbox">
                    <input
                      type="checkbox"
                      checked={allCachedSelected}
                      onChange={toggleVisibleSelection}
                      disabled={isClearing || visibleCached.length === 0}
                      aria-label={
                        allCachedSelected
                          ? 'Deselect all cached chapters'
                          : 'Select all cached chapters'
                      }
                    />
                    <span className="cache-settings__tag-select-all">All cached chapters</span>
                  </label>
                  <span className="cache-settings__action-meta">cached · size</span>
                </li>

                {visibleRows.length === 0 ? (
                  <li className="cache-settings__empty">
                    {cachedOnly && displayRows.length > 0 ? (
                      <>
                        No cached chapters in this view. Turn off “Cached only”
                        to see the full chapter index.
                      </>
                    ) : (
                      <>
                        No chapters were returned for this panel yet. Open a chapter
                        on the reader and it'll show up here.
                      </>
                    )}
                  </li>
                ) : null}

                {visibleRows.map((row) => {
                  const cached = row.cached;
                  const isSelected = cached ? selected.has(row.tag) : false;
                  const label = chapterLabel(row.chapter.chapterNumber, row.chapter.title);
                  return (
                    <li
                      key={row.chapter.id}
                      className={
                        'cache-settings__tag-row' +
                        (isSelected ? ' cache-settings__tag-row--selected' : '') +
                        (cached ? '' : ' cache-settings__tag-row--uncached')
                      }
                    >
                      <label
                        className="cache-settings__tag-checkbox"
                        title={cached ? `Cache tag ${row.tag}` : 'Not currently cached'}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleRow(row.tag)}
                          disabled={isClearing || !cached}
                          aria-label={
                            cached
                              ? `Select ${label} (${cached.entryCount} files, ${formatBytes(cached.totalBytes)})`
                              : `${label} is not cached`
                          }
                        />
                        <span className="cache-settings__chapter-row">
                          <span className="cache-settings__chapter-label">{label}</span>
                          {cached ? (
                            <span className="cache-settings__chapter-meta">
                              {cached.entryCount.toLocaleString()}{' '}
                              {cached.entryCount === 1 ? 'file' : 'files'}
                              {' · '}
                              {formatBytes(cached.totalBytes)}
                            </span>
                          ) : (
                            <span className="cache-settings__chapter-meta cache-settings__chapter-meta--muted">
                              Not cached
                            </span>
                          )}
                        </span>
                      </label>
                      {cached ? (
                        <button
                          type="button"
                          className="cache-settings__row-clear"
                          onClick={() => onClearOne(row.chapter.id, label)}
                          disabled={isClearing}
                          aria-label={`Clear cached pages for ${label}`}
                          title={`Clear cached pages for ${label}`}
                        >
                          <IconTrash size={14} aria-hidden="true" />
                        </button>
                      ) : (
                        <span
                          className="cache-settings__row-clear cache-settings__row-clear--placeholder"
                          aria-hidden="true"
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}

          {!hasAnyCached && !cachedOnly && !showChaptersLoading && !showChaptersError ? (
            <p className="cache-settings__empty">
              No chapter pages are cached for this panel yet. Open a chapter and
              it'll show up here.
            </p>
          ) : null}
        </div>

        {hasAnyCached ? (
          <footer className="cache-settings__modal-foot">
            <div className="cache-settings__modal-foot-summary">
              <strong>{selected.size}</strong>
              <span>
                {selected.size === 1 ? 'chapter' : 'chapters'} selected
                {selected.size > 0 ? ` · ${formatBytes(selectedTotalBytes)}` : ''}
              </span>
            </div>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={handleClearSelected}
              disabled={isClearing || selected.size === 0}
            >
              {isClearing ? 'Clearing…' : `Clear selected (${selected.size})`}
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Project a `RecentlyViewedEntry` (from localStorage) into the
 * `Bookmark` shape the rest of this page consumes. The fallback only
 * fires when the user has no bookmarks yet, so the row can still be
 * cleared from cache. The synthetic `id` keeps the database happy
 * (it's never sent to the API — only `panelId`/`title`/`source` are
 * used downstream), and `createdAt`/`updatedAt` default to the
 * `viewedAt` timestamp so any future sort works.
 */
function toBookmarkFallback(entry: RecentlyViewedEntry): Bookmark {
  return {
    // Bookmark row id (unused for cache clearing — included only to
    // satisfy the Bookmark shape; do not POST this back to the API).
    id: `local-${entry.id}`,
    panelId: entry.id,
    title: entry.title,
    coverUrl: entry.coverUrl,
    source: entry.source,
    sourceUrl: entry.sourceUrl ?? '',
    createdAt: entry.viewedAt,
    updatedAt: entry.viewedAt,
    latestChapter: entry.latestChapter ?? null,
  };
}