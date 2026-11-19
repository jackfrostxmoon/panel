/**
 * Reader settings — pure module (no React) so it is trivially unit-testable.
 */

export type ReadingMode = 'vertical' | 'paged' | 'gallery';
export type GlidePreset = 'instant' | 'quick' | 'normal' | 'smooth';

/** Cycling order for reading modes (matches the gallery setting ordering). */
export const READING_MODES: ReadingMode[] = ['vertical', 'paged', 'gallery'];

/**
 * Returns the next reading mode, cycling `gallery` back to `vertical`.
 * Order matches the settings panel's mode segment: vertical -> paged -> gallery.
 */
export function nextReadingMode(mode: ReadingMode): ReadingMode {
  const idx = READING_MODES.indexOf(mode);
  const next = idx >= 0 ? (idx + 1) % READING_MODES.length : 0;
  return READING_MODES[next] ?? mode;
}
export type ReadingDirection = 'ltr' | 'rtl';
export type ReaderBackground = 'dark' | 'light' | 'high-contrast';
/**
 * Image width as a percentage of the reader viewport, driven by a smooth
 * slider in the settings panel (replaces the old Fit/Wide/Full presets).
 * 100 % = the page fills the whole reader width; lower values narrow it for
 * comfortable text-page reading. Capped so a low value never collapses to zero.
 */
export const IMAGE_WIDTH_MIN = 20;
export const IMAGE_WIDTH_MAX = 100;
export const IMAGE_WIDTH_STEP = 1;
/** Default ≈ the old "Fit" preset: a comfortable, sub-viewport column. */
export const DEFAULT_IMAGE_WIDTH_PERCENT = 60;

/**
 * Vertical-reader content width as a percentage of the viewport. The reader
 * is centered, so this caps the column: 100 % = full width, lower values
 * narrow it for comfortable text-page reading. Anchored to the old presets
 * (fit ≈ 60 %, wide ≈ 75 %, full = 100 % of a typical desktop viewport).
 */
export function verticalReaderWidthPercent(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}

/**
 * Gallery column floor (px) for a given width percent — wider settings tile
 * the gallery with larger images (fewer per row). Linear between the old
 * preset anchors (fit 200px ↔ full 480px).
 */
export function galleryColumnMinMax(percent: number): number {
  const p = Math.min(100, Math.max(0, percent));
  return Math.round(120 + (p / 100) * 360);
}
/** Continuous scroll speed for the Shift+W / Shift+S smooth-scroll shortcut. */
export type ScrollSpeed = 'slow' | 'normal' | 'fast';
/** How the two-page spread arranges its pair when the chapter has an odd count. */
export type SpreadOddPolicy = 'duplicate' | 'blank' | 'single';
/**
 * How page images fetch:
 *   parallel    — every page downloads immediately (instant turns, heavy data)
 *   sequential  — pages download as they approach the viewport (data-friendly)
 */
export type ImageLoadMode = 'parallel' | 'sequential';
/** How many upcoming pages the vertical reader fetches early while scrolling. */
export type PreloadAhead = number;
/** Bounds for a user-supplied custom value (see the settings panel number field). */
export const PRELOAD_AHEAD_MIN = 1;
export const PRELOAD_AHEAD_MAX = 50;
export const PRELOAD_AHEAD_STEP = 1;

/** Page brightness in percent (100 = untouched image). Slider bounds/step. */
export const IMAGE_BRIGHTNESS_MIN = 30;
export const IMAGE_BRIGHTNESS_MAX = 150;
export const IMAGE_BRIGHTNESS_STEP = 5;
/** Value below/at which the slider's Reset affordance is disabled. */
export const DEFAULT_IMAGE_BRIGHTNESS = 100;

export interface ReaderSettings {
  mode: ReadingMode;
  /** Page turn direction in paged mode. Defaults to left → right. */
  direction: ReadingDirection;
  background: ReaderBackground;
  /** Image width as a percent of the reader viewport (see IMAGE_WIDTH_*). */
  imageWidth: number;
  /** Fixed image width in px (user-entered). `null` = use the auto layout preset. */
  imageWidthPx: number | null;
  /** Fixed image height in px (user-entered). `null` = use the auto layout preset. */
  imageHeightPx: number | null;
  /** Show the bottom progress bar (footer) while reading. */
  showProgressBar: boolean;
  /** Add vertical breathing room between pages in the reader. */
  imageGap: boolean;
  /** Add padding so pages clear the fixed toolbar and footer (desktop & mobile). */
  clearToolbarSpace: boolean;
  /** How fast the reader auto-scrolls while holding Shift+W / Shift+S. */
  scrollSpeed: ScrollSpeed;
  /**
   * When true, plain W/S / ArrowUp/ArrowDown hold-to-smooth-scroll in
   * vertical and gallery modes at `scrollSpeed` (no Shift needed),
   * replacing the step keys.
   */
  smoothScrollKeys: boolean;
  /** Image loading strategy; defaults to loading pages as you scroll. */
  imageLoad: ImageLoadMode;
  /**
   * Pages fetched ahead of the reader position while scrolling (vertical
   * mode). Higher values make page turns feel instant on slow sources at
   * the cost of more concurrent downloads — the default is 3, a good middle
   * ground for the typically slow panel CDN this app talks to.
   */
  preloadAhead: PreloadAhead;
  /** Page brightness multiplier in percent (see IMAGE_BRIGHTNESS_* bounds). */
  imageBrightness: number;

  // --- Tier 1 QOL additions ---------------------------------------------------

  /**
   * Double-page spread mode (paged reader only). Pairs of pages are rendered
   * side by side like a printed book — the right half is the "current" page,
   * the left half is its facing page (previous in LTR, next in RTL).
   *
   * On an odd final page there is no facing page; this policy decides what
   * fills the empty half (defaults to a see-through card).
   */
  doublePage: boolean;
  /** How to handle the odd last page in a double-page spread. */
  spreadOddPolicy: SpreadOddPolicy;

  /**
   * Hands-free auto-scroll: when on, the reader advances one page every
   * `autoScrollDelayMs` milliseconds. Null = off. Toggled from the toolbar.
   */
  autoScrollDelayMs: number | null;
  /** Show the auto-scroll (hands-free playback) button in the reader toolbar. Hidden by default. */
  showAutoScrollButton: boolean;
  /**
   * Mouse-wheel smooth scroll (vertical mode): how many pages the wheel
   * moves at once. Smaller = finer control. 0 = native (one page per notch).
   */
  wheelPagesPerNotch: number;
  /**
   * How many pages the W/S / ↑/↓ keys advance in vertical mode — mirrors
   * `wheelPagesPerNotch` (a keypress behaves like a wheel notch). 0 =
   * native: a smooth eased viewport scroll instead of page quantisation.
   */
  keyPagesPress: number;

  // --- Tier 2 QOL additions ---------------------------------------------------

  /**
   * Paged mode only: fit the page to the viewport height so the whole image
   * is visible without scrolling. Width slider is ignored while this is on.
   */
  fitToHeight: boolean;

  /**
   * Vertical mode only: fit pages to the reader width so each page fills
   * the column. Width slider (and pixel sizes) are ignored while this is on.
   */
  fitToWidth: boolean;

  // --- Tier 3 QOL additions ---------------------------------------------------

  /**
   * Auto layout by aspect ratio (T3-6): when the current page is landscape
   * (a two-page spread scan), the paged reader temporarily drops double-page
   * mode so the wide page renders full-width instead of squeezed into half.
   */
  autoLandscapeSingle: boolean;

/**
 * Data-saver mode (T3-2): forces sequential image loading with minimal
 * preload (1 page ahead) and disables background next-chapter prefetch.
 * For metered connections.
 */
  dataSaver: boolean;
  /** Show the vertical scrollbar on the reading surface. Hidden by default
   *  on mobile; enabling it reveals the scrollbar everywhere. */
  showScrollbar: boolean;
  /** How fast the custom glide scroll feels (keyboard / scroll-to-page). */
  glidePreset: GlidePreset;
  /** MangaKatana image-server preference (only visible for `mk` source). */
  mkImageServer?: 'default' | 'sv2' | 'sv3';
}

/**
 * Pixels per second for each scroll-speed preset. Shifted one tier up from
 * the original values (slow 300 / normal 800 / fast 3000): "slow" is now the
 * old normal pace, "normal" is the old fast pace, and "fast" is a new
 * high-speed tier for quickly blowing through long chapters.
 */
export function scrollSpeedPx(speed: ScrollSpeed): number {
  switch (speed) {
    case 'slow':
      return 800;
    case 'fast':
      return 6000;
    default:
      return 3000;
  }
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  mode: 'vertical',
  direction: 'ltr',
  background: 'dark',
  imageWidth: DEFAULT_IMAGE_WIDTH_PERCENT,
  imageWidthPx: null,
  imageHeightPx: null,
  showProgressBar: true,
  imageGap: false,
  clearToolbarSpace: true,
  scrollSpeed: 'normal',
  /** Off by default — plain W/S / arrows keep their step behavior. */
  smoothScrollKeys: false,
  imageLoad: 'sequential',
  /**
   * 3 pages fetched ahead of the reader position by default — a good balance
   * between instant-feeling turns and not hammering slow panel CDNs. Lower to
   * 1 (data-friendly) or raise to 5 (instant turns) in the settings panel.
   */
  preloadAhead: 3,
  imageBrightness: DEFAULT_IMAGE_BRIGHTNESS,
  // --- Tier 1 QOL additions (defaults) ---
  doublePage: false,
  spreadOddPolicy: 'blank',
  /** 3.5s between page turns — a comfortable, near-cinema pace. */
  autoScrollDelayMs: 3500,
  /** Hidden by default — opt in from Advanced → Auto-scroll. */
  showAutoScrollButton: false,
  /** 0 = native wheel behaviour (one page per notch); 1 = one page per notch. */
  wheelPagesPerNotch: 0,
  /** 0 = native smooth scrolling (default); 1 = one page per keypress. */
  keyPagesPress: 0,
  /** Off by default — preserves the current width-driven paged layout. */
  fitToHeight: false,
  /** Off by default — preserves the current width-driven vertical layout. */
  fitToWidth: false,
  // --- Tier 3 QOL additions (defaults) ---
  autoLandscapeSingle: true,
  dataSaver: false,
  glidePreset: 'quick',
  showScrollbar: false,
  mkImageServer: 'default',
};

/** Forced pages-ahead while performance mode is on (the allowed maximum). */
export const PERF_READER_PRELOAD_AHEAD: PreloadAhead = PRELOAD_AHEAD_MAX;

/**
 * Effective reader settings under performance mode (the cache-settings
 * toggle). When ON, image loading is forced to parallel with maximum
 * preload and data-saver off for max throughput — without touching the
 * stored prefs, so turning the toggle off restores prior behavior with no
 * bookkeeping. Returns the stored object untouched (same reference) when
 * OFF or already maxed.
 */
export function resolveEffectiveReaderSettings(
  stored: ReaderSettings,
  opts?: { performanceMode?: boolean },
): ReaderSettings {
  if (opts?.performanceMode !== true) return stored;
  if (
    stored.imageLoad === 'parallel' &&
    stored.dataSaver !== true &&
    stored.preloadAhead >= PRELOAD_AHEAD_MAX
  ) {
    return stored;
  }
  return {
    ...stored,
    imageLoad: 'parallel',
    preloadAhead: PERF_READER_PRELOAD_AHEAD,
    dataSaver: false,
  };
}
