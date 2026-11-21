import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import type { PanelStatus } from '@panel/shared';
import { pickCoverSrc } from '../coverImage.js';

/**
 * MangaKatana HTML parser.
 *
 * Pure functions: HTML string in → plain data out. No fetching, no global
 * state, no id prefixing (that is the source adapter's job). Every function
 * is defensive: the source is untrusted and its markup can change at any
 * time, so missing pieces degrade to nulls/empty arrays instead of throwing
 * — except when the page fundamentally is not what we asked for, which is
 * signalled via `PageNotRecognizedError` so the adapter can map it to a
 * proper "not found" API error.
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

export interface RawSearchItem {
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

export interface RawSearchPage {
  items: RawSearchItem[];
  /** Total result count when the page reports it ("Search results (N)"). */
  totalCount: number | null;
  hasMore: boolean;
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
  /** Native chapter id: "<panelNativeId>~<chapterToken>", e.g. "x.21708~c200". */
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
  /** Intrinsic "WxH" dimensions per page when exposed by the source. */
  dimensions: Array<{ width: number; height: number } | null>;
  /** All chapters listed in the chapter selector, in source order. */
  chapterOptions: Array<{ token: string; title: string }>;
  /** The token of the currently open chapter. */
  currentToken: string | null;
  /** "Panel - Chapter X" label from the reader container. */
  readerLabel: string | null;
  /** Cover image URL (og:image), used for continue-reading metadata. */
  coverUrl: string | null;
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

/** "solo-leveling.21708" from "https://mangakatana.com/manga/solo-leveling.21708". */
export function panelNativeIdFromUrl(url: string): string | null {
  const match = /\/manga\/([^/?#]+)/.exec(url);
  return match?.[1] ?? null;
}

/** { panelId: "solo-leveling.21708", token: "c200" } from a chapter URL. */
export function chapterRefFromUrl(url: string): { panelId: string; token: string } | null {
  const match = /\/manga\/([^/?#]+)\/(c[\d.]+)/i.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { panelId: match[1], token: match[2] };
}

export function chapterNumberFromToken(token: string): number | null {
  const match = /^c([\d.]+)$/i.exec(token);
  if (!match?.[1]) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Parse MangaKatana dates ("May-31-2023") into ISO strings. */
export function parseSourceDate(raw: string | null): string | null {
  if (!raw) return null;
  const match = /^([A-Za-z]{3,})-(\d{1,2})-(\d{4})$/.exec(raw.trim());
  if (!match) return null;
  const month = MONTHS[match[1]!.slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const day = Number.parseInt(match[2]!, 10);
  const year = Number.parseInt(match[3]!, 10);
  const date = new Date(Date.UTC(year, month, day));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeStatus(raw: string | null): PanelStatus {
  if (!raw) return 'unknown';
  const value = raw.trim().toLowerCase();
  if (value.includes('ongoing')) return 'ongoing';
  if (value.includes('completed') || value.includes('complete')) return 'completed';
  if (value.includes('hiatus')) return 'hiatus';
  if (value.includes('cancel') || value.includes('dropped')) return 'cancelled';
  return 'unknown';
}

/* -------------------------------------------------------------------------- */
/* Search page                                                                 */
/* -------------------------------------------------------------------------- */

export function parseSearchPage(html: string, baseUrl: string): RawSearchPage {
  const root = parseHtml(html);

  let totalCount: number | null = null;
  const widgetTitle = textOf(root.querySelector('.widget-title span'));
  const countMatch = widgetTitle ? /\((\d+)\)/.exec(widgetTitle) : null;
  if (countMatch?.[1]) totalCount = Number.parseInt(countMatch[1], 10);

  const items: RawSearchItem[] = [];
  for (const item of root.querySelectorAll('#book_list .item')) {
    const link = item.querySelector('.wrap_img a') ?? item.querySelector('h3.title a');
    const sourceUrl = absoluteUrl(link?.getAttribute('href'), baseUrl);
    const nativeId = sourceUrl
      ? (panelNativeIdFromUrl(sourceUrl) ?? item.getAttribute('data-id') ?? null)
      : null;

    const title = textOf(item.querySelector('h3.title a'));
    if (!sourceUrl || !nativeId || !title) continue; // skip malformed entries

    const img = item.querySelector('.wrap_img img');
    const coverUrl = absoluteUrl(img ? pickCoverSrc(img) : null, baseUrl);

    const genres = item
      .querySelectorAll('.genres a')
      .map((a) => textOf(a))
      .filter((g): g is string => g !== null);

    const latestChapterLabel =
      textOf(item.querySelector('.chapter a')) ?? textOf(item.querySelector('.date a'));
    const dateText =
      textOf(item.querySelector('.date')) ?? textOf(item.querySelector('.update_time'));

    items.push({
      nativeId,
      title,
      coverUrl,
      sourceUrl,
      status: normalizeStatus(textOf(item.querySelector('.status'))),
      genres,
      summary: textOf(item.querySelector('.summary')),
      latestChapterLabel,
      updatedAt: parseSourceDate(dateText),
    });
  }

  return { items, totalCount, hasMore: root.querySelector('.uk-pagination .next') !== null };
}

/**
 * Full genre catalog from the nav `Genres` sub-menu (rendered on every
 * page). Site order is kept; duplicates are dropped.
 */
export function parseGenreCatalog(html: string): string[] {
  const root = parseHtml(html);
  const seen = new Set<string>();
  const genres: string[] = [];
  for (const a of root.querySelectorAll('.sub-menu.genres a')) {
    const label = textOf(a);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    genres.push(label);
  }
  return genres;
}

/**
 * Nav genre index as label → absolute URL pairs (same markup as the
 * catalog). Lets `latestByGenre` resolve a dropdown label to the exact
 * genre slug instead of guessing it.
 */
export function parseGenreLinks(html: string, baseUrl: string): Array<{ label: string; href: string }> {
  const root = parseHtml(html);
  const links: Array<{ label: string; href: string }> = [];
  for (const a of root.querySelectorAll('.sub-menu.genres a')) {
    const label = textOf(a);
    const href = absoluteUrl(a.getAttribute('href'), baseUrl);
    if (!label || !href) continue;
    links.push({ label, href });
  }
  return links;
}

/* -------------------------------------------------------------------------- */
/* Panel details page                                                          */
/* -------------------------------------------------------------------------- */

export function parsePanelPage(html: string, sourceUrl: string, baseUrl: string): RawPanelDetails {
  const root = parseHtml(html);

  const book = root.querySelector('#single_book');
  if (!book) {
    // No book container → the site rendered a "not found"/error page.
    throw new PageNotRecognizedError('Panel page did not contain the book container.');
  }

  const heading = textOf(book.querySelector('h1.heading'));
  const ogTitle = root.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const title = heading ?? (ogTitle ? decodeEntities(ogTitle).trim() : null);
  if (!title) {
    throw new PageNotRecognizedError('Panel page did not contain a title.');
  }

  const nativeId = panelNativeIdFromUrl(sourceUrl) ?? '';

  const altRaw = textOf(book.querySelector('.alt_name'));
  const altTitles = altRaw
    ? altRaw
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const authors = book
    .querySelectorAll('.authors a.author')
    .map((a) => textOf(a))
    .filter((a): a is string => a !== null);

  const genres = book
    .querySelectorAll('.genres a')
    .map((a) => textOf(a))
    .filter((g): g is string => g !== null);

  const coverImg = book.querySelector('.cover img');
  const coverUrl =
    absoluteUrl(coverImg ? pickCoverSrc(coverImg) : null, baseUrl) ??
    absoluteUrl(root.querySelector('meta[property="og:image"]')?.getAttribute('content'), baseUrl);

  const description =
    textOf(book.querySelector('.summary p')) ?? textOf(root.querySelector('.summary p'));

  return {
    nativeId,
    title,
    altTitles,
    authors,
    artists: [],
    genres,
    status: normalizeStatus(textOf(book.querySelector('.value.status'))),
    description,
    coverUrl,
    sourceUrl,
    latestChapterLabel: textOf(book.querySelector('.value.new_chap')),
  };
}

/* -------------------------------------------------------------------------- */
/* Chapter list (on the panel page)                                            */
/* -------------------------------------------------------------------------- */

export function parseChapterList(html: string, baseUrl: string): RawChapterItem[] {
  const root = parseHtml(html);
  const rows = root.querySelectorAll('.chapters table tbody tr');
  const chapters: RawChapterItem[] = [];

  for (const row of rows) {
    const link = row.querySelector('.chapter a');
    const sourceUrl = absoluteUrl(link?.getAttribute('href'), baseUrl);
    const title = textOf(link);
    if (!sourceUrl || !title) continue;

    const ref = chapterRefFromUrl(sourceUrl);
    if (!ref) continue;

    chapters.push({
      nativeId: `${ref.panelId}~${ref.token}`,
      panelNativeId: ref.panelId,
      chapterToken: ref.token,
      title,
      chapterNumber: chapterNumberFromToken(ref.token),
      sourceUrl,
      publishedAt: parseSourceDate(textOf(row.querySelector('.update_time'))),
    });
  }

  return chapters;
}

/* -------------------------------------------------------------------------- */
/* Chapter reader page                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Extract every `var name = [ ... ]` literal from inline scripts and return
 * its string entries. MangaKatana embeds page URLs in obfuscated variable
 * names (e.g. `ytaw`, `thzq`) that change over time, so we never match a
 * specific name — we pick the longest array of image URLs instead.
 */
function extractScriptArrays(html: string): string[][] {
  const arrays: string[][] = [];
  const varArrayRe =
    /var\s+[A-Za-z_$][\w$]*\s*=\s*\[((?:[^[\]'"\\]|\\.|"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')*)\]/g;

  for (const match of html.matchAll(varArrayRe)) {
    const body = match[1];
    if (!body) continue;
    const entries: string[] = [];
    const entryRe = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
    for (const entryMatch of body.matchAll(entryRe)) {
      const value = entryMatch[1] ?? entryMatch[2];
      if (value !== undefined) entries.push(value.replace(/\\(['"\\])/g, '$1'));
    }
    if (entries.length > 0) arrays.push(entries);
  }
  return arrays;
}

function looksLikeImageUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  return /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i.test(value) || value.includes('/token/');
}

export function parseChapterReaderPage(html: string, baseUrl: string): RawChapterPages {
  const root = parseHtml(html);

  const readerContainer = root.querySelector('#imgs');
  const coverUrl = absoluteUrl(
    root.querySelector('meta[property="og:image"]')?.getAttribute('content'),
    baseUrl,
  );
  const arrays = extractScriptArrays(html);

  // Page URLs: the longest array whose entries look like image URLs.
  const imageArrays = arrays
    .map((entries) => entries.filter(looksLikeImageUrl))
    .filter((entries) => entries.length > 0)
    .sort((a, b) => b.length - a.length);
  const imageUrls = imageArrays[0] ?? [];

  // Dimensions: an array whose entries all look like "800x3000".
  const dimensionArrays = arrays.filter(
    (entries) => entries.length > 0 && entries.every((e) => /^\d+x\d+$/.test(e)),
  );
  const dimensionEntries = dimensionArrays.sort((a, b) => b.length - a.length)[0] ?? [];
  const dimensions = dimensionEntries.map((entry) => {
    const [w, h] = entry.split('x').map((n) => Number.parseInt(n, 10));
    return w && h ? { width: w, height: h } : null;
  });

  // Chapter navigation: the reader's chapter <select>.
  const chapterOptions: Array<{ token: string; title: string }> = [];
  let currentToken: string | null = null;
  const select =
    root.querySelector('select.chapter_select') ??
    root.querySelector('select[name="chapter_select"]');
  if (select) {
    for (const option of select.querySelectorAll('option')) {
      const value = option.getAttribute('value') ?? '';
      const label = textOf(option);
      if (!value || !label) continue;
      chapterOptions.push({ token: value, title: label });
      if (option.hasAttribute('selected')) currentToken = value;
    }
  }

  const readerLabel = readerContainer?.getAttribute('data-alt') ?? null;

  if (imageUrls.length === 0 && !readerContainer && chapterOptions.length === 0) {
    // Nothing reader-like on the page at all → not a chapter page.
    throw new PageNotRecognizedError('Chapter page did not contain reader data.');
  }

  return {
    imageUrls,
    dimensions,
    chapterOptions,
    currentToken,
    readerLabel: readerLabel ? decodeEntities(readerLabel).trim() : null,
    coverUrl,
  };
}
