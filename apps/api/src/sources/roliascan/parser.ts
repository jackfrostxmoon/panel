import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import type { PanelStatus } from '@panel/shared';
import { pickCoverSrc } from '../coverImage.js';

export class PageNotRecognizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageNotRecognizedError';
  }
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

export interface RawChapterBatch {
  items: RawChapterItem[];
  hasMore: boolean;
  nextOffset: number | null;
  total: number | null;
}

export interface RawPanelChapters {
  items: RawChapterItem[];
  total: number | null;
  hasMore: boolean;
  nextOffset: number | null;
  chaptersUrl: string | null;
}

export interface RawChapterPages {
  imageUrls: string[];
  prevToken: string | null;
  nextToken: string | null;
  currentToken: string | null;
  readerLabel: string | null;
  coverUrl: string | null;
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

/** Reader URLs look like `/read/<slug>/en/chapter-628` (lang segment varies). */
export function chapterRefFromUrl(url: string): { panelId: string; token: string } | null {
  const match = /\/read\/([^/?#]+)\/[a-z-]{2,8}\/(chapter-[\d.]+)/i.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { panelId: match[1], token: match[2] };
}

export function chapterNumberFromToken(token: string): number | null {
  const match = /^chapter-([\d.]+)$/i.exec(token);
  if (!match?.[1]) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
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

/** Absolute dates as rendered in `title` attrs ("Oct 08, 2026"). */
function parseAbsoluteDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(raw.trim());
  if (!match) return null;
  const month = MONTHS[(match[1] ?? '').slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const date = new Date(Date.UTC(Number.parseInt(match[3] ?? '0', 10), month, Number.parseInt(match[2] ?? '0', 10)));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Relative dates as rendered in cards ("21h ago", "21 hours ago", "6mo ago"). */
function parseRelativeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = /(\d+)\s*(mins?|minutes?|hours?|days?|weeks?|months?|years?|min|h|d|w|mo|y)\s*ago/i.exec(
    raw.trim(),
  );
  if (!match) return null;
  const amount = Number.parseInt(match[1] ?? '0', 10);
  const unit = (match[2] ?? '').toLowerCase();
  const msPer: Record<string, number> = {
    min: 60_000,
    mins: 60_000,
    minute: 60_000,
    minutes: 60_000,
    h: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
    d: 86_400_000,
    day: 86_400_000,
    days: 86_400_000,
    w: 7 * 86_400_000,
    week: 7 * 86_400_000,
    weeks: 7 * 86_400_000,
    mo: 30 * 86_400_000,
    month: 30 * 86_400_000,
    months: 30 * 86_400_000,
    y: 365 * 86_400_000,
    year: 365 * 86_400_000,
    years: 365 * 86_400_000,
  };
  const ms = msPer[unit];
  if (!ms) return null;
  return new Date(Date.now() - amount * ms).toISOString();
}

function parseCardDate(dateSpan: HTMLElement | null | undefined): string | null {
  if (!dateSpan) return null;
  return (
    parseAbsoluteDate(dateSpan.getAttribute('title')) ?? parseRelativeDate(textOf(dateSpan))
  );
}

function parseRowCard(article: HTMLElement, baseUrl: string): RawSearchItem | null {
  const titleLink = article.querySelector('.row-card__title');
  const sourceUrl = absoluteUrl(titleLink?.getAttribute('href'), baseUrl);
  const nativeId = sourceUrl ? panelNativeIdFromUrl(sourceUrl) : null;
  const title = textOf(titleLink);
  if (!sourceUrl || !nativeId || !title) return null;

  const img = article.querySelector('.row-card__poster img');
  const coverUrl = absoluteUrl(img ? pickCoverSrc(img) : null, baseUrl);

  // Type pill ("Manga"/"Manhwa"/…) is a content type, not a genre — cards
  // carry no genre markup. Genre-less keeps the UI include filter fail-open
  // (the server already genre-filtered when applicable) and lets
  // fillGenresFromCache enrich from the metadata cache.
  const genres: string[] = [];

  const chapterLinks = article.querySelectorAll('.row-card__chapters li a');
  const firstChapter = chapterLinks[0];
  // The chapter pill nests a lang tag ("Chap 628 EN") — strip it.
  const latestChapterLabel =
    textOf(firstChapter?.querySelector('.row-card__ch'))?.replace(/\s+[A-Z]{2}$/, '') ??
    textOf(firstChapter);
  const updatedAt = parseCardDate(
    firstChapter?.querySelector('.row-card__time') ?? firstChapter?.querySelector('span[title]'),
  );

  return {
    nativeId,
    title,
    coverUrl,
    sourceUrl,
    status: 'unknown',
    genres,
    summary: null,
    latestChapterLabel,
    updatedAt,
  };
}

export function parseSearchPage(html: string, baseUrl: string): RawSearchPage {
  const root = parseHtml(html);
  const items: RawSearchItem[] = [];

  const results = root.querySelector('.browse__results');
  if (!results) {
    throw new PageNotRecognizedError('Search page did not contain the results container.');
  }

  for (const article of results.querySelectorAll('article.row-card')) {
    const item = parseRowCard(article, baseUrl);
    if (item) items.push(item);
  }

  // Pagination is a `<link rel="next">` in <head> — the only reliable
  // signal (no pager classes in the markup). Empty out-of-range pages
  // still render head links, so an empty page never reports hasMore
  // (infinite-scroll guard).
  const hasMore = items.length > 0 && root.querySelector('link[rel="next"]') !== null;

  return { items, totalCount: null, hasMore };
}

export function parseLatestPage(html: string, baseUrl: string): RawSearchPage {
  return parseSearchPage(html, baseUrl);
}

/**
 * Full genre catalog from the nav menu (`a.site-menu__genre`, rendered on
 * every page). Site order is kept; duplicates are dropped.
 */
export function parseGenreCatalog(html: string): string[] {
  const root = parseHtml(html);
  const seen = new Set<string>();
  const genres: string[] = [];
  for (const a of root.querySelectorAll('a.site-menu__genre')) {
    const label = textOf(a);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    genres.push(label);
  }
  return genres;
}

/** Nav genre index as label → absolute archive-URL pairs. */
export function parseGenreLinks(html: string, baseUrl: string): Array<{ label: string; href: string }> {
  const root = parseHtml(html);
  const links: Array<{ label: string; href: string }> = [];
  for (const a of root.querySelectorAll('a.site-menu__genre')) {
    const label = textOf(a);
    const href = absoluteUrl(a.getAttribute('href'), baseUrl);
    if (!label || !href) continue;
    if (links.some((entry) => entry.label === label)) continue;
    links.push({ label, href });
  }
  return links;
}

export function parsePanelPage(html: string, sourceUrl: string, baseUrl: string): RawPanelDetails {
  const root = parseHtml(html);
  const detail = root.querySelector('#manga-page.tdetail') ?? root.querySelector('.tdetail');
  if (!detail) {
    throw new PageNotRecognizedError('Panel page did not contain the detail container.');
  }

  const heading = textOf(detail.querySelector('h1.tdetail__title'));
  const ogTitle = root.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const title = heading ?? (ogTitle ? decodeEntities(ogTitle).split('–')[0]?.trim() || null : null);
  if (!title) {
    throw new PageNotRecognizedError('Panel page did not contain a title.');
  }

  const nativeId = panelNativeIdFromUrl(sourceUrl) ?? '';

  const altTitles = detail
    .querySelectorAll('.tdetail__alt-list li')
    .map((li) => textOf(li))
    .filter((t): t is string => t !== null);

  const authors = detail
    .querySelectorAll('.tdetail__credits a[href*="/author/"]')
    .map((a) => textOf(a))
    .filter((t): t is string => t !== null);

  // Genre pills live inside the detail container; the nav menu links (same
  // /genre/ href space, class `site-menu__genre`) are filtered out.
  const genres = detail
    .querySelectorAll('a[href*="/genre/"]')
    .filter((a) => !(a.getAttribute('class') ?? '').includes('site-menu__genre'))
    .map((a) => textOf(a))
    .filter((t): t is string => t !== null);

  const facts = textOf(detail.querySelector('.tdetail__facts'));
  const latestChapterLabel = facts ? /Latest:\s*(Chapter [\d.]+)/i.exec(facts)?.[1] ?? null : null;

  const description = textOf(detail.querySelector('.tdetail__synopsis p'));

  const posterImg = detail.querySelector('.tdetail__poster img');
  const coverUrl =
    absoluteUrl(posterImg ? pickCoverSrc(posterImg) : null, baseUrl) ??
    absoluteUrl(root.querySelector('meta[property="og:image"]')?.getAttribute('content'), baseUrl);

  return {
    nativeId,
    title,
    altTitles,
    authors,
    artists: [],
    genres,
    status: normalizeStatus(facts),
    description,
    coverUrl,
    sourceUrl,
    latestChapterLabel,
  };
}

function parseChapterLi(li: HTMLElement, baseUrl: string): RawChapterItem | null {
  const link = li.querySelector('a');
  const href = link?.getAttribute('href');
  if (!href) return null;
  const ref = chapterRefFromUrl(href);
  if (!ref) return null;

  const numberAttr = li.getAttribute('data-number');
  const parsedNumber = numberAttr ? Number.parseFloat(numberAttr) : NaN;
  const chapterNumber = Number.isFinite(parsedNumber) ? parsedNumber : chapterNumberFromToken(ref.token);

  const tsAttr = li.getAttribute('data-ts');
  const ts = tsAttr ? Number.parseInt(tsAttr, 10) : NaN;
  const publishedAt = Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null;

  const title = textOf(link?.querySelector('b')) ?? textOf(link) ?? `Chapter ${chapterNumber ?? ref.token}`;

  return {
    nativeId: `${ref.panelId}~${ref.token}`,
    panelNativeId: ref.panelId,
    chapterToken: ref.token,
    title,
    chapterNumber,
    sourceUrl: absoluteUrl(href, baseUrl) ?? href,
    publishedAt,
  };
}

/** Initial chapter batch embedded in the series page. */
export function parsePanelChapters(html: string, baseUrl: string): RawPanelChapters {
  const root = parseHtml(html);
  const items: RawChapterItem[] = [];

  // The list renders per language (`ul[data-code]`); prefer English.
  const lists = root.querySelectorAll('ul.chapter-list-item');
  const list =
    lists.find((ul) => (ul.getAttribute('data-code') ?? '').toUpperCase() === 'EN') ?? lists[0];
  if (!list) {
    throw new PageNotRecognizedError('Panel page did not contain the chapter list.');
  }
  for (const li of list.querySelectorAll('li.item')) {
    const item = parseChapterLi(li, baseUrl);
    if (item) items.push(item);
  }

  const chaptersUrl = absoluteUrl(
    root.querySelector('section.m-list[data-chapters-url]')?.getAttribute('data-chapters-url'),
    baseUrl,
  );
  const totalAttr = list.getAttribute('data-total');
  const total = totalAttr ? Number.parseInt(totalAttr, 10) : null;
  const offsetAttr = list.getAttribute('data-offset');
  const nextOffset = offsetAttr ? Number.parseInt(offsetAttr, 10) : null;
  const hasMore = (list.getAttribute('data-has-more') ?? '').toLowerCase() === 'true';

  return {
    items,
    total: total !== null && Number.isFinite(total) ? total : null,
    hasMore,
    nextOffset: nextOffset !== null && Number.isFinite(nextOffset) ? nextOffset : null,
    chaptersUrl,
  };
}

/** Lazy-loaded follow-up batches from `<chapters-url>?offset=N`. */
export function parseChapterBatch(html: string, baseUrl: string): RawChapterBatch {
  const root = parseHtml(html);
  const items: RawChapterItem[] = [];
  for (const li of root.querySelectorAll('li.item')) {
    const item = parseChapterLi(li, baseUrl);
    if (item) items.push(item);
  }
  if (items.length === 0) {
    throw new PageNotRecognizedError('Chapter batch contained no chapter items.');
  }

  const meta = root.querySelector('.chapter-batch-meta');
  const hasMore = (meta?.getAttribute('data-has-more') ?? '').toLowerCase() === 'true';
  const nextOffsetAttr = meta?.getAttribute('data-next-offset');
  const nextOffset = nextOffsetAttr ? Number.parseInt(nextOffsetAttr, 10) : null;
  const totalAttr = meta?.getAttribute('data-total');
  const total = totalAttr ? Number.parseInt(totalAttr, 10) : null;

  return {
    items,
    hasMore,
    nextOffset: nextOffset !== null && Number.isFinite(nextOffset) ? nextOffset : null,
    total: total !== null && Number.isFinite(total) ? total : null,
  };
}

export function parseChapterReaderPage(html: string, baseUrl: string): RawChapterPages {
  const root = parseHtml(html);

  const coverUrl = absoluteUrl(
    root.querySelector('meta[property="og:image"]')?.getAttribute('content'),
    baseUrl,
  );

  // Reader images live under a `/chapter(s)/`-style path on the site's CDN
  // (legacy `/storage/chapters/`; current `<rand>/chapter/<hash>/N-<sha>.jpg`
  // inside `section.chapter-reader`). Prefer the structural container so
  // unrelated images elsewhere on the page can never sneak in; if it's
  // missing, fall back to the path shape — matching on the path (not a
  // container class) keeps this working across theme tweaks.
  const sectionImages = root.querySelectorAll('section.chapter-reader img');
  const fromSection = sectionImages.length > 0;
  const imageUrls: string[] = [];
  for (const img of fromSection ? sectionImages : root.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? img.getAttribute('data-src');
    if (!src) continue;
    const abs = absoluteUrl(src, baseUrl);
    if (abs && (fromSection || /\/chapters?\//.test(abs))) imageUrls.push(abs);
  }
  // Deduplicate while keeping document order (srcset/picture doubles).
  const uniqueImages = [...new Set(imageUrls)];

  let prevToken: string | null = null;
  let nextToken: string | null = null;
  for (const a of root.querySelectorAll('a')) {
    const label = (textOf(a) ?? '').toLowerCase();
    if (!label.includes('prev') && !label.includes('next')) continue;
    const ref = chapterRefFromUrl(a.getAttribute('href') ?? '');
    if (!ref) continue;
    if (label.includes('prev')) prevToken = ref.token;
    else nextToken = ref.token;
  }

  const ogUrl = root.querySelector('meta[property="og:url"]')?.getAttribute('content');
  const currentRef = ogUrl ? chapterRefFromUrl(ogUrl) : null;

  const titleTag = root.querySelector('title') ? textOf(root.querySelector('title')) : null;

  if (uniqueImages.length === 0 && !prevToken && !nextToken && !currentRef) {
    throw new PageNotRecognizedError('Chapter page did not contain reader data.');
  }

  return {
    imageUrls: uniqueImages,
    prevToken,
    nextToken,
    currentToken: currentRef?.token ?? null,
    readerLabel: titleTag,
    coverUrl,
  };
}
