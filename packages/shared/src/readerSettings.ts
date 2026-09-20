export type ReadingMode = 'vertical' | 'paged' | 'gallery';
export type ReadingDirection = 'ltr' | 'rtl';
export type ReaderBackground = 'dark' | 'light' | 'high-contrast';
export type ScrollSpeed = 'slow' | 'normal' | 'fast';
export type SpreadOddPolicy = 'duplicate' | 'blank' | 'single';
export type ImageLoadMode = 'parallel' | 'sequential';
export type PreloadAhead = 1 | 3 | 5;

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
  autoLandscapeSingle: boolean;
  dataSaver: boolean;
  glidePreset: 'instant' | 'quick' | 'normal' | 'smooth';
  showScrollbar: boolean;
  defaultFolderId?: string | null;
}

/**
 * Latest page preferences. Persisted server-side as a JSON file
 * (`data/display/latest.json`) via the latest-settings endpoints.
 */
export interface LatestPageSettings {
  /** Append next pages on scroll instead of Previous/Next paging. */
  infiniteScroll: boolean;
}

/** Default: classic Previous/Next pagination. */
export const DEFAULT_LATEST_PAGE_SETTINGS: LatestPageSettings = {
  infiniteScroll: false,
};

/**
 * Search page preferences. Persisted server-side as a JSON file
 * (`data/display/search.json`) via the search-settings endpoints.
 * Independent from the latest-page toggle so each list scrolls its own way.
 */
export interface SearchPageSettings {
  /** Append next pages on scroll instead of Previous/Next paging. */
  infiniteScroll: boolean;
}

/** Default: classic Previous/Next pagination. */
export const DEFAULT_SEARCH_PAGE_SETTINGS: SearchPageSettings = {
  infiniteScroll: false,
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
