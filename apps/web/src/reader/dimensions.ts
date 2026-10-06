/**
 * Client-side cache of measured page-image dimensions.
 *
 * Some sources (e.g. `mr`) expose no intrinsic dimensions, so the first
 * visit reserves a fallback aspect-ratio box and every page below the
 * viewport jumps when the real bitmap loads (CLS). The real ratio is known
 * the moment `onLoad` fires (`naturalWidth`/`naturalHeight`) — persist it
 * keyed by the page URL so repeat visits (and chapter re-opens) reserve the
 * exact box up-front with zero layout shift.
 *
 * Pure localStorage helper (no React) — capped so a large library can't grow
 * the entry unbounded. Best-effort: storage may be blocked, full, or hold a
 * stale ratio after an upstream re-encode; a wrong guess only costs the same
 * shift the fallback would have caused anyway.
 */

const STORAGE_KEY = 'panel-reader:page-dims:v1';
/** Max entries kept — oldest evicted first. */
const MAX_ENTRIES = 1000;

export interface CachedDimensions {
  width: number;
  height: number;
}

function readAll(): Map<string, CachedDimensions> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = new Map<string, CachedDimensions>();
    for (const [url, value] of Object.entries(parsed)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { width?: unknown }).width === 'number' &&
        typeof (value as { height?: unknown }).height === 'number'
      ) {
        const width = (value as { width: number }).width;
        const height = (value as { height: number }).height;
        if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
          out.set(url, { width: Math.round(width), height: Math.round(height) });
        }
      }
      if (out.size >= MAX_ENTRIES) break;
    }
    return out;
  } catch {
    return new Map();
  }
}

function writeAll(entries: Map<string, CachedDimensions>): void {
  try {
    // Trim oldest first — Map preserves insertion order.
    while (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage blocked or full — the reader works without the cache.
  }
}

/** Dimensions measured on a previous visit for this exact image URL, if any. */
export function getCachedDimensions(pageUrl: string): CachedDimensions | null {
  if (!pageUrl) return null;
  return readAll().get(pageUrl) ?? null;
}

/** Remember dimensions measured from a loaded bitmap for future visits. */
export function setCachedDimensions(pageUrl: string, width: number, height: number): void {
  if (!pageUrl) return;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return;
  const entries = readAll();
  // Re-insert to mark as most-recently-used.
  entries.delete(pageUrl);
  entries.set(pageUrl, { width: Math.round(width), height: Math.round(height) });
  writeAll(entries);
}

/** `"900 / 6600"`-style ratio for the wrapper box, or null when unknown. */
export function getCachedAspectRatio(pageUrl: string): string | null {
  const dims = getCachedDimensions(pageUrl);
  return dims ? `${dims.width} / ${dims.height}` : null;
}
