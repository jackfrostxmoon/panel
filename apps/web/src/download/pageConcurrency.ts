/**
 * Reader-following download width — pure module (no React) so it is
 * trivially unit-testable and matches the shape of
 * `apps/web/src/download/order.ts`.
 *
 * The detail-page downloader fans pages out at the same width the reader
 * uses: `parallel` ("All at once") downloads 8 pages at once, `sequential`
 * ("While scrolling") downloads `preloadAhead` pages at once, and
 * data-saver forces 1. A custom override detaches from the reader entirely.
 *
 * The queue itself stays single-flight (one chapter at a time) — only the
 * pages within the chapter fan out wider. The reader page itself is never
 * touched by this module; it only reads the saved reader settings.
 */

export type PageConcurrencyMode = 'follow-reader' | 'custom';

/** "All at once" width — matches the image-proxy upstream cap. */
export const DOWNLOAD_PARALLEL_CAP = 8;
/** Hard bounds for any page concurrency value. */
export const DOWNLOAD_PAGE_CONCURRENCY_MIN = 1;
export const DOWNLOAD_PAGE_CONCURRENCY_MAX = 16;
/** Fallback when no reader/download value is usable. */
export const DOWNLOAD_PAGE_CONCURRENCY_DEFAULT = 3;

export interface ReaderWidth {
  imageLoad?: unknown;
  preloadAhead?: unknown;
  dataSaver?: unknown;
}

export interface DownloadWidth {
  pageConcurrencyMode?: unknown;
  pageConcurrency?: unknown;
}

/** Clamp a custom page concurrency to the supported 1–16 range. */
export function clampDownloadPageConcurrency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DOWNLOAD_PAGE_CONCURRENCY_DEFAULT;
  }
  return Math.min(
    DOWNLOAD_PAGE_CONCURRENCY_MAX,
    Math.max(DOWNLOAD_PAGE_CONCURRENCY_MIN, Math.trunc(value)),
  );
}

/** Clamp a follow-reader sequential width (`preloadAhead`) to 1–8. */
function clampFollowSequential(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DOWNLOAD_PAGE_CONCURRENCY_DEFAULT;
  }
  return Math.min(
    DOWNLOAD_PARALLEL_CAP,
    Math.max(DOWNLOAD_PAGE_CONCURRENCY_MIN, Math.trunc(value)),
  );
}

/**
 * Resolve the effective pages-in-flight for a download batch.
 *
 * - `custom` mode returns the stored custom value verbatim (clamped 1–16).
 * - `follow-reader` (default) mirrors the reader: data-saver → 1,
 *   parallel → 8, sequential → `preloadAhead` clamped to 1–8.
 * - `performanceMode` (the cache-settings toggle) pins the width at the
 *   16-page maximum regardless of the above, for max download throughput.
 */
export function resolveDownloadPageConcurrency(
  reader: ReaderWidth,
  download: DownloadWidth,
  opts?: { performanceMode?: boolean },
): number {
  if (opts?.performanceMode === true) return DOWNLOAD_PAGE_CONCURRENCY_MAX;
  if (download.pageConcurrencyMode === 'custom') {
    return clampDownloadPageConcurrency(download.pageConcurrency);
  }
  if (reader.dataSaver === true) return DOWNLOAD_PAGE_CONCURRENCY_MIN;
  if (reader.imageLoad === 'parallel') return DOWNLOAD_PARALLEL_CAP;
  if (reader.imageLoad === 'sequential') return clampFollowSequential(reader.preloadAhead);
  return DOWNLOAD_PAGE_CONCURRENCY_DEFAULT;
}

/**
 * Human-readable summary of the effective width, for the download panel.
 * e.g. `8 pages at once (follows Reader: All at once)`.
 */
export function describeDownloadWidth(
  effective: number,
  reader: ReaderWidth,
  download: DownloadWidth,
  opts?: { performanceMode?: boolean },
): string {
  const pages = effective === 1 ? '1 page at once' : `${effective} pages at once`;
  if (opts?.performanceMode === true) return `${pages} (performance mode)`;
  if (download.pageConcurrencyMode === 'custom') return `${pages} (custom)`;
  if (reader.dataSaver === true) return `${pages} (follows Reader: Data saver)`;
  if (reader.imageLoad === 'parallel') return `${pages} (follows Reader: All at once)`;
  return `${pages} (follows Reader: While scrolling)`;
}
