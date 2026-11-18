/**
 * Display settings — persisted to localStorage so the user's cover-card
 * preferences survive across sessions. Pure module (no React) so it is
 * trivially unit-testable and matches the shape of
 * `apps/web/src/reader/settings.ts` and `apps/web/src/download/settings.ts`.
 *
 * Today the only knob is whether cover cards show their overlay badges
 * (status pill, source label, bookmark glyph, folder pills). The
 * merge-over-defaults load strategy means new fields can be added here
 * later without a migration step — the stored snapshot is spread on top
 * of `DEFAULT_DISPLAY_SETTINGS` so any missing key falls back to its
 * default.
 */

/** What gets overlaid on cover cards across the app. */
export interface DisplaySettings {
  /**
   * Hide every cover-card overlay: the status pill, the source label, the
   * bookmark glyph and the folder pills. `true` = clean covers (the
   * default); `false` = show all badges.
   */
  hideCoverBadges: boolean;
}

/** Default: badges hidden for clean covers. */
export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  hideCoverBadges: true,
};

const STORAGE_KEY = 'panel-display:settings:v1';

/**
 * Load the stored display settings, always returning a fully-populated
 * object so callers never have to check for missing fields. Bad/missing
 * storage falls back to `DEFAULT_DISPLAY_SETTINGS`; unknown future fields
 * in storage are ignored.
 */
export function loadDisplaySettings(
  storage: Pick<Storage, 'getItem'> = localStorage,
): DisplaySettings {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_DISPLAY_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { ...DEFAULT_DISPLAY_SETTINGS };
    }
    // Merge over defaults so adding new fields later needs no migration.
    return { ...DEFAULT_DISPLAY_SETTINGS, ...(parsed as Partial<DisplaySettings>) };
  } catch {
    return { ...DEFAULT_DISPLAY_SETTINGS };
  }
}

/**
 * Persist the display settings. Storage failures (full quota, private
 * mode, etc.) are swallowed — settings simply won't survive a reload.
 */
export function saveDisplaySettings(
  settings: DisplaySettings,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full/blocked — non-fatal.
  }
}