import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import type { PanelStatus } from '@panel/shared';

/**
 * Hiperdex (hiperdex.com) HTML/XML parser.
 *
 * Hiperdex is a React SPA with Cloudflare protection. However, key pages have
 * server-side rendered metadata in OG tags and JSON-LD schema.org markup.
 *
 * URL layout (verified 2026-08):
 *   panel:    GET {base}/manga/<slug>/
 *   chapter:  GET {base}/manga/<slug>/<chapter_num>/
 *   latest:   sitemap-series.xml (sorted by lastmod)
 *   chapters: sitemap-chapters-*.xml (filter by panel slug)
 *
 * Native panel id: slug (e.g., "lost-seven")
 * Native chapter id: "<slug>~<chapter_num>" (e.g., "lost-seven~1", "lost-seven~2.5")
 *
 * Image CDNs: cloud-7.r2d2storage.com, i1.r2d2storage.com, *.r2d2storage.com
 *
 * All parsing lives in this file — pure functions: HTML/XML string in,
 * plain data out. No fetching, no global state, no id prefixing.
 */

export class PageNotRecognizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageNotRecognizedError';
  }
}

/* -------------------------------------------------------------------------- */
/* Raw result shapes                                                           */
/* -------------------------------------------------------------------------- */

export interface RawListItem {
  nativeId: string;
  title: string;
  coverUrl: string | null;
  sourceUrl: string;
  status: PanelStatus;
  genres: string[];
  summary: string | null;
  latestChapterLabel: string | null;
  updatedAt: string | null;
}

export interface RawPanelDetails {
  nativeId: string;
  title: string;
  altTitles: string[];
  authors: string[];
  artists: string[];
  genres: string[];
  status: PanelStatus;
  description: string | null;
  coverUrl: string | null;
  sourceUrl: string;
  latestChapterLabel: string | null;
}

export interface RawChapterItem {
  nativeId: string;
  panelNativeId: string;
  chapterToken: string;
  title: string;
  chapterNumber: number | null;
  sourceUrl: string;
  publishedAt: string | null;
}

export interface RawChapterPages {
  imageUrls: string[];
  panelTitle: string | null;
  readerLabel: string | null;
  coverUrl: string | null;
  publishedAt: string | null;
  prevRef: { panelId: string; token: string } | null;
  nextRef: { panelId: string; token: string } | null;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, code: string) => {
      const cp = Number.parseInt(code, 10);
      return Number.isSafeInteger(cp) && cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => {
      const cp = Number.parseInt(code, 16);
      return Number.isSafeInteger(cp) && cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : '';
    })
    .replace(/&([a-zA-Z]+);/g, (whole, name: string) => ENTITY_MAP[name] ?? whole);
}

function textOf(el: HTMLElement | null | undefined): string | null {
  if (!el) return null;
  const text = decodeEntities(el.text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
}

function absoluteUrl(href: string | undefined | null, baseUrl: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function parseIsoToIso(raw: string | null): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** "lost-seven" from "https://hiperdex.com/manga/lost-seven/" */
export function panelNativeIdFromUrl(url: string): string | null {
  const match = /\/manga\/([^/?#]+)\/?$/i.exec(url);
  return match?.[1] ?? null;
}

/**
 * { panelId: "lost-seven", token: "1" } from chapter URL:
 *   "https://hiperdex.com/manga/lost-seven/1"
 *   "https://hiperdex.com/manga/lost-seven/2.5"
 *   "https://hiperdex.com/manga/goblin-wa-mou-juubun-ni-tsuyoi/32-5"
 */
export function readerRefFromUrl(url: string): { panelId: string; token: string } | null {
  const match = /\/manga\/([^/?#]+)\/(\d+(?:[.-]\d+)*)\/?$/i.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { panelId: match[1], token: match[2] };
}

/** "1" → 1, "2.5" → 2.5, "32-5" → 32.5 (Madara-style "-x" suffix = decimal), anything else → null */
export function chapterNumberFromToken(token: string): number | null {
  const normalized = token.includes('-') ? token.replace(/-/g, '.') : token;
  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

export function normalizeStatus(raw: string | null): PanelStatus {
  if (!raw) return 'unknown';
  const value = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (value.includes('ongoing') || value.includes('releasing') || value.includes('publishing'))
    return 'ongoing';
  if (value.includes('completed') || value.includes('complete') || value.includes('end')) return 'completed';
  if (value.includes('hiatus')) return 'hiatus';
  if (value.includes('cancel') || value.includes('drop')) return 'cancelled';
  return 'unknown';
}

/* -------------------------------------------------------------------------- */
/* Sitemap parsing (namespace-agnostic via regex)                              */
/* -------------------------------------------------------------------------- */

interface SitemapUrlEntry {
  loc: string;
  lastmod?: string;
}

function parseSitemap(xml: string): SitemapUrlEntry[] {
  const entries: SitemapUrlEntry[] = [];
  // Match <url>...</url> blocks regardless of namespace
  const urlBlockRe = /<url>([\s\S]*?)<\/url>/g;
  for (const match of xml.matchAll(urlBlockRe)) {
    const block = match[1];
    if (block === undefined) continue;
    const locMatch = /<loc>([^<]+)<\/loc>/.exec(block);
    const lastmodMatch = /<lastmod>([^<]+)<\/lastmod>/.exec(block);
    const loc = locMatch?.[1];
    if (loc) {
      entries.push({
        loc: loc.trim(),
        lastmod: lastmodMatch?.[1]?.trim(),
      });
    }
  }
  return entries;
}

/** Parse sitemap-series.xml → RawListItem[] sorted by lastmod desc (newest first) */
export function parseSeriesSitemap(xml: string, _baseUrl: string): RawListItem[] {
  const entries = parseSitemap(xml);
  const items: RawListItem[] = [];

  for (const entry of entries) {
    const nativeId = panelNativeIdFromUrl(entry.loc);
    if (!nativeId) continue;

    // Title from URL slug (human-readable approximation)
    const title = nativeId
      .split('-')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    items.push({
      nativeId,
      title,
      coverUrl: null, // Not in sitemap
      sourceUrl: entry.loc,
      status: 'unknown',
      genres: [],
      summary: null,
      latestChapterLabel: null,
      updatedAt: parseIsoToIso(entry.lastmod ?? null),
    });
  }

  // Sort by lastmod desc (newest first)
  items.sort((a, b) => {
    if (!a.updatedAt && !b.updatedAt) return 0;
    if (!a.updatedAt) return 1;
    if (!b.updatedAt) return -1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return items;
}

/** Parse chapter sitemaps → filter by panel slug → RawChapterItem[] */
export function parseChapterSitemaps(
  xmls: string[],
  baseUrl: string,
  panelSlug: string
): RawChapterItem[] {
  const chapters: RawChapterItem[] = [];
  const prefix = `/manga/${panelSlug}/`;

  for (const xml of xmls) {
    const entries = parseSitemap(xml);
    for (const entry of entries) {
      // <loc> holds an ABSOLUTE url ("https://hiperdex.com/manga/<slug>/1") —
      // compare the path portion, not the raw loc (which never starts with "/").
      let path: string;
      try {
        path = new URL(entry.loc).pathname;
      } catch {
        path = entry.loc;
      }
      if (!path.startsWith(prefix)) continue;

      const ref = readerRefFromUrl(entry.loc);
      if (!ref || ref.panelId !== panelSlug) continue;

      const chapterNum = chapterNumberFromToken(ref.token);
      chapters.push({
        nativeId: `${ref.panelId}~${ref.token}`,
        panelNativeId: ref.panelId,
        chapterToken: ref.token,
        // Display decimals as "27.2" — the "-2" form is only URL encoding.
        title: `Chapter ${ref.token.replace(/-/g, '.')}`,
        chapterNumber: chapterNum,
        sourceUrl: entry.loc,
        publishedAt: parseIsoToIso(entry.lastmod ?? null),
      });
    }
  }

  // Sort ascending by chapter number
  chapters.sort((a, b) => (a.chapterNumber ?? Infinity) - (b.chapterNumber ?? Infinity));
  return chapters;
}

/* -------------------------------------------------------------------------- */
/* Panel detail page parsing (OG + JSON-LD)                                    */
/* -------------------------------------------------------------------------- */

function extractJsonLdBook(html: string): Record<string, unknown> | null {
  const root = parseHtml(html);
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = script.text?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        if (item && typeof item === 'object' && (item['@type'] === 'Book' || item['@type'] === 'GraphicNovel')) {
          return item as Record<string, unknown>;
        }
      }
    } catch {
      // Ignore malformed JSON-LD
    }
  }
  return null;
}

function extractJsonLdArticle(html: string): Record<string, unknown> | null {
  const root = parseHtml(html);
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = script.text?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        if (item && typeof item === 'object' && item['@type'] === 'Article') {
          return item as Record<string, unknown>;
        }
      }
    } catch {
      // Ignore malformed JSON-LD
    }
  }
  return null;
}

function getOgProperty(html: string, property: string): string | null {
  const root = parseHtml(html);
  const meta = root.querySelector(`meta[property="${property}"]`);
  return meta?.getAttribute('content') ?? null;
}

/** Site appends "| HIPERDEX" to SSR titles — strip it for display. */
function cleanSiteTitle(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s*\|\s*HIPERDEX\s*$/i, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Parse panel detail page */
export function parsePanelPage(html: string, sourceUrl: string, baseUrl: string): RawPanelDetails {
  const jsonLd = extractJsonLdBook(html);
  const root = parseHtml(html);

  const title =
    cleanSiteTitle(getOgProperty(html, 'og:title')) ??
    (jsonLd?.name as string | null) ??
    textOf(root.querySelector('h1')) ??
    '';
  if (!title) {
    throw new PageNotRecognizedError('Panel page did not contain a title.');
  }

  const nativeId = panelNativeIdFromUrl(sourceUrl) ?? '';
  const description = (jsonLd?.description as string | null) ?? getOgProperty(html, 'og:description') ?? null;
  // JSON-LD image can be a plain url string or an ImageObject ({ url }).
  const jsonLdImage = jsonLd?.image as string | { url?: unknown } | undefined;
  const coverUrl =
    getOgProperty(html, 'og:image') ??
    (typeof jsonLdImage === 'string'
      ? jsonLdImage
      : typeof jsonLdImage?.url === 'string'
        ? jsonLdImage.url
        : null) ??
    null;

  // Genres, authors, artists, status not in SSR — default to empty
  // Latest chapter from breadcrumb or chapter link if available
  const latestChapterLabel = null;

  return {
    nativeId,
    title,
    altTitles: [],
    authors: [],
    artists: [],
    genres: [],
    status: 'unknown',
    description,
    coverUrl: absoluteUrl(coverUrl, baseUrl),
    sourceUrl,
    latestChapterLabel,
  };
}

/* -------------------------------------------------------------------------- */
/* Chapter reader page parsing (JSON-LD Article)                               */
/* -------------------------------------------------------------------------- */

/** Parse chapter reader page — extract ALL images from JSON-LD Article.image[] */
export function parseChapterReaderPage(html: string, baseUrl: string): RawChapterPages {
  const jsonLd = extractJsonLdArticle(html);
  const root = parseHtml(html);

  // Image URLs from JSON-LD Article.image array
  const imageUrls: string[] = [];
  const images = jsonLd?.image;
  if (Array.isArray(images)) {
    for (const img of images) {
      if (typeof img === 'string') imageUrls.push(img);
    }
  } else if (typeof images === 'string') {
    imageUrls.push(images);
  }

  // Panel title from isPartOf
  const isPartOf = jsonLd?.isPartOf;
  const panelTitle =
    (isPartOf as Record<string, unknown> | null)?.name as string | null ??
    cleanSiteTitle(getOgProperty(html, 'og:title')) ??
    null;

  // Chapter label from headline
  const headline = cleanSiteTitle(jsonLd?.headline as string | null) ?? getOgProperty(html, 'og:title');
  const readerLabel = headline ?? null;

  // Cover from og:image
  const coverUrl = absoluteUrl(getOgProperty(html, 'og:image'), baseUrl);

  // Published date
  const publishedAt = parseIsoToIso(jsonLd?.datePublished as string | null ?? null);

  // Next chapter from rel="next"
  const nextLink = root.querySelector('link[rel="next"]')?.getAttribute('href');
  const nextRef = nextLink ? readerRefFromUrl(nextLink) : null;

  // Previous chapter not in rel="prev" — would need to infer
  const prevRef = null;

  if (imageUrls.length === 0 && !readerLabel && !panelTitle) {
    throw new PageNotRecognizedError('Chapter page did not contain reader data.');
  }

  return {
    imageUrls,
    panelTitle,
    readerLabel,
    coverUrl,
    publishedAt,
    prevRef,
    nextRef,
  };
}

/* -------------------------------------------------------------------------- */
/* Reader api (private tRPC endpoint of the SPA)                              */
/* -------------------------------------------------------------------------- */

/**
 * The SSR JSON-LD only embeds the FIRST THREE page urls — the full list
 * lives behind the SPA's private tRPC api. Reverse-engineered from the site
 * bundle (2026-08):
 *   - every /api/trpc request carries header `x-cfg-auth: <key>`
 *   - requests need a `__st` session cookie (set by any HTML page)
 *   - GET reader.chapterPages?input={"json":{"seriesSlug":…,"chapterNumber":…}}
 */
export const HIPERDEX_API_KEY = 'yceqt7qgu004';
export const HIPERDEX_API_HEADER = 'x-cfg-auth';
export const HIPERDEX_SESSION_COOKIE = '__st';

/** tRPC query url for the ordered, COMPLETE page list of one chapter. */
export function buildChapterPagesApiUrl(
  baseUrl: string,
  seriesSlug: string,
  chapterNumber: number,
): string {
  const input = encodeURIComponent(
    JSON.stringify({ json: { seriesSlug: seriesSlug, chapterNumber: chapterNumber } }),
  );
  return `${baseUrl}/api/trpc/reader.chapterPages?input=${input}`;
}

export interface RawApiPage {
  order: number;
  url: string;
  width: number | null;
  height: number | null;
}

/**
 * Parse the trpc payload → ordered pages. Returns null on ANY unexpected
 * shape so callers can fall back to the JSON-LD page list.
 */
export function parseChapterPagesApi(body: string): RawApiPage[] | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const rows = (
      parsed as { result?: { data?: { json?: unknown } } }
    )?.result?.data?.json;
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const pages: RawApiPage[] = [];
    for (const row of rows as Array<Record<string, unknown>>) {
      const url =
        typeof row['webpUrl'] === 'string'
          ? row['webpUrl']
          : typeof row['avifUrl'] === 'string'
            ? row['avifUrl']
            : null;
      if (!url) continue;
      const order = typeof row['pageOrder'] === 'number' ? row['pageOrder'] : pages.length + 1;
      pages.push({
        order,
        url,
        width: typeof row['width'] === 'number' ? row['width'] : null,
        height: typeof row['height'] === 'number' ? row['height'] : null,
      });
    }
    if (pages.length === 0) return null;
    return pages.sort((a, b) => a.order - b.order);
  } catch {
    return null;
  }
}

/** Value of the `__st` session cookie from Set-Cookie headers; null if absent. */
export function sessionCookieFromSetCookies(setCookie: string[]): string | null {
  for (const cookie of setCookie) {
    const pair = cookie.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    if (pair.slice(0, eq).trim() === HIPERDEX_SESSION_COOKIE) {
      const value = pair.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Series chapters api (fast chapter-list path)                                */
/* -------------------------------------------------------------------------- */

/**
 * The SPA loads a panel's full chapter list with two tiny tRPC queries:
 *   series.bySlugWithGenres({slug}) → numeric series id
 *   series.chapters({seriesId})     → every chapter in ~KBs of JSON
 * This replaces scanning ~260 chapter sitemaps (~26MB) for one panel.
 */

/** tRPC query url resolving a series slug → numeric series id. */
export function buildSeriesIdApiUrl(baseUrl: string, seriesSlug: string): string {
  const input = encodeURIComponent(JSON.stringify({ json: { slug: seriesSlug } }));
  return `${baseUrl}/api/trpc/series.bySlugWithGenres?input=${input}`;
}

/** tRPC query url for a series' complete chapter list. */
export function buildSeriesChaptersApiUrl(baseUrl: string, seriesId: number): string {
  const input = encodeURIComponent(JSON.stringify({ json: { seriesId } }));
  return `${baseUrl}/api/trpc/series.chapters?input=${input}`;
}

/** Parse the by-slug payload → numeric series id; null on unexpected shape. */
export function parseSeriesIdApi(body: string): number | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const id = (
      parsed as { result?: { data?: { json?: { id?: unknown } } } }
    )?.result?.data?.json?.id;
    return typeof id === 'number' && Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * The SPA's SearchPage genre picker is fed by `search.genres` (same auth +
 * session-cookie scheme as the other tRPC calls). Reverse-engineered from
 * the SearchPage client bundle: `search.genres.useQuery()`.
 */
export function buildGenreListApiUrl(baseUrl: string): string {
  const input = encodeURIComponent(JSON.stringify({ json: {} }));
  return `${baseUrl}/api/trpc/search.genres?input=${input}`;
}

/** Parse the search.genres payload → ordered genre names; [] on unexpected shape. */
export function parseGenreListApi(body: string): string[] {
  try {
    const parsed: unknown = JSON.parse(body);
    const rows = (parsed as { result?: { data?: { json?: unknown } } })?.result?.data?.json;
    if (!Array.isArray(rows)) return [];
    const seen = new Set<string>();
    const genres: string[] = [];
    for (const row of rows as Array<Record<string, unknown>>) {
      const name = typeof row['name'] === 'string' ? row['name'].trim() : '';
      if (!name || seen.has(name)) continue;
      seen.add(name);
      genres.push(name);
    }
    return genres;
  } catch {
    return [];
  }
}

/**
 * The SPA's own SearchPage searches server-side through `search.query`
 * (same auth + session-cookie scheme): free text plus include-genre
 * filters, sortable (`relevance` for text search, `recent` for the
 * newest-first feed). Reverse-engineered from the SearchPage client
 * bundle. Page size matches the adapter's latest feed.
 */
export const SEARCH_PAGE_SIZE = 20;

export interface SearchQueryFilters {
  q: string;
  sort: 'relevance' | 'recent';
  genres: string[];
  limit: number;
  offset: number;
  /** Author/artist filter — the SPA sends these as first-class `filters` keys. */
  credit?: { kind: 'author' | 'artist'; query: string };
}

export function buildSearchQueryApiUrl(baseUrl: string, params: SearchQueryFilters): string {
  const filters: Record<string, unknown> = {};
  if (params.genres.length > 0) filters['genres'] = params.genres;
  if (params.credit?.query.trim()) filters[params.credit.kind] = params.credit.query;
  const input = encodeURIComponent(
    JSON.stringify({
      json: {
        q: params.q,
        sort: params.sort,
        filters,
        limit: params.limit,
        offset: params.offset,
      },
    }),
  );
  return `${baseUrl}/api/trpc/search.query?input=${input}`;
}

export interface RawGenreSearchPage {
  items: RawListItem[];
  totalHits: number;
}

/**
 * Parse the search.query payload → list items with full metadata
 * (genres included — no enrichment pass needed). Null on unexpected
 * shape so the caller can fall back to the unfiltered listing.
 */
export function parseSearchQueryApi(
  body: string,
  baseUrl: string,
): RawGenreSearchPage | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const json = (
      parsed as { result?: { data?: { json?: Record<string, unknown> } } }
    )?.result?.data?.json;
    if (!json || typeof json !== 'object') return null;
    const rows = json['hits'];
    const totalHits = json['totalHits'];
    if (!Array.isArray(rows)) return null;
    const items: RawListItem[] = [];
    for (const row of rows as Array<Record<string, unknown>>) {
      const slug = typeof row['slug'] === 'string' ? row['slug'] : null;
      const title = typeof row['title'] === 'string' ? row['title'] : null;
      if (!slug || !title) continue;
      const genres = Array.isArray(row['genres'])
        ? (row['genres'] as unknown[]).filter(
            (g): g is string => typeof g === 'string' && g.trim().length > 0,
          )
        : [];
      const updatedAt =
        typeof row['updatedAt'] === 'number' && Number.isFinite(row['updatedAt'])
          ? new Date(row['updatedAt']).toISOString()
          : null;
      items.push({
        nativeId: slug,
        title,
        coverUrl: typeof row['coverUrl'] === 'string' ? row['coverUrl'] : null,
        sourceUrl: `${baseUrl}/manga/${encodeURIComponent(slug)}/`,
        status: normalizeStatus(typeof row['status'] === 'string' ? row['status'] : null),
        genres,
        summary: typeof row['synopsis'] === 'string' ? row['synopsis'] : null,
        latestChapterLabel: null,
        updatedAt,
      });
    }
    return {
      items,
      totalHits: typeof totalHits === 'number' && Number.isFinite(totalHits) ? totalHits : items.length,
    };
  } catch {
    return null;
  }
}

export interface RawSeriesDetails {
  seriesId: number;
  title: string;
  altTitles: string[];
  synopsis: string | null;
  coverUrl: string | null;
  status: PanelStatus;
  genres: string[];
  authors: string[];
  artists: string[];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Parse the `series.bySlugWithGenres` payload → rich panel metadata.
 * Returns null on ANY unexpected shape so callers keep the SSR fallback.
 * `alternativeTitles` arrives as a JSON-encoded string array — parsed
 * best-effort (a plain string falls back to a single entry).
 */
export function parseSeriesDetailsApi(body: string): RawSeriesDetails | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const json = (parsed as { result?: { data?: { json?: Record<string, unknown> } } })?.result
      ?.data?.json;
    if (!json || typeof json !== 'object') return null;
    const id = json['id'];
    if (typeof id !== 'number' || !Number.isFinite(id)) return null;

    const title = typeof json['title'] === 'string' ? json['title'].trim() : '';
    if (!title) return null;

    let altTitles: string[] = [];
    const rawAlt = json['alternativeTitles'];
    if (typeof rawAlt === 'string' && rawAlt.trim().length > 0) {
      try {
        const decoded: unknown = JSON.parse(rawAlt);
        if (Array.isArray(decoded)) altTitles = stringArray(decoded);
        else altTitles = [rawAlt.trim()];
      } catch {
        altTitles = [rawAlt.trim()];
      }
    } else if (Array.isArray(rawAlt)) {
      altTitles = stringArray(rawAlt);
    }

    const synopsis =
      typeof json['synopsis'] === 'string' && json['synopsis'].trim().length > 0
        ? json['synopsis'].trim()
        : null;
    const coverUrl = typeof json['coverUrl'] === 'string' ? json['coverUrl'] : null;

    return {
      seriesId: id,
      title,
      altTitles,
      synopsis,
      coverUrl,
      status: normalizeStatus(typeof json['status'] === 'string' ? json['status'] : null),
      genres: stringArray(json['genres']),
      authors: stringArray(json['authors']),
      artists: stringArray(json['artists']),
    };
  } catch {
    return null;
  }
}

/** Inverse of chapterNumberFromToken's Madara decimal encoding ("32.5" → "32-5"). */
function chapterTokenFromNumber(num: number): string {
  return String(num).replace('.', '-');
}

/**
 * Parse the trpc payload → RawChapterItem[] sorted ascending. Returns null on
 * ANY unexpected shape so callers can fall back to the sitemap scan.
 */
export function parseSeriesChaptersApi(
  body: string,
  panelNativeId: string,
  baseUrl: string,
): RawChapterItem[] | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const rows = (
      parsed as { result?: { data?: { json?: unknown } } }
    )?.result?.data?.json;
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const chapters: RawChapterItem[] = [];
    for (const row of rows as Array<Record<string, unknown>>) {
      if (row['isDeleted'] === true) continue;
      const num =
        typeof row['number'] === 'number' && Number.isFinite(row['number']) ? row['number'] : null;
      if (num === null) continue;

      const token = chapterTokenFromNumber(num);
      // Display decimals as "27.2" — the "-2" form is only URL encoding.
      const label = `Chapter ${num}`;
      const siteTitle =
        typeof row['title'] === 'string' && row['title'].trim().length > 0
          ? row['title'].trim()
          : null;
      chapters.push({
        nativeId: `${panelNativeId}~${token}`,
        panelNativeId,
        chapterToken: token,
        title: siteTitle ? `${label} · ${siteTitle}` : label,
        chapterNumber: num,
        sourceUrl: `${baseUrl}/manga/${encodeURIComponent(panelNativeId)}/${encodeURIComponent(token)}/`,
        publishedAt: parseIsoToIso(typeof row['createdAt'] === 'string' ? row['createdAt'] : null),
      });
    }
    if (chapters.length === 0) return null;

    // Wire order is newest-first; normalize to ascending like the sitemap path.
    chapters.sort((a, b) => (a.chapterNumber ?? Infinity) - (b.chapterNumber ?? Infinity));
    return chapters;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Latest-updates derivation from recent chapter sitemaps                      */
/* -------------------------------------------------------------------------- */

export interface RecentUpdateEntry {
  /** Panel slug, e.g. "lost-seven". */
  nativeId: string;
  /** Newest chapter url token, e.g. "12" or "12.5". */
  token: string;
  chapterNumber: number | null;
  /** ISO date of the chapter's sitemap lastmod (date-only precision). */
  publishedAt: string | null;
}

/**
 * Build the "recently updated" feed from chapter-sitemap bodies.
 *
 * New uploads always land in the newest sitemap-chapters-N.xml files, appended
 * roughly in upload order (verified: per-panel chapter numbers ascend within a
 * file). Passing the sitemaps OLDEST-FIRST yields a feed ordered newest-first,
 * deduplicated per panel (only its highest/latest entry survives).
 *
 * This mirrors the client-side "Recent Updates" grid the SPA renders
 * (cover + Ch.N + time ago) which has no SSR equivalent.
 */
export function parseRecentUpdatesFromSitemaps(xmls: string[]): RecentUpdateEntry[] {
  let seq = 0;
  const rec = new Map<string, RecentUpdateEntry & { seq: number }>();

  for (const xml of xmls) {
    for (const entry of parseSitemap(xml)) {
      const ref = readerRefFromUrl(entry.loc);
      if (!ref) continue;

      const candidateNum = chapterNumberFromToken(ref.token);
      const publishedAt = parseIsoToIso(entry.lastmod ?? null);
      const current = rec.get(ref.panelId);

      // Later documents/rows win outright; among equal-position duplicates
      // prefer the higher chapter number / fresher date.
      if (
        current &&
        ((candidateNum !== null &&
          current.chapterNumber !== null &&
          candidateNum < current.chapterNumber) ||
          (candidateNum === null && current.chapterNumber !== null))
      ) {
        rec.set(ref.panelId, { ...current, seq: seq++ });
        continue;
      }

      rec.set(ref.panelId, {
        nativeId: ref.panelId,
        token: ref.token,
        chapterNumber: candidateNum,
        publishedAt,
        seq: seq++,
      });
    }
  }

  return [...rec.values()].sort((a, b) => b.seq - a.seq).map(({ seq: _seq, ...entry }) => entry);
}

/**
 * Pick the N newest chapter-sitemap urls from a sitemap index. Ordering is by
 * numeric suffix — the index's own lastmod stamps are regeneration artifacts
 * (every entry shares the build date).
 */
export function pickNewestChapterSitemaps(urls: string[], count: number): string[] {
  const numbered = urls
    .map((url) => ({ url, n: /sitemap-chapters-(\d+)\.xml$/i.exec(url)?.[1] }))
    .filter((e): e is { url: string; n: string } => e.n !== undefined)
    .sort((a, b) => Number(b.n) - Number(a.n));
  return numbered.slice(0, Math.max(0, count)).map((e) => e.url);
}

/* -------------------------------------------------------------------------- */
/* Sitemap index parsing (namespace-agnostic via regex)                       */
/* -------------------------------------------------------------------------- */

export function parseSitemapIndex(xml: string): string[] {
  const sitemaps: string[] = [];
  const sitemapBlockRe = /<sitemap>([\s\S]*?)<\/sitemap>/g;
  for (const match of xml.matchAll(sitemapBlockRe)) {
    const block = match[1];
    if (block === undefined) continue;
    const loc = /<loc>([^<]+)<\/loc>/.exec(block)?.[1];
    if (loc) {
      sitemaps.push(loc.trim());
    }
  }
  return sitemaps;
}