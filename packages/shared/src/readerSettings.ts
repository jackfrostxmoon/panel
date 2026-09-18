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
 * A named reader-settings snapshot. Persisted server-side as a JSON file
 * (`data/reader/styles.json`) via the reader-styles endpoints; the web
 * client keeps an in-memory copy while the settings panel is open.
 */
export interface ReaderStylePreset {
  name: string;
  settings: ReaderSettings;
  updatedAt: string;
}
