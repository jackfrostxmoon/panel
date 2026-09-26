import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import type { PanelStatus } from '@panel/shared';
import { pickCoverSrc } from '../coverImage.js';

export class PageNotRecognizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageNotRecognizedError';
  }
}

/**
 * Host-agnostic image check (source-wide policy: parsers never filter by
 * host — host policy lives solely in the adapter's image allowlist, which
 * is the SSRF-safe gate every parsed URL passes before any fetch).
 */
function looksLikeImageUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  return /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i.test(value) || value.includes('/token/');
}

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
  dimensions: Array<{ width: number; height: number } | null>;
  chapterOptions: Array<{ token: string; title: string }>;
  currentToken: string | null;
  readerLabel: string | null;
  coverUrl: string | null;
}

export interface ChapterListApiItem {
  nativeId: string;
  title: string;
  chapterNumber: number | null;
  sourceUrl: string;
  chapterId: number;
}

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
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => {
      const cp = Number.parseInt(code, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
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

export function panelNativeIdFromUrl(url: string): string | null {
  const match = /\/manga\/([^/?#]+)/.exec(url);
  return match?.[1] ?? null;
}

export function chapterRefFromUrl(url: string): { panelId: string; token: string } | null {
  const match = /\/manga\/([^/?#]+)\/(chapter-[\d.]+)/i.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { panelId: match[1], token: match[2] };
}

export function chapterNumberFromToken(token: string): number | null {
  const match = /^chapter-([\d.]+)$/i.exec(token);
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

function parseSourceDate(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.includes('minute') || trimmed.includes('hour') || trimmed.includes('ago')) {
    return new Date().toISOString();
  }
  if (trimmed.includes('day')) {
    const days = Number.parseInt(trimmed.match(/(\d+)\s*day/)?.[1] ?? '1', 10);
    const date = new Date(Date.now() - days * 86400000);
    return date.toISOString();
  }
  const match = /^([A-Za-z]{3,})-(\d{1,2})-(\d{4})$/.exec(trimmed);
  if (!match) return null;
  const month = MONTHS[match[1]!.slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const day = Number.parseInt(match[2]!, 10);
  const year = Number.parseInt(match[3]!, 10);
  const date = new Date(Date.UTC(year, month, day));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeStatus(raw: string | null): PanelStatus {
  if (!raw) return 'unknown';
  const value = raw.trim().toLowerCase();
  if (value.includes('ongoing')) return 'ongoing';
  if (value.includes('completed') || value.includes('complete')) return 'completed';
  if (value.includes('hiatus')) return 'hiatus';
  if (value.includes('cancel') || value.includes('dropped')) return 'cancelled';
  return 'unknown';
}

export function parseSearchPage(html: string, baseUrl: string): RawSearchPage {
  const root = parseHtml(html);
  const items: RawSearchItem[] = [];

  for (const item of root.querySelectorAll('.book-item')) {
    const link = item.querySelector('.book-detailed-item .thumb a') ?? item.querySelector('.title a');
    const sourceUrl = absoluteUrl(link?.getAttribute('href'), baseUrl);
    const nativeId = sourceUrl ? panelNativeIdFromUrl(sourceUrl) : null;

    const title = textOf(item.querySelector('.book-detailed-item .title h3 a')) ?? textOf(item.querySelector('.title a'));
    if (!sourceUrl || !nativeId || !title) continue;

    const img = item.querySelector('.book-detailed-item .thumb img') ?? item.querySelector('.thumb img');
    const coverUrl = absoluteUrl(img ? pickCoverSrc(img) : null, baseUrl);

    const genres = item
      .querySelectorAll('.genres span, .genres a')
      .map((a) => textOf(a))
      .filter((g): g is string => g !== null);

    const latestChapterLabel = textOf(item.querySelector('.latest-chapter'));
    const dateText = textOf(item.querySelector('.meta .views, .date, .update_time'));

    items.push({
      nativeId,
      title,
      coverUrl,
      sourceUrl,
      status: normalizeStatus(textOf(item.querySelector('.status'))),
      genres,
      summary: textOf(item.querySelector('.summary p, .summary')),
      latestChapterLabel,
      updatedAt: parseSourceDate(dateText),
    });
  }

  // Kaliscan's pagination block uses the `.paginator` class, not the more
  // common `.pagination` / `.uk-pagination` from WordPress-derived themes.
  // Its "Next »" link is a plain `<a>` with no `.next`/`rel="next"` markup,
  // so we also match by the button text the site actually emits. The
  // `KaliscanSource.latest` heuristic (items.length >= 20) still keeps
  // `hasMore` true on dense pages even if this selector ever misses.
  const pagination = root.querySelector('.pagination, .uk-pagination, .paginator');
  const hasMore =
    pagination?.querySelector('.next, .uk-pagination-next, a[rel="next"]') !== null ||
    (pagination?.text ?? '').toLowerCase().includes('next');

  return { items, totalCount: null, hasMore };
}

export function parseLatestPage(html: string, baseUrl: string): RawSearchPage {
  return parseSearchPage(html, baseUrl);
}

/**
 * Full genre catalog from the nav `GENRES` menu (links to `/genres/<slug>`,
 * rendered on every page — the sibling `TOP` menu shares the wrapper class,
 * so links are filtered by href prefix). Site order is kept; duplicates
 * are dropped.
 */
export function parseGenreCatalog(html: string): string[] {
  const root = parseHtml(html);
  const seen = new Set<string>();
  const genres: string[] = [];
  for (const a of root.querySelectorAll('ul.genres__wrapper a')) {
    const href = a.getAttribute('href') ?? '';
    if (!href.startsWith('/genres/')) continue;
    const label = textOf(a);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    genres.push(label);
  }
  return genres;
}

/**
 * Nav genre index as label → absolute archive-URL pairs (same markup as
 * the catalog). Lets `latestByGenre` resolve a dropdown label to the exact
 * genre archive instead of guessing slugs.
 */
export function parseGenreLinks(html: string, baseUrl: string): Array<{ label: string; href: string }> {
  const root = parseHtml(html);
  const links: Array<{ label: string; href: string }> = [];
  for (const a of root.querySelectorAll('ul.genres__wrapper a')) {
    const rawHref = a.getAttribute('href') ?? '';
    if (!rawHref.startsWith('/genres/')) continue;
    const label = textOf(a);
    const href = absoluteUrl(rawHref, baseUrl);
    if (!label || !href) continue;
    links.push({ label, href });
  }
  return links;
}

export function parsePanelPage(html: string, sourceUrl: string, baseUrl: string): RawPanelDetails {
  const root = parseHtml(html);

  const bookInfo = root.querySelector('.book-info, .book-detail, #cover');
  if (!bookInfo && !root.querySelector('.detail .name h1')) {
    throw new PageNotRecognizedError('Panel page did not contain the book container.');
  }

  const heading = textOf(root.querySelector('.detail .name h1')) ?? textOf(root.querySelector('h1'));
  const ogTitle = root.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const title = heading ?? (ogTitle ? decodeEntities(ogTitle).trim() : null);
  if (!title) {
    throw new PageNotRecognizedError('Panel page did not contain a title.');
  }

  const nativeId = panelNativeIdFromUrl(sourceUrl) ?? '';

  const altRaw = textOf(root.querySelector('.detail .name h2')) ?? textOf(root.querySelector('.alt_name'));
  const altTitles = altRaw
    ? altRaw
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const authors: string[] = [];
  const authorEl = root.querySelector('.detail .meta p:has(strong:contains("Author")), .authors a');
  if (authorEl) {
    const authorText = textOf(authorEl);
    if (authorText) {
      authors.push(...authorText.split(',').map(s => s.trim()).filter(Boolean));
    }
  }

  const genres = root
    .querySelectorAll('.detail .meta a[href*="/genres/"], .genres a, .genres span')
    .map((a) => textOf(a))
    .filter((g): g is string => g !== null);

  const coverImg = root.querySelector('.book-info .cover img, .cover img, .img-cover img');
  const coverUrl =
    absoluteUrl(coverImg ? pickCoverSrc(coverImg) : null, baseUrl) ??
    absoluteUrl(root.querySelector('meta[property="og:image"]')?.getAttribute('content'), baseUrl);

  const description = textOf(root.querySelector('.summary .content, .summary p, .detail .content'));

  const statusText = textOf(root.querySelector('.detail .meta a[href*="/status/"]'));
  const latestChapterLabel = textOf(root.querySelector('.latest-chapters a:first-child strong, .latest-chapters a:first-child'));

  return {
    nativeId,
    title,
    altTitles,
    authors,
    artists: [],
    genres,
    status: normalizeStatus(statusText),
    description,
    coverUrl,
    sourceUrl,
    latestChapterLabel,
  };
}

export function parseChapterList(html: string, baseUrl: string): RawChapterItem[] {
  const root = parseHtml(html);
  const chapters: RawChapterItem[] = [];

  for (const link of root.querySelectorAll('.latest-chapters a, .chapter-list a')) {
    const sourceUrl = absoluteUrl(link.getAttribute('href'), baseUrl);
    const title = textOf(link);
    if (!sourceUrl || !title) continue;

    const ref = chapterRefFromUrl(sourceUrl);
    if (!ref) continue;

    const chapterNumber = chapterNumberFromToken(ref.token);

    chapters.push({
      nativeId: `${ref.panelId}~${ref.token}`,
      panelNativeId: ref.panelId,
      chapterToken: ref.token,
      title,
      chapterNumber,
      sourceUrl,
      publishedAt: null,
    });
  }

  return chapters;
}

export function parseChapterListFromApi(html: string, baseUrl: string): ChapterListApiItem[] {
  const root = parseHtml(html);
  const chapters: ChapterListApiItem[] = [];

  for (const option of root.querySelectorAll('.chapter-select option')) {
    const value = option.getAttribute('value');
    const title = textOf(option);
    if (!value || !title) continue;

    const href: string = value;

    const ref = chapterRefFromUrl(href);
    if (!ref) continue;

    const chapterNumber = chapterNumberFromToken(ref.token);

    const chapterIdMatch = /chapter_id=(\d+)/.exec(href);
    const chapterId = chapterIdMatch && chapterIdMatch[1] ? Number.parseInt(chapterIdMatch[1], 10) : 0;

    chapters.push({
      nativeId: `${ref.panelId}~${ref.token}`,
      title,
      chapterNumber,
      sourceUrl: absoluteUrl(href, baseUrl) ?? href,
      chapterId,
    });
  }

  return chapters;
}

export function parseChapterImagesFromApi(html: string, baseUrl: string): string[] {
  const root = parseHtml(html);
  const images: string[] = [];

  for (const div of root.querySelectorAll('.chapter-image.chapter-lazy-image')) {
    const src = div.getAttribute('data-src');
    if (src) {
      const abs = absoluteUrl(src, baseUrl);
      if (abs && looksLikeImageUrl(abs)) {
        images.push(abs);
      }
    }
  }

  return images;
}

export function parseChapterReaderPage(html: string, baseUrl: string): RawChapterPages {
  const root = parseHtml(html);

  const coverUrl = absoluteUrl(
    root.querySelector('meta[property="og:image"]')?.getAttribute('content'),
    baseUrl,
  );

  const readerContainer = root.querySelector('#chapter__content, .reading-box, .chapter-content');
  const images: string[] = [];
  for (const img of root.querySelectorAll('#chapter__content img, .reading-box img, .chapter-content img')) {
    const src = img.getAttribute('data-src') ?? img.getAttribute('src');
    if (src) {
      const abs = absoluteUrl(src, baseUrl);
      if (abs && looksLikeImageUrl(abs)) {
        images.push(abs);
      }
    }
  }

  const dimensions: Array<{ width: number; height: number } | null> = images.map(() => null);

  const chapterOptions: Array<{ token: string; title: string }> = [];
  let currentToken: string | null = null;
  const select = root.querySelector('#chapter-list select, select.chapter_select, select[name="chapter_select"]');
  if (select) {
    for (const option of select.querySelectorAll('option')) {
      const rawValue = option.getAttribute('value') ?? '';
      const label = textOf(option);
      if (!rawValue || !label) continue;
      // Option values are reader URLs like "/manga/<id>/chapter-12" — reduce
      // them to bare tokens ("chapter-12") so they are comparable to the
      // current chapter token.
      const ref = chapterRefFromUrl(rawValue);
      const value = ref ? ref.token : rawValue;
      chapterOptions.push({ token: value, title: label });
      if (option.hasAttribute('selected')) currentToken = value;
    }
  }

  const readerLabel = textOf(root.querySelector('.viewer-header .chapter-title, .page-title'));

  if (images.length === 0 && !readerContainer && chapterOptions.length === 0) {
    throw new PageNotRecognizedError('Chapter page did not contain reader data.');
  }

  return {
    imageUrls: images,
    dimensions,
    chapterOptions,
    currentToken,
    readerLabel: readerLabel ? decodeEntities(readerLabel).trim() : null,
    coverUrl,
  };
}