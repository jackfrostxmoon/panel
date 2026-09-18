/**
 * Bulk-download settings — persisted to localStorage so the user's
 * pacing preferences survive across sessions. Pure module (no React) so
 * it is trivially unit-testable and matches the shape of
 * `apps/web/src/reader/settings.ts`.
 *
 * Today the only knob is the wait between chapters in a batch. The
 * merge-over-defaults load strategy means new fields can be added here
 * later without a migration step — the stored snapshot is spread on top
 * of `DEFAULT_DOWNLOAD_SETTINGS` so any missing key falls back to its
 * default.
 */

/**
 * Pacing options for bulk chapter downloads.
 */
export interface DownloadSettings {
  /**
   * Milliseconds to wait after a chapter finishes (successfully OR with
   * per-chapter failure) before the next chapter in the batch starts
   * downloading. `0` = no pause — chapters chain back-to-back (the
   * pre-existing behaviour, also the default).
   *
   * The pause is skipped on user cancel and on the very last chapter of
   * a batch (nothing to wait for). Within a chapter, pages still fan out
   * at 3 parallel as before — this only spaces chapters apart, so a
   * user-controlled rate limit keeps the upstream source from being
   * hammered by "Download all" runs.
   */
  chapterIntervalMs: number;
}

/** Default pacing: no wait between chapters (backwards-compatible). */
export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = {
  chapterIntervalMs: 0,
};

/** Sensible upper bound for the custom input (10 minutes). */
export const DOWNLOAD_INTERVAL_MAX_MS = 600_000;

/** Minimum allowed value (0 = off). */
export const DOWNLOAD_INTERVAL_MIN_MS = 0;

/** Step the custom input snaps to. */
export const DOWNLOAD_INTERVAL_STEP_MS = 1_000;

const STORAGE_KEY = 'panel-downloader:settings:v1';

/**
 * Preset values surfaced in the UI as a segmented row. Keep these
 * consistent with `CHAPTER_INTERVAL_PRESETS` in the actions component
 * so the segmented buttons match the typed values.
 */
export const CHAPTER_INTERVAL_PRESETS: ReadonlyArray<{
  value: number;
  label: string;
}> = [
  { value: 0, label: 'Off' },
  { value: 30_000, label: '30s' },
  { value: 60_000, label: '1m' },
  { value: 120_000, label: '2m' },
  { value: 300_000, label: '5m' },
];

/**
 * Load the stored download settings, always returning a fully-populated
 * object so callers never have to check for missing fields. Bad/missing
 * storage falls back to `DEFAULT_DOWNLOAD_SETTINGS`; unknown future
 * fields in storage are ignored.
 */
export function loadDownloadSettings(
  storage: Pick<Storage, 'getItem'> = localStorage,
): DownloadSettings {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_DOWNLOAD_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { ...DEFAULT_DOWNLOAD_SETTINGS };
    }
    // Merge over defaults so adding new fields later needs no migration.
    return { ...DEFAULT_DOWNLOAD_SETTINGS, ...(parsed as Partial<DownloadSettings>) };
  } catch {
    return { ...DEFAULT_DOWNLOAD_SETTINGS };
  }
}

/**
 * Persist the download settings. Storage failures (full quota, private
 * mode, etc.) are swallowed — settings simply won't survive a reload.
 */
export function saveDownloadSettings(
  settings: DownloadSettings,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full/blocked — non-fatal.
  }
}

/**
 * Clamp a user-entered interval to the supported range. Exposed so the
 * UI's number input and the segmented presets share one validation
 * rule instead of duplicating min/max checks.
 *
 * `NaN` is the one true "fall back to default" case — the user cleared
 * the input or typed something unparseable, and we want that to look
 * identical to "0 / off" rather than the upper bound. ±Infinity are
 * clamped to the bounds because they're the "user typed a huge /
 * huge-negative number" cases.
 */
export function clampDownloadInterval(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_DOWNLOAD_SETTINGS.chapterIntervalMs;
  return Math.min(
    DOWNLOAD_INTERVAL_MAX_MS,
    Math.max(DOWNLOAD_INTERVAL_MIN_MS, Math.trunc(value)),
  );
}
