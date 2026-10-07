/** Display formatting helpers. */

/** "May 31, 2023" from an ISO string; null-safe. */
export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Relative "x days ago" style label for progress timestamps. */
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [604800, 'day'],
    [2629800, 'week'],
    [31557600, 'month'],
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  let value = seconds;
  let unit: Intl.RelativeTimeFormatUnit = 'second';
  for (const [limit, nextUnit] of units) {
    if (value < limit) break;
    value /= limit;
    unit = nextUnit;
  }
  return rtf.format(-Math.round(value), unit);
}

/** "Chapter 200" style label with graceful fallbacks. */
export function chapterLabel(chapterNumber: number | null, title: string): string {
  if (chapterNumber !== null) return `Ch. ${chapterNumber}`;
  return title;
}

/** Human-readable byte size (e.g. "1.2 GB", "340 KB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const value = Math.floor(Math.log(bytes) / Math.log(1024));
  const unit = units[value] ?? units[units.length - 1];
  const amount = bytes / 1024 ** value;
  return `${amount.toFixed(value === 0 ? 0 : 1)} ${unit}`;
}

/** Human-readable source label for the global-id prefix ("mk" → "MangaKatana"). */
const SOURCE_LABELS: Record<string, string> = {
  mk: 'MangaKatana',
  nk: 'NihonKuni',
  rk: 'Rawkuma',
  rs: 'RawSakura',
  hd: 'Hiperdex',
  mr: 'MangaRead',
  tn: 'Toonily',
  rd: 'RawDex',
  ks: 'KaliScan',
  ru: 'RawUwU',
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/**
 * Returns a proxied image URL for ALL sources so the client-side cache can
 * warm + persist covers (and chapter pages) in the Docker image cache.
 *
 * Every cover is routed through the API's image proxy regardless of source:
 *   - sources with hotlink-protected CDNs (hd/tn/rd) need the proxy to add a
 *     Referer server-side;
 *   - the other sources are browser-safe, but the proxy is the only way for
 *     the client cache to pre-warm and persist their images.
 *
 * Covers and reader pages are effectively immutable upstream, so the extra
 * round-trip is a one-time cost — repeat visits (and warm-up hits) are served
 * from the API's on-disk cache with no upstream fetch.
 *
 * `kind` selects the proxy subdirectory (`cover` vs `chapter`) so the
 * clear-control can purge one without the other.
 *
 * `tag` is an optional provenance string (e.g. a panel global-id like
 * `mk:solo-leveling.21708` for a cover, or a chapter global-id like
 * `mk:solo-leveling.21708~c200` for a chapter page). When provided, the
 * proxy writes the cached file with that tag baked into its filename,
 * so it can be selectively cleared later (per-panel / per-chapter) via
 * the cache settings page. Pass `null` (or omit) for legacy / unknown
 * callers — the file is still cached and served, just without a tag
 * index entry.
 */
export function getProxiedImageUrl(
  source: string,
  url: string | null,
  kind: 'cover' | 'chapter' = 'cover',
  tag: string | null = null,
): string | null {
  if (!url) return null;
  // Adapters with hotlink-protected CDNs (hd/tn/rd) rewrite their own image
  // URLs to the proxy — don't double-wrap those (e.g. covers saved alongside
  // reading progress from a chapter payload).
  if (url.startsWith('/api/source-image')) return url;
  const tagPart = tag ? `&tag=${encodeURIComponent(tag)}` : '';
  return `/api/source-image/${kind}?source=${encodeURIComponent(source)}&u=${encodeURIComponent(url)}${tagPart}`;
}

/**
 * Returns the proxied URL for a single reader page (a `PanelPage` from a
 * `ChapterPages` payload). Same provenance tag the reader passes — the
 * server hashes the tag the same way on both read and pre-download paths,
 * so pre-downloading warms the exact byte bucket the reader will hit.
 *
 * The page's `index` is sent along as `&p=` so the server caches the image
 * under a STABLE key (chapter id + page index) instead of the tokenized
 * upstream URL — a pre-warmed chapter stays cached even when the source
 * rotates its image URLs.
 *
 * Self-proxying adapters (hd / tn / rd) emit page URLs already pointing at
 * `/api/source-image?source=...&u=...`. Those used to pass through
 * unchanged here, which silently broke offline reading for downloaded
 * chapters: the prefetch worker unwraps them and re-caches under the
 * tag+stable-key bucket, but the reader kept requesting the bare URL and
 * landed in the legacy URL-hash bucket — a miss, then an upstream fetch
 * that fails with no internet. Unwrap and re-wrap so the reader requests
 * the same bucket the worker warmed.
 */
export function proxiedPageUrl(
  page: { url: string; source?: string; index?: number },
  chapterTag: string | null,
): string {
  let upstreamUrl = page.url;
  let sourceName = page.source ?? null;
  if (page.url.startsWith('/api/source-image')) {
    try {
      const parsed = new URL(page.url, 'http://localhost');
      const u = parsed.searchParams.get('u');
      const s = parsed.searchParams.get('source');
      if (u) upstreamUrl = decodeURIComponent(u);
      if (s) sourceName = s;
    } catch {
      // Malformed self-proxy URL — fall through with the raw value; the
      // proxy will reject it and the page fails to load (correct behaviour).
    }
  }
  if (!sourceName) return page.url;
  const base = getProxiedImageUrl(sourceName, upstreamUrl, 'chapter', chapterTag);
  if (!base) return page.url;
  if (chapterTag && typeof page.index === 'number') {
    return `${base}&p=${page.index}`;
  }
  return base;
}

export interface SourceOption {
  code: string;
  label: string;
}

/** Selectable sources for the source filter (insertion order = display order). */
export const SOURCE_OPTIONS: SourceOption[] = Object.entries(SOURCE_LABELS).map(
  ([code, label]) => ({ code, label }),
);

/**
 * Sources in the user's preferred order (the Sources page editor writes it
 * to `data/display/sources.json`). Unknown codes are ignored; known codes
 * missing from the list keep their canonical relative order at the end —
 * so a newly added source never vanishes from the filter.
 */
export function orderedSourceOptions(order?: readonly string[]): SourceOption[] {
  if (!order || order.length === 0) return SOURCE_OPTIONS;
  const byCode = new Map(SOURCE_OPTIONS.map((option) => [option.code, option]));
  const seen = new Set<string>();
  const out: SourceOption[] = [];
  for (const code of order) {
    const option = byCode.get(code);
    if (option && !seen.has(code)) {
      seen.add(code);
      out.push(option);
    }
  }
  for (const option of SOURCE_OPTIONS) {
    if (!seen.has(option.code)) out.push(option);
  }
  return out;
}

/**
 * Default source honoring the user's order: the first source in the merged
 * order (their top pick, or MangaKatana when no order is saved yet).
 */
export function defaultSourceFor(order?: readonly string[]): string {
  return orderedSourceOptions(order)[0]!.code;
}
