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
  showProgressBar: boolean;
  imageGap: boolean;
  clearToolbarSpace: boolean;
  scrollSpeed: ScrollSpeed;
  /**
   * When true, plain W/S / ArrowUp/ArrowDown hold-to-smooth-scroll in vertical
   * mode at `scrollSpeed` (no Shift needed), replacing the step keys.
   */
  smoothScrollKeys: boolean;
  imageLoad: ImageLoadMode;
  preloadAhead: PreloadAhead;
  imageBrightness: number;
  doublePage: boolean;
  spreadOddPolicy: SpreadOddPolicy;
  autoScrollDelayMs: number | null;
  wheelPagesPerNotch: number;
  keyPagesPress: number;
  zoomLevel: number;
  /** Paged mode only: constrain the page to the viewport height (fit-to-height). */
  fitToHeight: boolean;
  autoLandscapeSingle: boolean;
  dataSaver: boolean;
  glidePreset: 'instant' | 'quick' | 'normal' | 'smooth';
  showScrollbar: boolean;
  defaultFolderId?: string | null;
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
}

/** Default: classic Previous/Next pagination, cover cards, filters collapsed. */
export const DEFAULT_LATEST_PAGE_SETTINGS: LatestPageSettings = {
  infiniteScroll: false,
  cardLayout: DEFAULT_CARD_LAYOUT,
  filtersCollapsed: true,
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
}

/** Default: cover cards, filters collapsed. */
export const DEFAULT_BOOKMARKS_PAGE_SETTINGS: BookmarksPageSettings = {
  cardLayout: DEFAULT_CARD_LAYOUT,
  filtersCollapsed: true,
};

/**
 * Cache page preferences. Persisted server-side as a JSON file
 * (`data/display/cache.json`) via the cache-settings endpoints.
 */
export interface CachePageSettings {
  /** Poll cache stats/sizes in the background instead of manual refreshes. */
  liveRefresh: boolean;
}

/** Default: manual refresh only. */
export const DEFAULT_CACHE_PAGE_SETTINGS: CachePageSettings = {
  liveRefresh: false,
};

/**
 * Source display order. Persisted server-side as a JSON file
 * (`data/display/sources.json`) via the source-order endpoints.
 *
 * `order` holds source codes (e.g. "mk") in the user's preferred order.
 * Empty (the default) means the canonical built-in order. Codes the client
 * doesn't know are ignored; known codes missing from the list are appended
 * in canonical order — so a newly added source never vanishes.
 */
export interface SourceOrderSettings {
  /** Source codes in user order; [] = canonical order. */
  order: string[];
}

/** Default: canonical built-in source order. */
export const DEFAULT_SOURCE_ORDER_SETTINGS: SourceOrderSettings = {
  order: [],
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
