/**
 * User-chosen default bookmark folder (T2-8 follow-up).
 *
 * Persists the folder id the user has picked as their "default" — the
 * folder whose contents are shown when they open the Bookmarks page
 * without explicitly selecting one. The system "All bookmarks" is the
 * implicit default until the user overrides it; clearing the stored value
 * restores that behaviour.
 *
 * Stored in localStorage (a per-browser preference) — the backend keeps
 * the system All bookmarks as the only `isDefault=true` row.
 *
 * The page also accepts `ALL_BOOKMARKS_ID` (the "show every bookmark
 * across every folder" sentinel) as a valid stored default, so the
 * user can pin the all-bookmarks view as their landing folder too.
 */

const STORAGE_KEY = 'panel-bookmarks:default-folder-id:v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENTINEL_RE = /^__all__$/;

/** Returns the user-chosen default folder id, or null if none. */
export function readDefaultFolderId(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // Accept either a UUID (real folder) or the all-bookmarks sentinel —
    // anything else is treated as a stale value and ignored so it can't
    // poison the page's data layer.
    if (UUID_RE.test(trimmed) || SENTINEL_RE.test(trimmed)) return trimmed;
    return null;
  } catch {
    return null;
  }
}

/** Persist the user-chosen default folder id. Pass null to clear. */
export function writeDefaultFolderId(folderId: string | null): void {
  try {
    if (folderId) {
      localStorage.setItem(STORAGE_KEY, folderId);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // localStorage may be disabled (private mode, quota); silently ignore.
  }
}
