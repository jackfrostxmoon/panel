import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import type { PanelStatus } from '@panel/shared';
import { cleanGenreLabel } from '../../lib/text.js';
import { pickCoverSrc } from '../coverImage.js';

function extractScriptArrays(html: string): string[][] {
  const arrays: string[][] = [];
  const varArrayRe =
    /(?:var\s+)?[A-Za-z_$][\w$]*\s*=\s*\[((?:[^[\]'"\\]|\\.|"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')*)\]/g;

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

/**
 * RawUwU (rawuwu.net) parser.
 *
 * Same site engine as RawSakura, different URL layout (verified 2026-09):
 *   search:   GET {base}/spa/search?query=<query>&page=<n>      (SPA JSON API)
 *   latest:   GET {base}/spa/latest-manga?page=<n>              (SPA JSON API)
 *             HTML fallback: GET {base}/latest?page=<n>
 *   panel:    GET {base}/raw/<numericId>
 *             SPA detail: GET {base}/spa/manga/<numericId>
 *   chapter:  GET {base}/read/<numericId>/chapter-<num>
 *             SPA reader: GET {base}/spa/manga/<numericId>/<num>
 *
 * Native panel id: "<digits>" (e.g., "870369")
 * Native chapter id: "<digits>~chapter-<num>" (e.g., "870369~chapter-78")
 *
 * All HTML/JSON parsing lives in this file — pure functions: input string in,
 * plain data out. No fetching, no global state, no id prefixing (that is
 * the source adapter's job).
 *
 * Everything is defensive: the source is untrusted and its markup can change
 * at any time, so missing pieces degrade to nulls/empty arrays instead of
 * throwing — except when the page fundamentally is not what we asked for,
 * which is signalled via `PageNotRecognizedError` so the adapter can map it
 * to a proper "not found" API error.
 *
 * Selectors are kept in one place (this file) so a site redesign only
 * touches this module.
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
  chapterOptions: Array<{ token: string; title: string }>;
  currentToken: string | null;
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

/** ISO datetime string (e.g. "2026-09-13T14:15:27.000Z") → normalized ISO. */
function parseIsoToIso(raw: string | null): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** "870369" from "https://rawuwu.net/raw/870369" or "/raw/870369". */
export function panelNativeIdFromUrl(url: string): string | null {
  const match = /\/raw\/(\d+)/i.exec(url);
  return match?.[1] ?? null;
}

/**
 * { panelId: "870369", token: "chapter-78" } from a chapter URL:
 *   "https://rawuwu.net/read/870369/chapter-78"
 */
export function readerRefFromUrl(url: string): { panelId: string; token: string } | null {
  const match = /\/read\/(\d+)\/chapter-([\d.]+)/i.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { panelId: match[1], token: `chapter-${match[2]}` };
}

/**
 * "chapter-78" → 78, "chapter-30.2" → 30.2, anything else → null.
 */
export function chapterNumberFromToken(token: string): number | null {
  const match = /^chapter-([\d.]+)$/i.exec(token);
  if (!match) return null;
  const num = Number(match[1]!);
  return Number.isFinite(num) ? num : null;
}

/**
 * Normalize a chapter dropdown label to the repo's "Chapter N" convention.
 *
 * RawUwU's chapter `<option>` text is a bare "#78" / "#30.2"; everywhere
 * else in the app chapters render as "Chapter N". Returning the raw "#N"
 * leaks into the Continue Reading label on the panel details page. Promote a
 * lone "#<number>" (optionally with a fractional part) to "Chapter <number>"
 * and pass anything else through untouched so real chapter titles survive.
 */
export function normalizeChapterLabel(raw: string): string {
  const match = /^#\s*(\d+(?:\.\d+)?)$/.exec(raw.trim());
  return match ? `Chapter ${match[1]}` : raw;
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

/* -------------------------------------------------------------------------- */
/* Latest archive page (`/latest`) — HTML fallback                             */
/* -------------------------------------------------------------------------- */

export function parseListPage(html: string, baseUrl: string): RawListItem[] {
  const root = parseHtml(html);
  const items: RawListItem[] = [];

  // Each panel item is in .m-item within .manga-list.style2
  for (const card of root.querySelectorAll('.manga-list.style2 .m-item')) {
    const titleLink = card.querySelector('.m-title a');
    const sourceUrl = absoluteUrl(titleLink?.getAttribute('href'), baseUrl);
    const nativeId = sourceUrl ? panelNativeIdFromUrl(sourceUrl) : null;
    const title = textOf(titleLink);
    if (!sourceUrl || !nativeId || !title) continue;

    const cover = card.querySelector('.m-img img');
    const coverUrl = absoluteUrl(cover ? pickCoverSrc(cover) : null, baseUrl);

    // Get latest chapter from the chapter list
    const chapterLink = card.querySelector('.m-chapters ul li:first-child a');
    const latestChapterLabel = textOf(chapterLink);

    // Get time from the span next to the chapter link
    const timeEl = card.querySelector('.m-chapters ul li:first-child span');
    const updatedAt = parseIsoToIso(timeEl?.getAttribute('datetime') ?? null) ?? parseIsoToIso(textOf(timeEl));

    items.push({
      nativeId,
      title,
      coverUrl,
      sourceUrl,
      status: 'unknown', // Status not shown on latest page
      genres: [],
      summary: null,
      latestChapterLabel,
      updatedAt,
    });
  }

  return items;
}

/**
 * Full genre catalog from the nav `Genre` dropdown (`/genre/<id>/<name>`
 * links, rendered on every page). The link `title` attribute carries the
 * display label; anchor text is the fallback. Site order is kept;
 * duplicates are dropped.
 */
export function parseGenreCatalog(html: string): string[] {
  const root = parseHtml(html);
  const seen = new Set<string>();
  const genres: string[] = [];
  for (const a of root.querySelectorAll('li.genres .dropdown .inner a')) {
    const href = a.getAttribute('href') ?? '';
    if (!href.startsWith('/genre/')) continue;
    const label = cleanGenreLabel(a.getAttribute('title')?.trim() || textOf(a));
    if (!label || seen.has(label)) continue;
    seen.add(label);
    genres.push(label);
  }
  return genres;
}

/**
 * Nav genre index as label → absolute archive-URL pairs (same markup as
 * the catalog). The archive path embeds an opaque numeric id, so labels
 * can only be resolved through this index — never by guessing URLs.
 * Labels are cleaned identically so dropdown values resolve exactly.
 */
export function parseGenreLinks(html: string, baseUrl: string): Array<{ label: string; href: string }> {
  const root = parseHtml(html);
  const links: Array<{ label: string; href: string }> = [];
  for (const a of root.querySelectorAll('li.genres .dropdown .inner a')) {
    const rawHref = a.getAttribute('href') ?? '';
    if (!rawHref.startsWith('/genre/')) continue;
    const label = cleanGenreLabel(a.getAttribute('title')?.trim() || textOf(a));
    const href = absoluteUrl(rawHref, baseUrl);
    if (!label || !href) continue;
    links.push({ label, href });
  }
  return links;
}

/**
 * Pagination: plain `a[href*="page="]` or similar; the last page renders no
 * pagination links at all, so `hasMore` = any page link beyond the current one.
 */
export function hasNextPage(html: string, currentPage: number): boolean {
  const root = parseHtml(html);
  let max = 0;
  for (const a of root.querySelectorAll('a[href*="page="]')) {
    const match = /page=(\d+)/i.exec(a.getAttribute('href') ?? '');
    if (match) max = Math.max(max, Number.parseInt(match[1]!, 10));
  }
  return max > currentPage;
}

/* -------------------------------------------------------------------------- */
/* Search results (`/tag?query=...`) — HTML fallback                           */
/* -------------------------------------------------------------------------- */

export function parseSearchPage(html: string, baseUrl: string): RawListItem[] {
  const root = parseHtml(html);
  const items: RawListItem[] = [];

  // Search results have the same structure as latest page
  for (const card of root.querySelectorAll('.manga-list.style2 .m-item')) {
    const titleLink = card.querySelector('.m-title a');
    const sourceUrl = absoluteUrl(titleLink?.getAttribute('href'), baseUrl);
    const nativeId = sourceUrl ? panelNativeIdFromUrl(sourceUrl) : null;
    const title = textOf(titleLink);
    if (!sourceUrl || !nativeId || !title) continue;

    const cover = card.querySelector('.m-img img');
    const coverUrl = absoluteUrl(cover ? pickCoverSrc(cover) : null, baseUrl);

    const chapterLink = card.querySelector('.m-chapters ul li:first-child a');
    const latestChapterLabel = textOf(chapterLink);

    const timeEl = card.querySelector('.m-chapters ul li:first-child span');
    const updatedAt = parseIsoToIso(timeEl?.getAttribute('datetime') ?? null) ?? parseIsoToIso(textOf(timeEl));

    items.push({
      nativeId,
      title,
      coverUrl,
      sourceUrl,
      status: 'unknown',
      genres: [],
      summary: null,
      latestChapterLabel,
      updatedAt,
    });
  }

  return items;
}

/* -------------------------------------------------------------------------- */
/* Panel details page (`/raw/<id>`) — HTML fallback                            */
/* -------------------------------------------------------------------------- */

export function parsePanelPage(html: string, sourceUrl: string, baseUrl: string): RawPanelDetails {
  const root = parseHtml(html);

  const title = textOf(root.querySelector('h1.manga-title'));
  if (!title) {
    throw new PageNotRecognizedError('Panel page did not contain a title.');
  }

  const nativeId = panelNativeIdFromUrl(sourceUrl) ?? '';

  // Alternative titles from .manga-others-name
  const altTitlesText = textOf(root.querySelector('.manga-others-name .inner h2'));
  const altTitles = altTitlesText
    ? altTitlesText.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  // Description from .manga-description
  const description = textOf(root.querySelector('.manga-description .inner'));

  // Cover image
  const cover = root.querySelector('.manga-img .img-holder img');
  const coverUrl =
    absoluteUrl(cover ? pickCoverSrc(cover) : null, baseUrl) ??
    absoluteUrl(root.querySelector('meta[property="og:image"]')?.getAttribute('content'), baseUrl);

  // Genres from JSON-LD BreadcrumbList (there are multiple for each genre)
  const genres: string[] = [];
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = (script.text ?? '').trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed['@type'] === 'BreadcrumbList' && Array.isArray(parsed.itemListElement)) {
        for (const item of parsed.itemListElement) {
          if (item.item?.name && typeof item.item.name === 'string') {
            const genre = cleanGenreLabel(item.item.name);
            if (genre && !genres.includes(genre)) {
              genres.push(genre);
            }
          }
        }
      }
    } catch {
      // Malformed JSON-LD blocks are ignored.
    }
  }

  // Status from the Status row (`.md-title` "Status:" + `.md-content` value).
  let status: PanelStatus = 'unknown';
  for (const li of root.querySelectorAll('.manga-detail ul li')) {
    if (textOf(li.querySelector('.md-title'))?.toLowerCase().startsWith('status') ?? false) {
      status = normalizeStatus(textOf(li.querySelector('.md-content')));
      break;
    }
  }

  // Latest chapter from the panel actions
  const latestLink = root.querySelector('.manga-actions a[title^="Read Latest"]');
  const latestChapterLabel = textOf(latestLink);

  return {
    nativeId,
    title,
    altTitles,
    authors: [], // Not available
    artists: [], // Not available
    genres,
    status,
    description,
    coverUrl,
    sourceUrl,
    latestChapterLabel,
  };
}

/* -------------------------------------------------------------------------- */
/* Chapter list (on the panel page or from reader sidebar)                     */
/* -------------------------------------------------------------------------- */

export function parseChapterList(html: string, baseUrl: string, sourceUrl?: string): RawChapterItem[] {
  const root = parseHtml(html);
  const chapters: RawChapterItem[] = [];

  // The panel detail page renders the full chapter list server-side.
  for (const a of root.querySelectorAll('.manga-chapters ul li a[href*="/read/"]')) {
    const href = a.getAttribute('href');
    const ref = href ? readerRefFromUrl(href) : null;
    const title = textOf(a.querySelector('.chapter')) ?? textOf(a);
    if (!href || !ref || !title) continue;
    const timeEl = a.querySelector('.ctime');
    chapters.push({
      nativeId: `${ref.panelId}~${ref.token}`,
      panelNativeId: ref.panelId,
      chapterToken: ref.token,
      title,
      chapterNumber: chapterNumberFromToken(ref.token),
      sourceUrl: absoluteUrl(href, baseUrl)!,
      publishedAt: parseIsoToIso(timeEl?.getAttribute('datetime') ?? null) ?? parseIsoToIso(textOf(timeEl)),
    });
  }
  if (chapters.length > 0) return chapters;

  // Fallback: chapter select dropdown on reader pages
  const select = root.querySelector('#list-chapter .select-chapter select, .m-page .list-chapter select, .list-chapter .select-chapter select');
  if (select) {
    for (const option of select.querySelectorAll('option')) {
      const value = option.getAttribute('value');
      const ref = value ? readerRefFromUrl(value) : null;
      const title = textOf(option);
      if (!ref || !title) continue;

      chapters.push({
        nativeId: `${ref.panelId}~${ref.token}`,
        panelNativeId: ref.panelId,
        chapterToken: ref.token,
        title,
        chapterNumber: chapterNumberFromToken(ref.token),
        sourceUrl: absoluteUrl(value, baseUrl)!,
        publishedAt: null,
      });
    }
    return chapters;
  }

  // Last resort: first/latest links on the panel detail page
  const panelId = sourceUrl ? panelNativeIdFromUrl(sourceUrl) ?? '' : '';
  if (!panelId) return chapters;

  const firstLink = root.querySelector('.manga-actions a[title^="Read Chapter"]');
  const latestLink = root.querySelector('.manga-actions a[title^="Read Latest"]');

  if (firstLink || latestLink) {
    const getRef = (el: HTMLElement | null) => {
      const href = el?.getAttribute('href');
      return href ? readerRefFromUrl(href) : null;
    };

    const firstRef = getRef(firstLink);
    const latestRef = getRef(latestLink);

    if (firstRef) {
      chapters.push({
        nativeId: `${firstRef.panelId}~${firstRef.token}`,
        panelNativeId: firstRef.panelId,
        chapterToken: firstRef.token,
        title: 'Chapter 1',
        chapterNumber: 1,
        sourceUrl: absoluteUrl(firstLink?.getAttribute('href'), baseUrl)!,
        publishedAt: null,
      });
    }
    if (latestRef && (!firstRef || latestRef.token !== firstRef.token)) {
      // The "Read Latest" button's visible text is the UI label
      // "Latest Chapter", not a chapter title — prefer the number
      // derived from the URL token so the row reads "Chapter N".
      const latestNumber = chapterNumberFromToken(latestRef.token);
      chapters.push({
        nativeId: `${latestRef.panelId}~${latestRef.token}`,
        panelNativeId: latestRef.panelId,
        chapterToken: latestRef.token,
        title: latestNumber ? `Chapter ${latestNumber}` : (textOf(latestLink) ?? ''),
        chapterNumber: latestNumber,
        sourceUrl: absoluteUrl(latestLink?.getAttribute('href'), baseUrl)!,
        publishedAt: null,
      });
    }
  }

  return chapters;
}

/* -------------------------------------------------------------------------- */
/* Chapter reader page (`/read/<id>/chapter-<num>`) — HTML fallback            */
/* -------------------------------------------------------------------------- */

export function parseChapterReaderPage(html: string, baseUrl: string): RawChapterPages {
  const root = parseHtml(html);

  // Extract image URLs from atob-encoded script arrays (same as MangaKatana).
  // The initial HTML usually carries no page images (hidden content loaded
  // via the SPA API), so this is best-effort only.
  const arrays = extractScriptArrays(html);

  // Page URLs: the longest array whose entries look like image URLs.
  const imageArrays = arrays
    .map((entries) => entries.filter(looksLikeImageUrl))
    .filter((entries) => entries.length > 0)
    .sort((a, b) => b.length - a.length);
  const imageUrls = imageArrays[0] ?? [];

  // Title from h1.chapter-title
  const titleTag = textOf(root.querySelector('h1.chapter-title'));
  // "One Piece Chapter 1190" → panelTitle: "One Piece", readerLabel: "Chapter 1190"
  const titleParts = titleTag
    ? titleTag.split(/Chapter\s+(\d+)/i).filter(Boolean)
    : [];
  const panelTitle = titleParts[0]?.trim() ?? null;
  const chapterMatch = titleTag?.match(/Chapter\s+([\d.]+)/i);
  const readerLabel = chapterMatch ? `Chapter ${chapterMatch[1]}` : null;

  // Cover from og:image
  const coverUrl = absoluteUrl(
    root.querySelector('meta[property="og:image"]')?.getAttribute('content'),
    baseUrl,
  );

  // Published date from time.datetime
  const publishedAt = parseIsoToIso(
    root.querySelector('time[datetime]')?.getAttribute('datetime') ?? null,
  );

  // The panel id is read from the `.m-page` breadcrumb link so
  // cross-panel entries (see the SPA `options` poisoning note in
  // parseApiResponse) can be dropped from nav links and options alike.
  const pagePanelId = panelNativeIdFromUrl(
    root.querySelector('.m-page a[href*="/raw/"]')?.getAttribute('href') ?? '',
  );

  // Navigation links (dropped when they point at another panel).
  const prevLink = root.querySelector('.page-nav .chapter-btn.prev a');
  const nextLink = root.querySelector('.page-nav .chapter-btn.next a');

  const rawPrevRef = prevLink ? readerRefFromUrl(prevLink.getAttribute('href') ?? '') : null;
  const rawNextRef = nextLink ? readerRefFromUrl(nextLink.getAttribute('href') ?? '') : null;
  const prevRef = rawPrevRef && (!pagePanelId || rawPrevRef.panelId === pagePanelId) ? rawPrevRef : null;
  const nextRef = rawNextRef && (!pagePanelId || rawNextRef.panelId === pagePanelId) ? rawNextRef : null;

  // Chapter options from the select dropdown.
  const chapterOptions: Array<{ token: string; title: string }> = [];
  const select = root.querySelector('.list-chapter .select-chapter select');
  let currentToken: string | null = null;
  if (select) {
    for (const option of select.querySelectorAll('option')) {
      const value = option.getAttribute('value');
      const ref = value ? readerRefFromUrl(value) : null;
      const title = textOf(option);
      if (ref && title && (!pagePanelId || ref.panelId === pagePanelId)) {
        chapterOptions.push({ token: ref.token, title: normalizeChapterLabel(title) });
        if (option.hasAttribute('selected')) {
          currentToken = ref.token;
        }
      }
    }
  }

  // If no images found and no reader data, it's not a chapter page
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
    chapterOptions,
    currentToken,
  };
}

/* -------------------------------------------------------------------------- */
/* SPA JSON API (`/spa/manga/{manga_id}/{chapter_number}`)                     */
/* -------------------------------------------------------------------------- */

interface ChapterDetail {
  manga_id: string | number;
  manga_name: string;
  chapter_id: string | number;
  chapter_number: string | number;
  chapter_title?: string;
  chapter_date_published: string;
  manga_cover_img: string | null;
  server: string | null;
  slaves?: string[];
  chapter_content: string | null;
}

interface ApiChapterResponse {
  prev?: string;
  next?: string;
  hidden?: boolean;
  chapter_detail: ChapterDetail;
  options: string;
}

/**
 * Parse the SPA JSON API response for a chapter reader page.
 *
 * The initial HTML page does NOT contain image URLs — they are loaded
 * dynamically via an AJAX call to `/spa/manga/{manga_id}/{chapter_number}`.
 * The JSON response includes:
 *  - `chapter_detail.chapter_content`: HTML with `<img class="lazy" data-src="...">` entries
 *  - `chapter_detail.server`: CDN base URL (e.g. "https://s1.rawuwu.net/")
 *  - `chapter_detail.slaves`: additional CDN URLs
 *  - `options`: HTML string of `<option>` tags for chapter navigation
 *  - `prev`/`next`: chapter navigation URLs
 */
export function parseApiResponse(body: string, baseUrl: string): RawChapterPages {
  let data: ApiChapterResponse;
  try {
    data = JSON.parse(body) as ApiChapterResponse;
  } catch {
    throw new PageNotRecognizedError('API response was not valid JSON.');
  }

  const detail = data.chapter_detail as ChapterDetail;
  if (!detail || !detail.manga_name) {
    throw new PageNotRecognizedError('API response did not contain chapter_detail.');
  }

  // Image URLs: resolve `data-src` attributes in chapter_content against the server URL.
  const server = detail.server ?? '';
  const imageUrls: string[] = [];
  const content = detail.chapter_content ?? '';
  if (content) {
    const contentRoot = parseHtml(content);
    for (const img of contentRoot.querySelectorAll('img.lazy')) {
      const dataSrc = img.getAttribute('data-src')?.trim();
      if (!dataSrc) continue;
      // The data-src is relative to the server URL
      const fullUrl = new URL(dataSrc, server).toString();
      imageUrls.push(fullUrl);
    }
  }

  // Chapter options from the `options` HTML string
  const chapterOptions: Array<{ token: string; title: string }> = [];
  let currentToken: string | null = null;
  // The options payload is intermittently poisoned with another site's
  // entries (`/reader/sa<id>/…` — RawSakura-flavored URLs for a different
  // chapter range). Only keep options that address this exact panel.
  const panelId = String(detail.manga_id);
  if (data.options) {
    const optionsRoot = parseHtml(data.options);
    for (const option of optionsRoot.querySelectorAll('option')) {
      const value = option.getAttribute('value');
      const ref = value ? readerRefFromUrl(value) : null;
      const title = textOf(option);
      if (ref && title && ref.panelId === panelId) {
        chapterOptions.push({ token: ref.token, title: normalizeChapterLabel(title) });
        if (option.hasAttribute('selected')) {
          currentToken = ref.token;
        }
      }
    }
  }

  // If no selected token in options, derive from chapter_number
  if (!currentToken && detail.chapter_number) {
    currentToken = `chapter-${detail.chapter_number}`;
  }

  // Panel title and reader label
  const panelTitle: string | null = detail.manga_name ?? null;
  const chapterNum = detail.chapter_number;
  let readerLabel: string | null = null;
  if (chapterNum) {
    const titlePart = detail.chapter_title ? ` : ${detail.chapter_title}` : '';
    readerLabel = `Chapter ${chapterNum}${titlePart}`;
  }

  // Cover URL
  const coverUrl = absoluteUrl(detail.manga_cover_img, baseUrl);

  // Published date
  const publishedAt = parseIsoToIso(detail.chapter_date_published ?? null);

  // Navigation (same poisoning caveat as the options above — the refs
  // are only trusted when they address this exact panel).
  const rawPrevRef = data.prev ? readerRefFromUrl(data.prev) : null;
  const rawNextRef = data.next ? readerRefFromUrl(data.next) : null;
  const prevRef = rawPrevRef && rawPrevRef.panelId === panelId ? rawPrevRef : null;
  const nextRef = rawNextRef && rawNextRef.panelId === panelId ? rawNextRef : null;

  if (imageUrls.length === 0) {
    throw new PageNotRecognizedError('API response did not contain any image URLs.');
  }

  return {
    imageUrls,
    panelTitle,
    readerLabel,
    coverUrl,
    publishedAt,
    prevRef,
    nextRef,
    chapterOptions,
    currentToken,
  };
}

/* -------------------------------------------------------------------------- */
/* SPA JSON API for panel details (`/spa/manga/{manga_id}`)                   */
/* -------------------------------------------------------------------------- */

interface SpaPanelDetail {
  manga_id: string | number;
  manga_name: string;
  manga_others_name?: string;
  manga_status: boolean;
  manga_description?: string;
  manga_date_published: string;
  manga_updated: string;
  manga_cover_img: string;
}

interface SpaChapter {
  chapter_id: string | number;
  chapter_title?: string;
  chapter_number: number;
  chapter_date_published: string;
}

interface SpaTag {
  tag_name: string;
  tag_id: number;
}

interface ApiPanelResponse {
  detail: SpaPanelDetail;
  tags: SpaTag[];
  authors: Array<{ author_name: string }>;
  chapters: SpaChapter[];
}

/**
 * Parse the SPA JSON API response for a panel detail page.
 * Returns the panel details and full chapter list.
 */
export function parsePanelApiResponse(
  body: string,
  baseUrl: string,
  sourceUrl: string,
): { details: RawPanelDetails; chapters: RawChapterItem[] } {
  let data: ApiPanelResponse;
  try {
    data = JSON.parse(body) as ApiPanelResponse;
  } catch {
    throw new PageNotRecognizedError('API response was not valid JSON.');
  }

  const detail = data.detail;
  if (!detail || !detail.manga_name) {
    throw new PageNotRecognizedError('API response did not contain panel detail.');
  }

  const nativeId = String(detail.manga_id);

  // Genres from tags (site values carry stray punctuation, e.g. "Action ,").
  const genres = (data.tags ?? [])
    .map((t) => cleanGenreLabel(t.tag_name))
    .filter((genre) => genre.length > 0);

  // Authors
  const authors = (data.authors ?? []).map((a) => a.author_name);

  // Status: false = ongoing, true = completed
  const status = normalizeStatus(
    detail.manga_status ? 'completed' : 'ongoing',
  );

  // Latest chapter label from the most recent chapter
  const chaptersRaw = data.chapters ?? [];
  const latestChapterLabel =
    chaptersRaw.length > 0 && chaptersRaw[0] ? `Chapter ${chaptersRaw[0]!.chapter_number}` : null;

  const details: RawPanelDetails = {
    nativeId,
    title: detail.manga_name,
    altTitles: detail.manga_others_name
      ? detail.manga_others_name.split(',').map((s) => s.trim()).filter(Boolean)
      : [],
    authors,
    artists: [],
    genres,
    status,
    description: detail.manga_description ?? null,
    coverUrl: absoluteUrl(detail.manga_cover_img, baseUrl),
    sourceUrl,
    latestChapterLabel,
  };

  // Build chapter list (newest first, matching the API order)
  const chapters: RawChapterItem[] = chaptersRaw.map((ch) => {
    const token = `chapter-${ch.chapter_number}`;
    const chapterNumber = ch.chapter_number;
    return {
      nativeId: `${nativeId}~${token}`,
      panelNativeId: nativeId,
      chapterToken: token,
      title: `Chapter ${chapterNumber}`,
      chapterNumber,
      sourceUrl: `${baseUrl}/read/${encodeURIComponent(nativeId)}/chapter-${chapterNumber}`,
      publishedAt: parseIsoToIso(ch.chapter_date_published ?? null),
    };
  });

  return { details, chapters };
}

/* -------------------------------------------------------------------------- */
/* SPA JSON API for listings (`/spa/search`, `/spa/latest-manga`)             */
/* -------------------------------------------------------------------------- */

interface SpaListChapter {
  manga_id: string | number;
  chapter_id: string | number;
  chapter_number: string | number;
  chapter_date_published: string;
}

interface SpaListEntry {
  manga_id: string | number;
  manga_name: string;
  manga_cover_img: string | null;
  manga_chapters: SpaListChapter[] | null;
}

interface SpaListResponse {
  manga_list: SpaListEntry[];
  pagi: {
    pages: Array<{ page: number; act?: boolean }>;
    button: { next: number; prev: number };
    cur_page: number;
  };
}

/**
 * Parse the SPA JSON API listing responses (`/spa/search?query=&page=`,
 * `/spa/latest-manga?page=`). Entry cards carry no genres — the adapter
 * enriches those from the detail payloads, same as the HTML listings.
 */
export function parseSpaListResponse(
  body: string,
  baseUrl: string,
): { items: RawListItem[]; hasMore: boolean } {
  let data: SpaListResponse;
  try {
    data = JSON.parse(body) as SpaListResponse;
  } catch {
    throw new PageNotRecognizedError('API response was not valid JSON.');
  }

  if (!data || !Array.isArray(data.manga_list)) {
    throw new PageNotRecognizedError('API response did not contain manga_list.');
  }

  const items: RawListItem[] = data.manga_list.map((entry): RawListItem | null => {
    const nativeId = String(entry.manga_id);
    const title = entry.manga_name?.trim();
    if (!nativeId || !title) return null;
    const firstChapter = entry.manga_chapters?.[0] ?? null;
    return {
      nativeId,
      title,
      coverUrl: absoluteUrl(entry.manga_cover_img, baseUrl),
      sourceUrl: `${baseUrl}/raw/${encodeURIComponent(nativeId)}`,
      status: 'unknown',
      genres: [],
      summary: null,
      latestChapterLabel: firstChapter ? `Chapter ${firstChapter.chapter_number}` : null,
      updatedAt: parseIsoToIso(firstChapter?.chapter_date_published ?? null),
    };
  }).filter((item): item is RawListItem => item !== null);

  const next = data.pagi?.button?.next;
  const hasMore = typeof next === 'number' ? next > 0 : items.length >= 20;

  return { items, hasMore };
}
