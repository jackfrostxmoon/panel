/**
 * Persisted chapter-list view mode for the panel details page (single
 * cycling control): every chapter newest-first, oldest-first, or the two
 * bookmarked-only variants. Stored per browser in localStorage and applied
 * on every panel's details page — the same "view preference" scope as the
 * reader settings and the default bookmark folder.
 *
 * Stored values are validated against the known set; anything unexpected
 * (stale key, hand-edited storage) falls back to `newest`.
 */

export type ChapterListMode = 'newest' | 'oldest' | 'bookmark-newest' | 'bookmark-oldest';

export const LIST_MODES: readonly ChapterListMode[] = [
  'newest',
  'oldest',
  'bookmark-newest',
  'bookmark-oldest',
];

const STORAGE_KEY = 'panel-details:list-mode:v1';

/** Returns the stored list mode, or `newest` when unset/invalid. */
export function readListMode(): ChapterListMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && (LIST_MODES as readonly string[]).includes(raw)) {
      return raw as ChapterListMode;
    }
    return 'newest';
  } catch {
    return 'newest';
  }
}

/** Persist the chosen list mode. */
export function writeListMode(mode: ChapterListMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // localStorage may be disabled (private mode, quota); silently ignore.
  }
}
