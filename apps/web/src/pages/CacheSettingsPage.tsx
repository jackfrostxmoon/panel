import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
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
  useFlushMemory,
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

/**
 * Render window into the Your-panel list. Filter/sort run on the full
 * array, but only this many rows are mounted — a 500-title library used
 * to mount every row (and reconcile all of them on each input focus),
 * which is what made every input on the page lag for seconds.
 */
const PANEL_PAGE_SIZE = 50;

/**
 * Isolated number rows. Each owns its draft text so keystrokes re-render
 * only the row — previously the drafts lived in the page component, so
 * every keystroke re-rendered the whole 1600-line page (bookmark list,
 * per-row hashes, sort) and typing lagged for seconds. Server sync skips
 * while the field is focused so background refetches never clobber typing.
 */
const CacheLimitRow = memo(function CacheLimitRow({
  serverText,
  disabled,
  saving,
  hasCustom,
  onSave,
  onClear,
}: {
  serverText: string;
  disabled: boolean;
  saving: boolean;
  hasCustom: boolean;
  onSave: (text: string) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? serverText;
  useEffect(() => {
    if (document.activeElement?.id !== 'cache-limit-gb') setDraft(null);
  }, [serverText]);
  return (
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
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        disabled={disabled}
        aria-describedby="cache-limit-mode"
      />
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => onSave(shown)}
        disabled={disabled}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      {hasCustom && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onClear}
          disabled={disabled}
        >
          Use automatic
        </button>
      )}
    </div>
  );
});

const MemoryThresholdRow = memo(function MemoryThresholdRow({
  serverMb,
  saving,
  onSave,
}: {
  serverMb: number;
  saving: boolean;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(serverMb);
  useEffect(() => {
    if (document.activeElement?.id !== 'memory-threshold-mb') setDraft(null);
  }, [serverMb]);
  return (
    <>
      <label htmlFor="memory-threshold-mb" className="search-filters__label">
        Memory relief threshold
      </label>
      <input
        id="memory-threshold-mb"
        type="number"
        min={20}
        max={20000}
        step={20}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        className="cache-settings__limit-input"
        aria-describedby="memory-threshold-meta"
      />
      <span id="memory-threshold-meta" style={{ fontSize: '0.75rem', color: '#888' }}>MB</span>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => onSave(shown)}
        disabled={saving}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </>
  );
});

const RssThresholdRow = memo(function RssThresholdRow({
  serverMb,
  saving,
  onSave,
}: {
  serverMb: number;
  saving: boolean;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(serverMb);
  useEffect(() => {
    if (document.activeElement?.id !== 'memory-rss-threshold-mb') setDraft(null);
  }, [serverMb]);
  return (
    <>
      <label htmlFor="memory-rss-threshold-mb" className="search-filters__label" style={{ marginLeft: '1rem' }}>
        RSS threshold
      </label>
      <input
        id="memory-rss-threshold-mb"
        type="number"
        min={128}
        max={20000}
        step={64}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        className="cache-settings__limit-input"
        aria-describedby="memory-rss-threshold-meta"
      />
      <span id="memory-rss-threshold-meta" style={{ fontSize: '0.75rem', color: '#888' }}>MB</span>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => onSave(shown)}
        disabled={saving}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </>
  );
});

/**
 * One Your-panel row. Memoized so parent renders caused by unrelated
 * state (input focus, threshold drafts, stats polls) skip reconciling
 * every row's buttons — previously each focus re-rendered all rows.
 */
const PanelRow = memo(function PanelRow({
  entry,
  total,
  index,
  isPending,
  onDrill,
  onClearCover,
  onClearChapter,
}: {
  entry: Bookmark;
  total: ImageCacheTagSummary;
  index: number;
  isPending: boolean;
  onDrill: (entry: Bookmark) => void;
  onClearCover: (entry: Bookmark) => void;
  onClearChapter: (entry: Bookmark) => void;
}) {
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
        onClick={() => onDrill(entry)}
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
            onClick={() => onClearCover(entry)}
            aria-label={`Clear cached cover for ${entry.title}`}
          >
          <IconTrash size={12} aria-hidden="true" />
          <span>Clear cover</span>
        </button>
          <button
            type="button"
            className="cache-settings__row-action"
            disabled={isPending}
            onClick={() => onClearChapter(entry)}
            aria-label={`Clear cached chapter pages for ${entry.title}`}
          >
          <IconTrash size={12} aria-hidden="true" />
          <span>Clear chapters</span>
        </button>
      </div>
    </li>
  );
});

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
    saveCacheSettings.mutate({ liveRefresh: next, autoMemoryRelief, autoMemoryReliefThresholdMb: reliefThresholdMb, autoMemoryReliefRssThresholdMb: reliefRssThresholdMb, performanceMode });
    if (next) refetchAllRef.current();
  }

  const autoMemoryRelief =
    saveCacheSettings.isPending && saveCacheSettings.variables
      ? (saveCacheSettings.variables.autoMemoryRelief ?? false)
      : (cacheSettingsQuery.data?.autoMemoryRelief ?? false);

  function handleAutoMemoryReliefToggle(next: boolean) {
    if (next === autoMemoryRelief) return;
    saveCacheSettings.mutate({ liveRefresh, autoMemoryRelief: next, autoMemoryReliefThresholdMb: reliefThresholdMb, autoMemoryReliefRssThresholdMb: reliefRssThresholdMb, performanceMode });
  }

  /**
   * Performance mode — max-throughput profile for the whole app (max
   * image-proxy concurrency, enlarged in-memory cache + longer TTLs, no
   * automatic memory relief, max download width with no pacing). It lifts
   * the app's own throttles; it canNOT pin the OS CPU/RAM/NIC — no web app
   * can. Pending-wins like the other toggles so the switch flips instantly.
   */
  const performanceMode =
    saveCacheSettings.isPending && saveCacheSettings.variables
      ? (saveCacheSettings.variables.performanceMode ?? false)
      : (cacheSettingsQuery.data?.performanceMode ?? false);
  /** Confirm dialog before enabling (it intentionally undoes the low-memory protections). */
  const [confirmPerf, setConfirmPerf] = useState(false);

  function handlePerformanceToggle(next: boolean) {
    if (next === performanceMode) return;
    if (!next) {
      saveCacheSettings.mutate({ liveRefresh, autoMemoryRelief, autoMemoryReliefThresholdMb: reliefThresholdMb, autoMemoryReliefRssThresholdMb: reliefRssThresholdMb, performanceMode: false });
      return;
    }
    setConfirmPerf(true);
  }

  function confirmEnablePerformance() {
    setConfirmPerf(false);
    saveCacheSettings.mutate({ liveRefresh, autoMemoryRelief, autoMemoryReliefThresholdMb: reliefThresholdMb, autoMemoryReliefRssThresholdMb: reliefRssThresholdMb, performanceMode: true });
  }

  const flushMemoryMutation = useFlushMemory();

  const reliefThresholdMb =
    saveCacheSettings.isPending && saveCacheSettings.variables
      ? Math.max(20, Math.round(Number(saveCacheSettings.variables.autoMemoryReliefThresholdMb || 20)))
      : Math.max(20, Math.round(Number(cacheSettingsQuery.data?.autoMemoryReliefThresholdMb || 20)));

  async function saveThreshold(text: string) {
    const mb = Math.round(Number(text) || 20);
    if (!Number.isFinite(mb) || mb < 20 || mb > 20000) {
      toast('Threshold must be between 20 MB and 20,000 MB.', 'error');
      return;
    }
    try {
      await saveCacheSettings.mutateAsync({
        liveRefresh,
        autoMemoryRelief,
        autoMemoryReliefThresholdMb: mb,
        autoMemoryReliefRssThresholdMb: reliefRssThresholdMb,
        performanceMode,
      });
      toast(`Memory relief threshold set to ${mb} MB.`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not save threshold.', 'error');
    }
  }

  const reliefRssThresholdMb =
    saveCacheSettings.isPending && saveCacheSettings.variables
      ? Math.max(128, Math.round(Number(saveCacheSettings.variables.autoMemoryReliefRssThresholdMb || 256)))
      : Math.max(128, Math.round(Number(cacheSettingsQuery.data?.autoMemoryReliefRssThresholdMb || 256)));

  async function saveRssThreshold(text: string) {
    const mb = Math.round(Number(text) || 256);
    if (!Number.isFinite(mb) || mb < 128 || mb > 20000) {
      toast('RSS threshold must be between 128 MB and 20,000 MB.', 'error');
      return;
    }
    try {
      await saveCacheSettings.mutateAsync({
        liveRefresh,
        autoMemoryRelief,
        autoMemoryReliefThresholdMb: reliefThresholdMb,
        autoMemoryReliefRssThresholdMb: mb,
        performanceMode,
      });
      toast(`Memory relief RSS threshold set to ${mb} MB.`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not save RSS threshold.', 'error');
    }
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
  /** Sort order for the "Your panel" list. `recent` keeps the server's
      "recently updated first" order; the size options sort by each row's
      total cached footprint. */
  const [panelSort, setPanelSort] = useState<PanelSort>(loadPanelSort);

  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_SORT_KEY, panelSort);
    } catch {
      // Storage blocked — the sort just won't survive a reload.
    }
  }, [panelSort]);

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
  const serverLimitGbText = String(
    Math.round(((customLimitBytes ?? computedLimitBytes) / 1024 ** 3) * 100) / 100,
  );

  async function doSaveLimit(text: string) {
    const gb = Number.parseFloat(text);
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
      toast(`Cache size limit set to ${formatBytes(bytes)}.`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not update the cache size limit.', 'error');
    }
  }

  async function doClearLimit() {
    try {
      await setLimitMutation.mutateAsync(null);
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

  /**
   * Per-panel footprint keyed by panel id (not tag hash): hashed ONCE per
   * size payload instead of once per row per render (plus per sort
   * comparison). `panelTotal` below is then a cheap lookup, so focusing or
   * typing in any input no longer re-pays hundreds of synchronous hashes.
   */
  const panelSizeById = useMemo(() => {
    const m = new Map<string, ImageCacheTagSummary>();
    for (const entry of yourPanel) {
      const tag = cacheTagPrefix(entry.panelId);
      const hit = panelSizeByTag.get(tag);
      m.set(
        entry.panelId,
        hit ?? { tag, entryCount: 0, totalBytes: 0 },
      );
    }
    return m;
  }, [yourPanel, panelSizeByTag]);

  /** Look up a row's total cached footprint (cover + chapter pages). */
  const panelTotal = (entry: Bookmark): ImageCacheTagSummary => {
    const cached = panelSizeById.get(entry.panelId);
    if (cached) return cached;
    const tag = cacheTagPrefix(entry.panelId);
    return { tag, entryCount: 0, totalBytes: 0 };
  };

  /**
   * Deferred filter text: the input stays controlled by `panelQuery` (so
   * focus/typing is instant) while the heavy list filters/sorts against
   * the deferred value a beat later instead of blocking each keystroke.
   */
  const deferredPanelQuery = useDeferredValue(panelQuery);

  /** Filtered + sorted view of `yourPanel` — matches the trimmed query against the
      title, the source code (mk/nk/rk/…) and the friendly source label
      ("MangaKatana") so a user can type either. Empty query = passthrough.
      On top, the Hide-uncached toggle drops 0 B rows — but only once the
      size data has arrived, so rows never vanish-then-pop-back while the
      sizes are still loading. Finally the size sorts order by each row's
      total cached footprint (stable — ties keep the server's recent-first
      order); `recent` skips the sort entirely. */
  const filteredYourPanel = useMemo<Bookmark[]>(() => {
    const needle = deferredPanelQuery.trim().toLowerCase();
    const textFiltered = !needle
      ? yourPanel
      : yourPanel.filter((entry) => {
          const title = entry.title.toLowerCase();
          const code = entry.source.toLowerCase();
          const label = sourceLabel(entry.source).toLowerCase();
          return title.includes(needle) || code.includes(needle) || label.includes(needle);
        });
    const visible =
      !hideUncached || tagsSizeQuery.data == null
        ? textFiltered
        : textFiltered.filter(
            (entry) => (panelSizeById.get(entry.panelId)?.entryCount ?? 0) > 0,
          );
    if (panelSort === 'recent') return visible;
    return [...visible].sort((a, b) => {
      const diff =
        (panelSizeById.get(a.panelId)?.totalBytes ?? 0) -
        (panelSizeById.get(b.panelId)?.totalBytes ?? 0);
      return panelSort === 'largest' ? -diff : diff;
    });
  }, [yourPanel, deferredPanelQuery, hideUncached, panelSort, tagsSizeQuery.data, panelSizeById]);

  /** True only when the filter is hiding rows — drives the result-count
      chip and the "no matches" empty state. */
  const isFiltering = deferredPanelQuery.trim().length > 0;

  /** Titles with at least one cached file — the summary's "n cached" tag.
      Mirrors the ghosted/uncached rows below. */
  const cachedPanelCount = useMemo(
    () => {
      let count = 0;
      for (const entry of yourPanel) {
        if ((panelSizeById.get(entry.panelId)?.entryCount ?? 0) > 0) count += 1;
      }
      return count;
    },
    [yourPanel, panelSizeById],
  );

  /**
   * Render window into `filteredYourPanel` (same marker pattern as the
   * bookmarks page): only these rows are mounted, the sentinel appends
   * more on scroll. Fresh filter/sort/hide identity rewinds to the first
   * window; data refetches alone don't (that would yank scroll position).
   */
  const [panelVisibleCount, setPanelVisibleCount] = useState(PANEL_PAGE_SIZE);
  const panelSentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setPanelVisibleCount(PANEL_PAGE_SIZE);
  }, [deferredPanelQuery, hideUncached, panelSort, yourPanel.length]);

  const renderedYourPanel = useMemo(
    () => filteredYourPanel.slice(0, panelVisibleCount),
    [filteredYourPanel, panelVisibleCount],
  );
  const hasMorePanels = panelVisibleCount < filteredYourPanel.length;

  useEffect(() => {
    if (!hasMorePanels || renderedYourPanel.length === 0) return;
    const sentinel = panelSentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setPanelVisibleCount((count) =>
            Math.min(count + PANEL_PAGE_SIZE, filteredYourPanel.length),
          );
        }
      },
      { rootMargin: '600px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMorePanels, renderedYourPanel.length, filteredYourPanel.length]);

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

  async function doFlushMemory() {
    try {
      const result = await flushMemoryMutation.mutateAsync();
      const freed = result.memoryBeforeBytes && result.memoryAfterBytes
        ? result.memoryBeforeBytes - result.memoryAfterBytes
        : 0;
      toast(
        `Memory flushed (${formatBytes(result.memoryBeforeBytes ?? 0)} → ${formatBytes(result.memoryAfterBytes ?? 0)}). ${freed > 0 ? `Freed ~${formatBytes(Math.abs(freed))}.` : ''}`,
        'success',
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not flush server memory.', 'error');
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
   * Stable row callbacks so `PanelRow` memo actually skips rows whose
   * entry/total didn't change — inline closures would be new every render
   * and defeat the memo, re-reconciling every row on each keystroke/focus.
   */
  const handleDrillRow = useCallback((entry: Bookmark) => setDrillPanel(entry), []);
  const handleClearCoverRow = useCallback(
    (entry: Bookmark) => {
      void doClearByTag('cover', entry.panelId, entry.title);
    },
    // doClearByTag is re-created per render but only reads the stable
    // mutation + toast; depend on those directly for a stable identity.
    // oxlint-disable-next-line react/exhaustive-deps
    [clearByTagMutation],
  );
  const handleClearChapterRow = useCallback(
    (entry: Bookmark) => {
      void doClearByTag('chapter', entry.panelId, entry.title);
    },
    // oxlint-disable-next-line react/exhaustive-deps
    [clearByTagMutation],
  );

  /**
   * Clear a hand-picked list of chapter global ids (the rows the user
   * ticked in the drill-in dialog, resolved from their tag hashes — the
   * API only accepts raw provenance strings, not 8-hex hashes). The API
   * has no batch endpoint, so we clear in parallel with limited
   * concurrency and aggregate the totals. Failures are logged and
   * reported but never stop the remaining chapters.
   */
  async function clearSelectedChapters(panelTitle: string, chapterIds: string[]) {
    if (chapterIds.length === 0) return;
    let totalFiles = 0;
    let totalBytes = 0;
    let failed = 0;
    const CONCURRENCY = 6;
    for (let i = 0; i < chapterIds.length; i += CONCURRENCY) {
      const chunk = chapterIds.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map((tag) => clearByTagMutation.mutateAsync({ what: 'chapter', tag })),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          totalFiles += result.value.entryCount;
          totalBytes += result.value.totalBytes;
        } else {
          failed += 1;
          console.error('clearSelectedChapters partial failure:', result.reason);
        }
      }
    }
    if (failed > 0) {
      toast(
        `Cleared ${totalFiles.toLocaleString()} chapters of ${panelTitle} (${formatBytes(totalBytes)}) before an error stopped the batch.`,
        'error',
      );
      return;
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
      </header>

      <section className="cache-settings__section" aria-labelledby="cache-preferences-heading">
        <header className="section-header">
          <h2 id="cache-preferences-heading" className="section-title">Preferences</h2>
        </header>
        <p className="cache-settings__help">
          Control live refresh, automatic memory relief thresholds, and performance mode.
        </p>

        <div className="cache-settings__limit-row">
          <span className="search-filters__label" id="cache-live-refresh-label">Live refresh</span>
          <Switch
            checked={liveRefresh}
            onChange={handleLiveToggle}
            labelledBy="cache-live-refresh-label"
            size="sm"
          />
          <span className="search-filters__label" id="cache-auto-memory-label" style={{ marginLeft: '1rem' }}>
            Auto memory relief
          </span>
          <Switch
            checked={autoMemoryRelief}
            onChange={handleAutoMemoryReliefToggle}
            labelledBy="cache-auto-memory-label"
            size="sm"
            disabled={performanceMode}
          />
          <span className="search-filters__label" id="cache-performance-mode-label" style={{ marginLeft: '1rem' }}>Performance mode</span>
          <Switch
            checked={performanceMode}
            onChange={handlePerformanceToggle}
            labelledBy="cache-performance-mode-label"
            size="sm"
          />
        </div>
        <p className="cache-settings__help">
          Performance mode runs every page at max throughput: 32 concurrent image fetches
          (instead of 2) streamed in-process (no per-miss child spawn), a 1000-entry /
          256&nbsp;MB hot cache with 4× longer lifetimes, longer source timeouts with
          snappier retries, no automatic memory relief, 16-pages-at-once downloads with
          no backoff/pacing, relaxed cache eviction, and a forced reader (parallel
          loading, 50-page preload, data-saver off). It lifts the app&apos;s own
          throttles — it cannot force the OS to spend more CPU, RAM, or network
          bandwidth than the machine has. Sources may rate-limit
          you (HTTP 429) under full load; use &ldquo;Flush memory&rdquo; below if RAM climbs.
        </p>

        {autoMemoryRelief && (
          <div className="cache-settings__limit-row">
            <MemoryThresholdRow
              serverMb={reliefThresholdMb}
              saving={saveCacheSettings.isPending}
              onSave={(text) => void saveThreshold(text)}
            />
            <RssThresholdRow
              serverMb={reliefRssThresholdMb}
              saving={saveCacheSettings.isPending}
              onSave={(text) => void saveRssThreshold(text)}
            />
          </div>
        )}

        <p className="cache-settings__limit-meta" id="cache-preferences-meta">
          {liveRefresh ? 'Live refresh is enabled. Stats and inventory update automatically.' : 'Live refresh is off; stats refresh on page load only.'}{autoMemoryRelief && !performanceMode ? ' Auto memory relief is active.' : ''}{performanceMode ? ' Performance mode is on: max throughput, no auto memory relief.' : ''}
        </p>
      </section>

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
            <CacheLimitRow
              serverText={serverLimitGbText}
              disabled={limitQuery.isPending || setLimitMutation.isPending}
              saving={setLimitMutation.isPending}
              hasCustom={customLimitBytes !== null}
              onSave={(text) => void doSaveLimit(text)}
              onClear={() => void doClearLimit()}
            />
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
              <button
                type="button"
                className="cache-settings__action"
                disabled={flushMemoryMutation.isPending}
                onClick={() => void doFlushMemory()}
                aria-label="Flush server memory (in-memory cache and image index)"
                title="Reset RAM usage by clearing the server's in-memory caches. Cached images on disk are kept."
              >
                <span className="cache-settings__action-head">
                  <span className="cache-settings__action-title">Flush memory</span>
                  <IconTrash size={16} aria-hidden="true" />
                </span>
                <span className="cache-settings__action-meta">
                  {flushMemoryMutation.isPending ? 'Flushing…' : 'Free server RAM'}
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
                    <div className="cache-settings__panel-controls">
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
                      <label className="cache-settings__sort">
                        <span className="search-filters__label" id="cache-panel-sort-label">
                          Sort
                        </span>
                        <select
                          className="cache-settings__sort-select"
                          aria-labelledby="cache-panel-sort-label"
                          value={panelSort}
                          onChange={(e) => setPanelSort(e.target.value as PanelSort)}
                        >
                          <option value="recent">Recently updated</option>
                          <option value="largest">Largest first</option>
                          <option value="smallest">Smallest first</option>
                        </select>
                      </label>
                    </div>
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
                  <>
                    <ul className="cache-settings__panel-list" role="list">
                      {renderedYourPanel.map((entry, index) => (
                        <PanelRow
                          key={entry.id}
                          entry={entry}
                          total={panelTotal(entry)}
                          index={index}
                          isPending={isPending}
                          onDrill={handleDrillRow}
                          onClearCover={handleClearCoverRow}
                          onClearChapter={handleClearChapterRow}
                        />
                      ))}
                    </ul>
                    {/* Scroll window: pulls the next PANEL_PAGE_SIZE rows
                        into view (same marker pattern as the bookmarks
                        page). The button covers no-observer / keyboard
                        users. */}
                    <div ref={panelSentinelRef} aria-hidden="true" />
                    {hasMorePanels && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() =>
                          setPanelVisibleCount((count) =>
                            Math.min(count + PANEL_PAGE_SIZE, filteredYourPanel.length),
                          )
                        }
                      >
                        Show {(filteredYourPanel.length - panelVisibleCount).toLocaleString()} more (
                        {renderedYourPanel.length.toLocaleString()} of{' '}
                        {filteredYourPanel.length.toLocaleString()})
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </details>

        </>
      )}

      <ConfirmDialog
        open={confirmPerf}
        title="Enable performance mode?"
        message="Every page runs at max throughput (32 image fetches at once, large hot cache, longer timeouts with faster retries, 16-pages-at-once downloads with no pacing, forced parallel reader) and automatic memory relief stands down. This raises RAM use and upstream load — sources may rate-limit you. Your custom concurrency setting is kept and restored when you switch back off."
        confirmLabel="Enable"
        cancelLabel="Cancel"
        onConfirm={() => void confirmEnablePerformance()}
        onCancel={() => setConfirmPerf(false)}
      />

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
 * Sort order for the "Your panel" list. `recent` is the server's
 * "recently updated first" order; the size options sort by each row's
 * total cached footprint.
 */
type PanelSort = 'recent' | 'largest' | 'smallest';

/**
 * localStorage key for the "Your panel" list's sort order. Same plain-flag
 * pattern as the drill dialog above. Defaults to `recent` (any stored
 * value outside the three options falls back to it).
 */
const PANEL_SORT_KEY = 'panel-cache:panel-sort:v1';

function loadPanelSort(): PanelSort {
  try {
    const raw = window.localStorage.getItem(PANEL_SORT_KEY);
    return raw === 'largest' || raw === 'smallest' ? raw : 'recent';
  } catch {
    return 'recent';
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
