import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import type { PanelStatus } from '@panel/shared';
import { pickCoverSrc } from '../coverImage.js';

/**
 * Rawkuma (rawkuma.net) HTML parser.
 *
 * rawkuma.net is a WordPress site with a fully custom Tailwind/HTMX theme
 * (NOT Madara). Pure functions: HTML string in → plain data out. No fetching,
 * no global state, no id prefixing (that is the source adapter's job).
 *
 * Everything is defensive, mirroring the NihonKuni parsers: the
 * source is untrusted and its markup can change at any time, so missing pieces
 * degrade to nulls/empty arrays instead of throwing — except when the page
 * fundamentally is not what we asked for, which is signalled via
 * `PageNotRecognizedError` so the adapter can map it to a proper "not found"
 * API error.
 *
 * Selectors were verified against live pages (2026-08) and are kept in one
 * place (this file) so a site redesign only touches this module.
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
  /** Native chapter id: "<panelSlug>~chapter-<label>.<postId>". */
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
  /** Panel title from JSON-LD / the <title> tag. */
  panelTitle: string | null;
  /** "Chapter 52" heading from the <title> tag / JSON-LD. */
  readerLabel: string | null;
  /** Cover image URL (og:image), used for continue-reading metadata. */
  coverUrl: string | null;
  /** ISO timestamp from the entry-date meta (only present on reader pages). */
  publishedAt: string | null;
  /** Previous (older) chapter from the `aria-label="Prev"` link. */
  prevRef: { panelId: string; token: string } | null;
  /** Next (newer) chapter from the `aria-label="Next"` link. */
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

/** Decode the common HTML entities (node-html-parser keeps them raw). */
export function decodeEntities(input: string): string {
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

/** ISO datetime string (e.g. "2026-08-19T13:59:36+00:00") → normalized ISO. */
function parseIsoToIso(raw: string | null): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** "one-piece" from "https://rawkuma.net/manga/one-piece/". */
export function panelNativeIdFromUrl(url: string): string | null {
  const match = /\/manga\/([^/?#]+)\/?$/i.exec(url);
  return match?.[1] ?? null;
}

/**
 * { panelId: "one-piece", token: "chapter-1190.12345" } from a chapter URL:
 *   "https://rawkuma.net/manga/one-piece/chapter-1190.12345/"
 * The postId suffix is REQUIRED by the site's routing and semantically
 * meaningful (a wrong postId serves a different series), so it is preserved
 * in the token.
 */
export function readerRefFromUrl(url: string): { panelId: string; token: string } | null {
  const match = /\/manga\/([^/?#]+)\/chapter-([\d.]+)\.(\d+)\/?$/i.exec(url);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return { panelId: match[1], token: `chapter-${match[2]}.${match[3]}` };
}

/**
 * "chapter-52.299262" → 52, "chapter-37.1.341581" → 37.1 (the trailing
 * `.341581` is the WordPress post id, not a decimal), "chapter-0.5" → 0.5,
 * anything else → null.
 */
export function chapterNumberFromToken(token: string): number | null {
  const match = /^chapter-([\d.]+)\.(\d+)$/i.exec(token);
  if (!match) return null;
  const num = Number(match[1]!);
  return Number.isFinite(num) ? num : null;
}

export function normalizeStatus(raw: string | null): PanelStatus {
  if (!raw) return 'unknown';
  const value = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (value.includes('ongoing')) return 'ongoing';
  if (value.includes('completed') || value.includes('complete')) return 'completed';
  if (value.includes('hiatus')) return 'hiatus';
  if (value.includes('cancel') || value.includes('drop')) return 'cancelled';
  return 'unknown';
}

/** Extract the rotating `search_nonce` from the get_nonce endpoint. */
export function decodeNonce(html: string): string | null {
  const forward = /name=["']search_nonce["'][^>]*value=["']([^"']+)["']/i.exec(html);
  const reversed = /value=["']([^"']+)["'][^>]*name=["']search_nonce["']/i.exec(html);
  const value = forward?.[1] ?? reversed?.[1];
  return value && value.length > 0 ? value : null;
}

/**
 * Genre terms (`{name, slug}` in site order) from the library page's
 * embedded `var searchTerms` JSON (`{"genre": {"0": {...}, ...}}`).
 * Backs both the filter-dropdown catalog and server-side genre filtering
 * (the library filter speaks slugs). Empty on absent/malformed payload.
 */
export function parseGenreTerms(html: string): Array<{ name: string; slug: string }> {
  return parseTaxonomyTerms(html, 'genre');
}

/**
 * Author/artist terms (`{name, slug}` in site order) from the library
 * page's embedded `var searchTerms` JSON. The library speaks slugs; the
 * caller resolves free-text queries to term slugs itself (substring on
 * the name column). Empty on absent/malformed payload.
 */
export function parseTaxonomyTerms(
  html: string,
  taxonomy: 'genre' | 'type' | 'status' | 'series-author' | 'artist',
): Array<{ name: string; slug: string }> {
  const match = /var\s+searchTerms\s*=\s*(\{.*?\})\s*;?\s*<\/script>/s.exec(html);
  if (!match?.[1]) return [];
  try {
    const data = JSON.parse(match[1]) as {
      [key: string]: Record<string, { name?: unknown; slug?: unknown }> | undefined;
    };
    const group = data[taxonomy];
    if (!group || typeof group !== 'object') return [];
    const seen = new Set<string>();
    const terms: Array<{ name: string; slug: string }> = [];
    for (const term of Object.values(group)) {
      const name = typeof term?.name === 'string' ? term.name.trim() : '';
      const slug = typeof term?.slug === 'string' ? term.slug.trim() : '';
      if (!name || !slug || seen.has(name)) continue;
      seen.add(name);
      terms.push({ name, slug });
    }
    return terms;
  } catch {
    return [];
  }
}

/**
 * Full genre catalog from the library page's embedded `var searchTerms`
 * JSON. Display names are used verbatim (site order, duplicates dropped);
 * anything unparseable yields [] so the UI falls back to page-derived
 * genres.
 */
export function parseGenreCatalog(html: string): string[] {
  return parseGenreTerms(html).map((term) => term.name);
}

/* -------------------------------------------------------------------------- */
/* JSON-LD helpers (author/status live only in the ComicSeries block)          */
/* -------------------------------------------------------------------------- */

function jsonLdObjects(root: HTMLElement): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = (script.text ?? '').trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        if (item && typeof item === 'object') out.push(item as Record<string, unknown>);
      }
    } catch {
      // Malformed JSON-LD blocks are ignored.
    }
  }
  return out;
}

function hasType(value: unknown, type: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const t = (value as Record<string, unknown>)['@type'];
  if (Array.isArray(t)) return t.includes(type);
  return t === type;
}

function findJsonLd(root: HTMLElement, type: string): Record<string, unknown> | null {
  return jsonLdObjects(root).find((o) => hasType(o, type)) ?? null;
}

function nameOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object') {
    const n = (value as Record<string, unknown>).name;
    return typeof n === 'string' ? n.trim() || null : null;
  }
  return null;
}

function statusFromJsonLd(series: Record<string, unknown> | null): PanelStatus {
  if (!series) return 'unknown';
  const status = typeof series.creativeWorkStatus === 'string' ? series.creativeWorkStatus : null;
  if (status) return normalizeStatus(status);
  if (series.isCompleted === true) return 'completed';
  if (series.isCompleted === false) return 'ongoing';
  return 'unknown';
}

function authorsFromJsonLd(series: Record<string, unknown> | null): string[] {
  if (!series) return [];
  const author = series.author;
  const name = nameOf(author);
  return name ? [name] : [];
}

/* -------------------------------------------------------------------------- */
/* Latest archive page (`/latest-update/?the_page=N`)                          */
/* -------------------------------------------------------------------------- */

export function parseListPage(html: string, baseUrl: string): RawListItem[] {
  const root = parseHtml(html);
  const items: RawListItem[] = [];

  for (const card of root.querySelectorAll('#search-results > div')) {
    const titleLink = card.querySelector('a[href*="/manga/"] h1')?.parentNode as
      HTMLElement | undefined;
    const sourceUrl = absoluteUrl(titleLink?.getAttribute('href'), baseUrl);
    const nativeId = sourceUrl ? panelNativeIdFromUrl(sourceUrl) : null;
    const title = textOf(titleLink?.querySelector('h1'));
    if (!sourceUrl || !nativeId || !title) continue;

    const chapterLink = card.querySelector('a[href*="/chapter-"]');
    const cover =
      card.querySelector('img[src*="/wp-content/uploads/"]') ?? card.querySelector('img');

    items.push({
      nativeId,
      title,
      coverUrl: absoluteUrl(cover ? pickCoverSrc(cover) : null, baseUrl),
      sourceUrl,
      status: normalizeStatus(textOf(card.querySelector('p.font-normal.text-xs'))),
      genres: [],
      summary: null,
      latestChapterLabel: textOf(chapterLink?.querySelector('p.inline-block')),
      updatedAt: parseIsoToIso(
        chapterLink?.querySelector('time[datetime]')?.getAttribute('datetime') ?? null,
      ),
    });
  }

  return items;
}

/**
 * Pagination: plain `a[href*="the_page="]` links; the last page renders no
 * pagination links at all, so `hasMore` = any page link beyond the current one.
 */
export function hasNextPage(html: string, currentPage: number): boolean {
  const root = parseHtml(html);
  let max = 0;
  for (const a of root.querySelectorAll('a[href*="the_page="]')) {
    const match = /the_page=(\d+)/i.exec(a.getAttribute('href') ?? '');
    if (match) max = Math.max(max, Number.parseInt(match[1]!, 10));
  }
  return max > currentPage;
}

/* -------------------------------------------------------------------------- */
/* Search results (POST admin-ajax advanced_search fragment)                   */
/* -------------------------------------------------------------------------- */

export function parseSearchPage(html: string, baseUrl: string): RawListItem[] {
  const root = parseHtml(html);
  const items: RawListItem[] = [];

  // Each result is an outer wrapper holding a horizontal card variant
  // (`flex rounded-lg overflow-hidden`) plus a vertical one. Reading the
  // horizontal variant once per result is enough.
  for (const card of root.querySelectorAll('div.flex.rounded-lg.overflow-hidden')) {
    const titleLink = card.querySelector('a.text-base.font-medium');
    const sourceUrl = absoluteUrl(titleLink?.getAttribute('href'), baseUrl);
    const nativeId = sourceUrl ? panelNativeIdFromUrl(sourceUrl) : null;
    const title = textOf(titleLink);
    if (!sourceUrl || !nativeId || !title) continue;

    const coverImg =
      card.querySelector('img.wp-post-image') ?? card.querySelector('img');
    items.push({
      nativeId,
      title,
      coverUrl: absoluteUrl(coverImg ? pickCoverSrc(coverImg) : null, baseUrl),
      sourceUrl,
      status: normalizeStatus(textOf(card.querySelector('span.bg-accent.text-xs'))),
      genres: [],
      summary: null,
      latestChapterLabel: textOf(card.querySelector('span.text-sm.text-gray-300')),
      updatedAt: null, // search cards do not expose timestamps
    });
  }

  return items;
}

/* -------------------------------------------------------------------------- */
/* Panel details page                                                          */
/* -------------------------------------------------------------------------- */

export function parsePanelPage(html: string, sourceUrl: string, baseUrl: string): RawPanelDetails {
  const root = parseHtml(html);

  const title = textOf(root.querySelector('h1[itemprop="name"]'));
  if (!title) {
    throw new PageNotRecognizedError('Panel page did not contain a title.');
  }

  const series = findJsonLd(root, 'ComicSeries');
  const cover = root.querySelector('div[itemprop="image"] img');
  const latestRow = root.querySelector('#chapter-list div[data-chapter-number]');

  return {
    nativeId: panelNativeIdFromUrl(sourceUrl) ?? '',
    title,
    altTitles: (textOf(root.querySelector('div.block.text-sm.text-text.line-clamp-1')) ?? '')
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean),
    authors: authorsFromJsonLd(series),
    artists: [],
    genres: root
      .querySelectorAll('a[itemprop="genre"]')
      .map((a) => textOf(a))
      .filter((t): t is string => t !== null),
    status: statusFromJsonLd(series),
    description:
      textOf(root.querySelector('div[itemprop="description"][data-show="false"]')) ??
      textOf(root.querySelector('div[itemprop="description"][data-show="true"]')),
    coverUrl:
      absoluteUrl(cover ? pickCoverSrc(cover) : null, baseUrl) ??
      absoluteUrl(root.querySelector('meta[property="og:image"]')?.getAttribute('content'), baseUrl),
    sourceUrl,
    latestChapterLabel: textOf(latestRow?.querySelector('div[class*="font-medium"] span')),
  };
}

/* -------------------------------------------------------------------------- */
/* Chapter list (on the panel page — fully server-rendered)                    */
/* -------------------------------------------------------------------------- */

export function parseChapterList(html: string, baseUrl: string): RawChapterItem[] {
  const root = parseHtml(html);
  const chapters: RawChapterItem[] = [];

  for (const row of root.querySelectorAll('#chapter-list div[data-chapter-number]')) {
    const a = row.querySelector('a[href*="/chapter-"]');
    const href = a?.getAttribute('href');
    const sourceUrl = absoluteUrl(href, baseUrl);
    const ref = href ? readerRefFromUrl(href) : null;
    const title = textOf(row.querySelector('div[class*="font-medium"] span')) ?? textOf(a);
    if (!sourceUrl || !ref || !title) continue;

    chapters.push({
      nativeId: `${ref.panelId}~${ref.token}`,
      panelNativeId: ref.panelId,
      chapterToken: ref.token,
      title,
      chapterNumber: chapterNumberFromToken(ref.token),
      sourceUrl,
      publishedAt: parseIsoToIso(
        row.querySelector('time[datetime]')?.getAttribute('datetime') ?? null,
      ),
    });
  }

  return chapters;
}

/* -------------------------------------------------------------------------- */
/* Chapter reader page                                                         */
/* -------------------------------------------------------------------------- */

export function parseChapterReaderPage(html: string, baseUrl: string): RawChapterPages {
  const root = parseHtml(html);

  const imageUrls: string[] = [];
  for (const img of root.querySelectorAll('section[data-image-data] img')) {
    const url = absoluteUrl((img.getAttribute('src') ?? '').trim() || null, baseUrl);
    if (url) imageUrls.push(url);
  }

  const story = findJsonLd(root, 'ComicStory') ?? findJsonLd(root, 'ComicIssue');
  const titleTag = textOf(root.querySelector('title'));
  // <title> ends with an en/em-dash + site name ("… – Rawkuma"). Plain
  // hyphens appear INSIDE titles/chapter labels, so never split on "-";
  // take everything before the first en/em-dash as the page head.
  const head =
    titleTag
      ?.split(/[–—]/)
      .map((s) => s.trim())
      .filter(Boolean)[0] ?? null;

  const position = typeof story?.position === 'number' ? story.position : null;
  const seriesName = nameOf(story?.isPartOf);
  // Fallback series name: the head minus any trailing "Chapter …" segment
  // ("Tentacle Hole Chapter 4" → "Tentacle Hole").
  const panelTitle =
    seriesName ?? (head ? head.replace(/\s+chapter\b.*$/i, '').trim() || null : null);

  // Chapter label: JSON-LD chapter name with the series prefix stripped
  // ("Tentacle Hole Chapter 4" → "Chapter 4"), then "Chapter <position>",
  // then the bare head.
  let readerLabel: string | null = null;
  if (seriesName && head?.startsWith(`${seriesName} `)) {
    readerLabel = head.slice(seriesName.length + 1).trim() || null;
  }
  if (!readerLabel && position != null) {
    readerLabel = `Chapter ${position}`;
  }
  if (!readerLabel) {
    readerLabel = head ?? nameOf(story);
  }

  const coverEl = root.querySelector('a[href*="/manga/"] img.wp-post-image');
  const coverUrl =
    absoluteUrl(
      root.querySelector('meta[property="og:image"]')?.getAttribute('content'),
      baseUrl,
    ) ?? absoluteUrl(coverEl ? pickCoverSrc(coverEl) : null, baseUrl);

  const publishedAt = parseIsoToIso(
    root.querySelector('time.entry-date[itemprop="datePublished"]')?.getAttribute('datetime') ??
      root.querySelector('time[itemprop="dateCreated"]')?.getAttribute('datetime') ??
      null,
  );

  // Navigation links. `href="#"` + disabled classes mark the series edge; a
  // cross-panel href would be a broken/placeholder link — both → null.
  const prevRef = refFromNavLink(root.querySelector('a[aria-label="Prev"]'));
  const nextRef = refFromNavLink(root.querySelector('a[aria-label="Next"]'));

  if (imageUrls.length === 0 && !readerLabel && !panelTitle) {
    // Nothing reader-like on the page at all → not a chapter page.
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

function refFromNavLink(el: HTMLElement | null): { panelId: string; token: string } | null {
  const href = el?.getAttribute('href');
  if (!href || href === '#' || href.trim() === '') return null;
  return readerRefFromUrl(href);
}
