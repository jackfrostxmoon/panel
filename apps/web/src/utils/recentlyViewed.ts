/**
 * Recently-viewed panel rail (T2-5 / T2-4).
 *
 * Records the last N panel taps (from the details page) so the home page
 * can show a "continue reading" rail without depending on reading progress.
 * Persisted to localStorage.
 */

const STORAGE_KEY = 'panel-recently-viewed:v1';
const MAX = 10;

export interface RecentlyViewedEntry {
  id: string;
  title: string;
  coverUrl: string | null;
  source: string;
  sourceUrl?: string;
  status?: 'ongoing' | 'completed' | 'hiatus' | 'cancelled' | 'unknown';
  latestChapter?: string | null;
  updatedAt?: string | null;
  /** ISO timestamp of the last tap. */
  viewedAt: string;
}

function read(): RecentlyViewedEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).slice(0, MAX);
  } catch {
    return [];
  }
}

function write(entries: RecentlyViewedEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX)));
  } catch {
    // Best-effort — never block the UI.
  }
}

function isEntry(x: unknown): x is RecentlyViewedEntry {
  return (
    !!x &&
    typeof x === 'object' &&
    typeof (x as { id?: unknown }).id === 'string' &&
    typeof (x as { viewedAt?: unknown }).viewedAt === 'string'
  );
}

export function recordRecentlyViewed(entry: Omit<RecentlyViewedEntry, 'viewedAt'>): void {
  const list = read();
  const next = list.filter((e) => e.id !== entry.id);
  next.unshift({ ...entry, viewedAt: new Date().toISOString() });
  write(next);
}

export function loadRecentlyViewed(): RecentlyViewedEntry[] {
  return read();
}

/**
 * Overwrite the local rail (used to cache the server-side history for
 * offline reads). Entries are re-validated and capped like any write.
 */
export function replaceRecentlyViewed(entries: RecentlyViewedEntry[]): void {
  write(entries.filter(isEntry));
}

export function clearRecentlyViewed(): void {
  write([]);
}