/**
 * Persisted search history — the last few queries the user ran, so a repeat
 * search is one tap instead of a retype. Stored in localStorage under a
 * versioned key so the list never grows past a cap and survives reloads.
 *
 * Pure module (no React) so the read/write/merge logic is trivially
 * unit-testable in isolation.
 */

const STORAGE_KEY = 'panel-search:history:v1';
const MAX_ENTRIES = 8;

export interface SearchHistoryEntry {
  query: string;
  /** ISO timestamp of the last time this query ran. */
  at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function loadSearchHistory(
  storage: Pick<Storage, 'getItem'> = localStorage,
): SearchHistoryEntry[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: SearchHistoryEntry[] = [];
    for (const item of parsed) {
      if (!isRecord(item)) continue;
      const query = item.query;
      const at = item.at;
      if (typeof query !== 'string' || query.trim().length === 0) continue;
      if (typeof at !== 'string') continue;
      entries.push({ query: query.trim(), at });
    }
    // Most recent first.
    return entries.sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

export function saveSearchHistory(
  entries: SearchHistoryEntry[],
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage full/blocked — history simply won't persist. Non-fatal.
  }
}

/**
 * Record a new query run: push it to the front, dedupe by lowercased
 * trimmed query, and cap the list. Returns the updated list.
 */
export function recordSearchQuery(
  query: string,
  previous: SearchHistoryEntry[],
): SearchHistoryEntry[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return previous;

  const filtered = previous.filter(
    (entry) => entry.query.toLowerCase() !== trimmed.toLowerCase(),
  );
  const next = [{ query: trimmed, at: new Date().toISOString() }, ...filtered];
  return next.slice(0, MAX_ENTRIES);
}

/** Remove a single entry by query (case-insensitive). */
export function removeSearchHistoryEntry(
  query: string,
  previous: SearchHistoryEntry[],
): SearchHistoryEntry[] {
  const trimmed = query.trim().toLowerCase();
  return previous.filter((entry) => entry.query.toLowerCase() !== trimmed);
}

/** Wipe the whole history. */
export function clearSearchHistory(): SearchHistoryEntry[] {
  return [];
}

/** The maximum number of entries the history stores. */
export const SEARCH_HISTORY_MAX = MAX_ENTRIES;