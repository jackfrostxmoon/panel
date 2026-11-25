export type ReadingMode = 'vertical' | 'paged' | 'gallery';
export type ReadingDirection = 'ltr' | 'rtl';
export type ReaderBackground = 'dark' | 'light' | 'high-contrast';
export type ScrollSpeed = 'slow' | 'normal' | 'fast';
export type SpreadOddPolicy = 'duplicate' | 'blank' | 'single';
export type ImageLoadMode = 'parallel' | 'sequential';
/** Pages pre-fetched ahead of the reader position (vertical mode). Custom 1–50. */
export type PreloadAhead = number;

export interface ReaderSettings {
  mode: ReadingMode;
  direction: ReadingDirection;
  background: ReaderBackground;
  imageWidth: number;
  imageWidthPx: number | null;
  imageHeightPx: number | null;
  /**
   * When true, the fixed pixel width/height apply. When false, the stored
   * width/height values are kept but ignored (readers fall back to the
   * automatic layout). Defaults to off for fresh setups.
   */
  pixelSizeEnabled: boolean;
  showProgressBar: boolean;
  imageGap: boolean;
  clearToolbarSpace: boolean;
  scrollSpeed: ScrollSpeed;
  /**
   * When true, plain W/S / ArrowUp/ArrowDown hold-to-smooth-scroll in
   * vertical and gallery modes at `scrollSpeed` (no Shift needed),
   * replacing the step keys.
   */
  smoothScrollKeys: boolean;
  imageLoad: ImageLoadMode;
  preloadAhead: PreloadAhead;
  imageBrightness: number;
  doublePage: boolean;
  spreadOddPolicy: SpreadOddPolicy;
  autoScrollDelayMs: number | null;
  /** Show the auto-scroll (hands-free playback) button in the reader toolbar. Hidden by default. */
  showAutoScrollButton: boolean;
  wheelPagesPerNotch: number;
  keyPagesPress: number;
  /** Paged mode only: constrain the page to the viewport height (fit-to-height). */
  fitToHeight: boolean;
  /** Vertical mode only: stretch pages to the full reader width (fit-to-width). */
  fitToWidth: boolean;
  autoLandscapeSingle: boolean;
  dataSaver: boolean;
  glidePreset: 'instant' | 'quick' | 'normal' | 'smooth';
  showScrollbar: boolean;
  defaultFolderId?: string | null;
  /** MangaKatana image-server preference (only visible for `mk` source). */
  mkImageServer?: 'default' | 'sv2' | 'sv3';
  /**
   * Manual side-by-side merges for paged mode, keyed by chapter global id
   * (`mk:x~c200`). Each entry lists the 0-based index of the first page of
   * an adjacent pair (`n` means pages `n` and `n+1` render as one spread).
   * Sorted, unique and non-overlapping; only used while double-page spread
   * mode is off. Empty/absent = no manual merges.
   */
  manualSpreads?: Record<string, number[]>;
  /**
   * Per-chapter first page of the automatic double-page spread, keyed by
   * chapter global id. 1-based page number; pages before it render solo and
   * pairing starts there. Absent = the reader's default pairing.
   */
  spreadStarts?: Record<string, number>;
}

/**
 * Card-vs-list layout for panel grids. Persisted per page server-side
 * (`data/display/<page>.json`) so the choice survives cache clears and
 * follows the user across browsers/devices — same pattern as the
 * infinite-scroll toggles below.
 */
export type CardLayout = 'cards' | 'list';

/** Default grid layout: cover cards. */
export const DEFAULT_CARD_LAYOUT: CardLayout = 'cards';

/**
 * Latest page preferences. Persisted server-side as a JSON file
 * (`data/display/latest.json`) via the latest-settings endpoints.
 */
export interface LatestPageSettings {
  /** Append next pages on scroll instead of Previous/Next paging. */
  infiniteScroll: boolean;
  /** Cover-card grid or compact list with hover cover preview. */
  cardLayout: CardLayout;
  /** Collapse the refinement filter group (status/genre selects). */
  filtersCollapsed: boolean;
  /** Show the toolbar search bar (dedicated toggle, independent of filters). */
  searchOpen: boolean;
  /**
   * When the include-genre filter has more than one pick, require a panel to
   * carry every selected genre (AND). Off = any selected genre matches (OR).
   */
  matchAllGenres: boolean;
}

/** Default: classic Previous/Next pagination, cover cards, filters collapsed. */
export const DEFAULT_LATEST_PAGE_SETTINGS: LatestPageSettings = {
  infiniteScroll: false,
  cardLayout: DEFAULT_CARD_LAYOUT,
  filtersCollapsed: true,
  searchOpen: false,
  matchAllGenres: false,
};

/**
 * Search page preferences. Persisted server-side as a JSON file
 * (`data/display/search.json`) via the search-settings endpoints.
 * Independent from the latest-page toggle so each list scrolls its own way.
 */
export interface SearchPageSettings {
  /** Append next pages on scroll instead of Previous/Next paging. */
  infiniteScroll: boolean;
  /** Cover-card grid or compact list with hover cover preview. */
  cardLayout: CardLayout;
  /** Collapse the refinement filter group (status/genre selects). */
  filtersCollapsed: boolean;
}

/** Default: classic Previous/Next pagination, cover cards, filters collapsed. */
export const DEFAULT_SEARCH_PAGE_SETTINGS: SearchPageSettings = {
  infiniteScroll: false,
  cardLayout: DEFAULT_CARD_LAYOUT,
  filtersCollapsed: true,
};

/**
 * Bookmarks page preferences. Persisted server-side as a JSON file
 * (`data/display/bookmarks.json`) via the bookmarks-settings endpoints.
 */
export interface BookmarksPageSettings {
  /** Cover-card grid or compact list with hover cover preview. */
  cardLayout: CardLayout;
  /** Collapse the refinement filter group (status/genre/tag selects). */
  filtersCollapsed: boolean;
  /** Show the toolbar search bar (dedicated toggle, independent of filters). */
  searchOpen: boolean;
  /**
   * Arrange the shelf by the latest update (most recently released chapter
   * bubbles to the top, matching the source's latest-updates feed when a
   * single source pill is selected). `false` = order by when each bookmark
   * was added (newest first), ignoring chapter-cache timestamps.
   */
  sortByLatestUpdate: boolean;
  /**
   * Auto-open the "Choose folders" dialog after a new bookmark is added on
   * the details page (only when there is more than one folder to pick).
   * `false` keeps the bookmark in All bookmarks without interrupting.
   */
  autoOpenFolderPicker: boolean;
  /**
   * When the include-genre filter has more than one pick, require a bookmark
   * to carry every selected genre (AND). Off = any selected genre matches (OR).
   */
  matchAllGenres: boolean;
}

/** Default: cover cards, filters collapsed, sorted by latest update, folder picker on. */
export const DEFAULT_BOOKMARKS_PAGE_SETTINGS: BookmarksPageSettings = {
  cardLayout: DEFAULT_CARD_LAYOUT,
  filtersCollapsed: true,
  searchOpen: false,
  sortByLatestUpdate: true,
  autoOpenFolderPicker: true,
  matchAllGenres: false,
};

/**
 * Cache page preferences. Persisted server-side as a JSON file
 * (`data/display/cache.json`) via the cache-settings endpoints.
 */
export interface CachePageSettings {
  /** Poll cache stats/sizes in the background instead of manual refreshes. */
  liveRefresh: boolean;
  /** When true, the server automatically flushes the in-memory TTL cache and image index when heap or RSS usage exceeds its threshold. */
  autoMemoryRelief: boolean;
  /** Heap relief threshold in MB (default 20). Only used when autoMemoryRelief is true. */
  autoMemoryReliefThresholdMb: number;
  /** RSS relief threshold in MB (default 256). Only used when autoMemoryRelief is true. */
  autoMemoryReliefRssThresholdMb: number;
  /**
   * Performance mode: lift the low-memory throttles (max image-proxy
   * concurrency, enlarged in-memory cache + longer TTLs, in-process image
   * fetches, max prefetch width with no failure/claim backoffs — user-
   * configured inter-chapter pacing is still honoured, relaxed eviction,
   * no auto memory relief, max download width) for maximum throughput at
   * the cost of higher RAM/disk churn and more upstream load. Not OS-level
   * CPU/NIC control — the app can only widen its own parallelism, not pin
   * hardware.
   */
  performanceMode: boolean;
}

/** Default: manual refresh only, no auto memory relief, 20 MB heap / 256 MB RSS thresholds, standard throughput. */
export const DEFAULT_CACHE_PAGE_SETTINGS: CachePageSettings = {
  liveRefresh: false,
  autoMemoryRelief: false,
  autoMemoryReliefThresholdMb: 20,
  autoMemoryReliefRssThresholdMb: 256,
  performanceMode: false,
};

/**
 * Details page preferences. Persisted server-side as a JSON file
 * (`data/display/details.json`) via the details-settings endpoints.
 */
export interface DetailsPageSettings {
  /** Show the heuristic "Filler" marker next to chapters on the details-page
   *  chapter list (fractional numbers / side-content keywords). */
  showFillerLabels: boolean;
}

/** Default: filler labels shown. */
export const DEFAULT_DETAILS_PAGE_SETTINGS: DetailsPageSettings = {
  showFillerLabels: true,
};

/**
 * Source display order + visibility. Persisted server-side as a JSON file
 * (`data/display/sources.json`) via the source-order endpoints.
 *
 * `order` holds source codes (e.g. "mk") in the user's preferred order.
 * Empty (the default) means the canonical built-in order. Codes the client
 * doesn't know are ignored; known codes missing from the list are appended
 * in canonical order — so a newly added source never vanishes.
 *
 * `hidden` holds source codes the user hid via the Sources page toggle.
 * Hidden sources disappear from the source pills and their cards are
 * filtered out of the home rail, latest grid, and bookmarks — display-only,
 * the source itself keeps working behind direct links. Empty (the default)
 * means every source is visible.
 */
export interface SourceOrderSettings {
  /** Source codes in user order; [] = canonical order. */
  order: string[];
  /** Hidden source codes; [] = everything visible. */
  hidden: string[];
}

/** Default: canonical built-in source order, everything visible. */
export const DEFAULT_SOURCE_ORDER_SETTINGS: SourceOrderSettings = {
  order: [],
  hidden: [],
};

/**
 * A named reader-settings snapshot. Persisted server-side as a JSON file
 * (`data/reader/styles.json`) via the reader-styles endpoints; the web
 * client keeps an in-memory copy while the settings panel is open.
 */
export interface ReaderStylePreset {
  name: string;
  settings: ReaderSettings;
  updatedAt: string;
}
