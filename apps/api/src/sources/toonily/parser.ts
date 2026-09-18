import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import type { PanelStatus } from '@panel/shared';
import { pickCoverSrc } from '../coverImage.js';

/**
 * Toonily (toonily.com) HTML parser.
 *
 * WordPress site running the Madara theme (same family as mangaread.org).
 * URL layout (verified 2026-08):
 *   archive:  GET {base}/            (home = "Latest Releases" archive)
 *             GET {base}/page/<n>/
 *   search:   GET {base}/?s=<q>&post_type=wp-manga
 *             GET {base}/page/<n>/?s=<q>&post_type=wp-manga
 *   panel:    GET {base}/serie/<slug>/
 *   chapter:  GET {base}/serie/<slug>/<chapter-token>/  (token usually
 *             "chapter-N", decimals dash-encoded "chapter-381-5"; special
 *             chapters may be bare slugs like "epilogue")
 *
 * Native panel id: url slug (e.g. "the-beginning-after-the-end-ea2130e6").
 * Native chapter id: "<slug>~<chapter-token>".
 *
 * All HTML parsing lives in this file — pure functions: HTML string in,
 * plain data out. No fetching, no global state, no id prefixing (that is
 * the source adapter's job).
 *
 * Everything is defensive: the source is untrusted and its markup can change
 * at any time, so missing pieces degrade to nulls/empty arrays instead of
 * throwing — except when the page fundamentally is not what we asked for,
 * which is signalled via `PageNotRecognizedError` so the adapter can map it
 * to a proper "not found" API error.
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
  /** Native chapter id: "<slug>~<chapterToken>", e.g. "tbate…~chapter-249". */
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
  prevRef: { panelId: string; token: string } | null;
  nextRef: { panelId: string; token: string } | null;
  /** All chapters listed in the reader <select>, in source order. */
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

/** "the-beginning-after-the-end-ea2130e6" from a /serie/… url (skips chapter segment). */
export function panelNativeIdFromUrl(url: string): string | null {
  const match = /\/serie\/([^/?#]+)/i.exec(url);
  const slug = match?.[1];
  if (!slug || /^chapter-/i.test(slug)) return null;
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

/**
 * { panelId, token } from any series child page:
 *   "/serie/tbate…/chapter-249/" → token "chapter-249"
 *   "/serie/love-rebooted…/epilogue/" → token "epilogue"
 */
export function chapterRefFromUrl(url: string): { panelId: string; token: string } | null {
  const match = /\/serie\/([^/?#]+)\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(url);
  if (!match?.[1] || !match[2]) return null;
  if (/^(?:page|feed|amp)(?:$|\/)/i.test(match[2])) return null; // not chapters
  return { panelId: match[1], token: match[2] };
}

/**
 * "chapter-381" → 381, "chapter-381-5" → 381.5 (Madara dash-decimals).
 * A trailing title slug after the number ("chapter-32-some-title") is
 * ignored. Non-numeric tokens ("epilogue") → null.
 */
export function chapterNumberFromToken(token: string): number | null {
  const match = /^chapter-(\d+(?:-\d+)*)/i.exec(token);
  if (!match?.[1]) return null;
  const value = Number.parseFloat(match[1].replace(/-/g, '.'));
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

const RELATIVE_UNITS: Record<string, number> = {
  sec: 1000,
  second: 1000,
  min: 60_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000, // 30 days — display granularity is coarse anyway
  year: 31_536_000_000, // 365 days
};

/**
 * Parse Toonily release dates into ISO strings:
 *  - relative:  "just now", "13 mins ago", "3 days ago"
 *  - madara:    "Aug 13, 26" (two-digit year), "August 13, 2026"
 *  - sql-ish:   "2024-04-07 13:26:02"
 */
export function parseSourceDate(raw: string | null): string | null {
  if (!raw) return null;
  const text = raw.trim();
  const lower = text.toLowerCase();

  // Relative ("3 days ago").
  const rel = /^(?:about|over|almost)?\s*(\d+)\s+(sec|second|min|minute|hour|day|week|month|year)s?\s+ago$/.exec(
    lower,
  );
  if (rel?.[1] && rel[2]) {
    const ms = Number.parseInt(rel[1], 10) * (RELATIVE_UNITS[rel[2]] ?? 0);
    if (ms > 0) return new Date(Date.now() - ms).toISOString();
  }
  if (lower === 'just now' || lower === 'now') return new Date().toISOString();
  // Madara "UP" badge = released moments ago (replaces the date entirely).
  if (lower === 'up') return new Date().toISOString();

  // Madara month name ("Aug 13, 26" / "August 13, 2026") — treated as UTC.
  const named = /^([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{2}|\d{4})$/.exec(text);
  if (named?.[1] && named[2] && named[3]) {
    const month = MONTHS[named[1].slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      let year = Number.parseInt(named[3], 10);
      if (year < 100) year += 2000;
      const date = new Date(Date.UTC(year, month, Number.parseInt(named[2], 10)));
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
  }

  // SQL-ish datetime ("2024-04-07 13:26:02") — interpret as UTC for stable output.
  const sql = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(text);
  if (sql?.[1] && sql[2]) {
    const date = new Date(`${sql[1]}T${sql[2]}Z`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  // Last resort: let the platform try ("Aug 13" style without year etc.).
  const fallback = new Date(text);
  return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
}

export function normalizeStatus(raw: string | null): PanelStatus {
  if (!raw) return 'unknown';
  const value = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (value.includes('ongoing')) return 'ongoing';
  if (value.includes('completed') || value.includes('complete') || value === 'end') return 'completed';
  if (value.includes('hiatus')) return 'hiatus';
  if (value.includes('cancel') || value.includes('dropped')) return 'cancelled';
  return 'unknown';
}

/* -------------------------------------------------------------------------- */
/* Archive / latest page (`/`, `/page/N/`)                                     */
/* -------------------------------------------------------------------------- */

/** Map one Madara card (.page-item-detail or .c-tabs-item__content row). */
function mapListCard(card: HTMLElement, baseUrl: string): RawListItem | null {
  const titleLink =
    card.querySelector('.post-title h3 a') ??
    card.querySelector('.post-title h5 a') ??
    card.querySelector('.post-title a');
  const sourceUrl = absoluteUrl(titleLink?.getAttribute('href'), baseUrl);
  const nativeId = sourceUrl ? panelNativeIdFromUrl(sourceUrl) : null;
  const title = titleTextOf(titleLink);
  if (!sourceUrl || !nativeId || !title) return null;

  const coverImg = card.querySelector('.item-thumb img, .tab-thumb img');
  const coverUrl = absoluteUrl(coverImg ? pickCoverSrc(coverImg) : null, baseUrl);

  // Newest release is the first chapter item on archive cards.
  const firstChapterItem = card.querySelector('.list-chapter .chapter-item');
  const latestChapterLabel =
    textOf(firstChapterItem?.querySelector('.chapter a')) ??
    textOf(card.querySelector('.latest-chap .chapter a'));

  const updatedRaw =
    textOf(firstChapterItem?.querySelector('.post-on')) ??
    textOf(card.querySelector('.meta-item.post-on'));

  return {
    nativeId,
    title,
    coverUrl,
    sourceUrl,
    status: normalizeStatus(textOf(card.querySelector('.mg_status .summary-content'))),
    genres: card
      .querySelectorAll('.mg_genres .summary-content a')
      .map((a) => textOf(a))
      .filter((g): g is string => g !== null),
    summary: null,
    latestChapterLabel,
    updatedAt: parseSourceDate(updatedRaw),
  };
}

export function parseArchivePage(html: string, baseUrl: string): RawListItem[] {
  const root = parseHtml(html);
  const items: RawListItem[] = [];

  for (const card of root.querySelectorAll('.page-listing-item .page-item-detail')) {
    const item = mapListCard(card, baseUrl);
    if (item) items.push(item);
  }

  // Some Madara variants skip the wrapper — accept bare cards too.
  if (items.length === 0) {
    for (const card of root.querySelectorAll('.page-item-detail')) {
      const item = mapListCard(card, baseUrl);
      if (item) items.push(item);
    }
  }

  return items;
}

/**
 * Full genre catalog from the archive page's `GENRES` block (links to
 * `/genre/<slug>/` with a per-genre count chip). The count `<span>` is
 * stripped before reading the label. Site order is kept; duplicates are
 * dropped.
 */
export function parseGenreCatalog(html: string): string[] {
  const root = parseHtml(html);
  const seen = new Set<string>();
  const genres: string[] = [];
  for (const a of root.querySelectorAll('.c-genres-block .genres a')) {
    a.querySelector('span.count')?.remove();
    const label = textOf(a);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    genres.push(label);
  }
  return genres;
}

/**
 * Archive genre index as label → absolute archive-URL pairs (same markup
 * as the catalog). Lets `latestByGenre` resolve a dropdown label to the
 * exact genre archive instead of guessing slugs.
 */
export function parseGenreLinks(html: string, baseUrl: string): Array<{ label: string; href: string }> {
  const root = parseHtml(html);
  const links: Array<{ label: string; href: string }> = [];
  for (const a of root.querySelectorAll('.c-genres-block .genres a')) {
    a.querySelector('span.count')?.remove();
    const label = textOf(a);
    const href = absoluteUrl(a.getAttribute('href'), baseUrl);
    if (!label || !href) continue;
    links.push({ label, href });
  }
  return links;
}

/* -------------------------------------------------------------------------- */
/* Search results (`/?s=...&post_type=wp-manga`)                               */
/* -------------------------------------------------------------------------- */

export function parseSearchPage(html: string, baseUrl: string): RawListItem[] {
  const root = parseHtml(html);
  const items: RawListItem[] = [];

  for (const row of root.querySelectorAll('.c-tabs-item__content')) {
    const item = mapListCard(row, baseUrl);
    if (item) items.push(item);
  }
  if (items.length === 0) return parseArchivePage(html, baseUrl);

  return items;
}

/**
 * Pagination: Madara renders numbered links ("/page/N/…"); the last page has
 * none pointing beyond it.
 */
export function hasNextNumberedPage(html: string, currentPage: number): boolean {
  const root = parseHtml(html);
  let max = 0;
  for (const a of root.querySelectorAll('a[href]')) {
    const match = /\/page\/(\d+)/.exec(a.getAttribute('href') ?? '');
    if (match?.[1]) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return max > currentPage;
}

/* -------------------------------------------------------------------------- */
/* Panel details page (`/serie/<slug>/`)                                       */
/* -------------------------------------------------------------------------- */

export function parsePanelPage(html: string, sourceUrl: string, baseUrl: string): RawPanelDetails {
  const root = parseHtml(html);

  const profile = root.querySelector('.profile-manga');
  const heading =
    titleTextOf(root.querySelector('.post-title h1')) ?? titleTextOf(profile?.querySelector('h1'));
  const ogTitle = root.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const title = heading ?? (ogTitle ? decodeEntities(ogTitle).trim() : null);
  if (!title || !profile) {
    throw new PageNotRecognizedError('Panel page did not contain the profile container.');
  }

  const nativeId = panelNativeIdFromUrl(sourceUrl) ?? '';

  // Summary rows are generic `.post-content_item` blocks whose `.summary-heading`
  // text names the field ("Alt Name(s)", "Writer(s)", "Genre(s)", ...).
  const rowValue = (label: RegExp): string | null => {
    for (const item of profile.querySelectorAll('.post-content_item')) {
      const headingText = textOf(item.querySelector('.summary-heading'));
      if (headingText && label.test(headingText)) {
        return textOf(item.querySelector('.summary-content'));
      }
    }
    return null;
  };

  const linksInRow = (label: RegExp): string[] => {
    for (const item of profile.querySelectorAll('.post-content_item')) {
      const headingText = textOf(item.querySelector('.summary-heading'));
      if (!headingText || !label.test(headingText)) continue;
      const links = item
        .querySelectorAll('.summary-content a')
        .map((a) => textOf(a))
        .filter((a): a is string => a !== null);
      if (links.length > 0) return links;
    }
    return [];
  };

  const altTitles = (rowValue(/^alt/i) ?? '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const authors = linksInRow(/^writer|^author/i);
  const authorList = authors.length > 0 ? authors : splitList(rowValue(/^writer|^author/i) ?? '');

  const artists = linksInRow(/^artist/i);
  const artistList = artists.length > 0 ? artists : splitList(rowValue(/^artist/i) ?? '');

  let genres = [
    ...profile.querySelectorAll('.genres-content a'),
    ...root.querySelectorAll('.post-content_item .summary-content a[href*="/genre/"]'),
  ]
    .map((a) => textOf(a))
    .filter((g): g is string => g !== null)
    // The two selectors can overlap on some themes — dedupe, keep order.
    .filter((g, i, all) => all.indexOf(g) === i);
  if (genres.length === 0) {
    genres = splitList(rowValue(/^genre/i) ?? '');
  }

  const status = normalizeStatus(rowValue(/^status/i));

  const description =
    textOf(profile.querySelector('.description-summary .summary__content')) ??
    (() => {
      const ogDesc = root.querySelector('meta[property="og:description"]')?.getAttribute('content');
      return ogDesc ? decodeEntities(ogDesc).trim() || null : null;
    })();

  const coverImg = profile.querySelector('.summary_image img, .tab-summary img');
  const coverUrl =
    absoluteUrl(coverImg ? pickCoverSrc(coverImg) : null, baseUrl) ??
    absoluteUrl(root.querySelector('meta[property="og:image"]')?.getAttribute('content'), baseUrl);

  const firstChapterLink = root.querySelector('.wp-manga-chapter a');

  return {
    nativeId,
    title,
    altTitles,
    authors: authorList,
    artists: artistList,
    genres,
    status,
    description,
    coverUrl,
    sourceUrl,
    latestChapterLabel: textOf(firstChapterLink),
  };
}

/** Comma/slash-separated free-text list → trimmed entries. */
function splitList(raw: string): string[] {
  return raw
    .split(/[,/]|\band\b/i)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Site renders ranking badges ("TOP"/"HOT"/"END") inside titles as spans —
 *  exclude their text instead of regex-stripping (real titles may end with
 *  the same words, e.g. "…After the End"). */
export function titleTextOf(el: HTMLElement | null | undefined): string | null {
  if (!el) return null;
  const badge = el.querySelector('span[class*="badge"], .manga-title-badges');
  const text = badge ? (el.text ?? '').replace(badge.text ?? '', ' ') : (el.text ?? '');
  return (
    decodeEntities(text)
      .replace(/\s+/g, ' ')
      .trim() || null
  );
}

/* -------------------------------------------------------------------------- */
/* Chapter list (server-rendered on the panel page)                            */
/* -------------------------------------------------------------------------- */

export function parseChapterList(html: string, baseUrl: string): RawChapterItem[] {
  const root = parseHtml(html);
  const chapters: RawChapterItem[] = [];

  for (const li of root.querySelectorAll('li.wp-manga-chapter')) {
    const link = li.querySelector('a');
    const sourceUrl = absoluteUrl(link?.getAttribute('href'), baseUrl);
    const ref = sourceUrl ? chapterRefFromUrl(sourceUrl) : null;
    const title = textOf(link);
    if (!sourceUrl || !ref || !title) continue;

    chapters.push({
      nativeId: `${ref.panelId}~${ref.token}`,
      panelNativeId: ref.panelId,
      chapterToken: ref.token,
      title,
      chapterNumber: chapterNumberFromToken(ref.token),
      sourceUrl,
      publishedAt: parseSourceDate(
        textOf(li.querySelector('.chapter-release-date i')) ??
          textOf(li.querySelector('.chapter-release-date')),
      ),
    });
  }

  return chapters;
}

/* -------------------------------------------------------------------------- */
/* Chapter reader page (`/serie/<slug>/<chapter-token>/`)                      */
/* -------------------------------------------------------------------------- */

export function parseChapterReaderPage(html: string, baseUrl: string): RawChapterPages {
  const root = parseHtml(html);

  const readingContent = root.querySelector('.reading-content');
  const imageUrls = readingContent
    ? readingContent
        .querySelectorAll('img')
        .map((img) =>
          absoluteUrl(img.getAttribute('data-src') ?? img.getAttribute('src'), baseUrl),
        )
        .filter((u): u is string => u !== null)
        // Drop obvious placeholders/duplicates while preserving order.
        .filter((u, i, all) => all.indexOf(u) === i && !/data:image|lazy/i.test(u))
    : [];

  // Reader heading: "The Beginning After the End - Chapter 249 - One Battle
  // Ends" on some themes, "Title Chapter 249" (no dash) on others.
  const heading = textOf(root.querySelector('#chapter-heading'));
  let panelTitle: string | null = null;
  let readerLabel: string | null = null;
  if (heading) {
    const dashed = /^(.*?)\s*[-–]\s*(Chapter\s.+)$/i.exec(heading);
    const plain = /^(.+?)\s+(Chapter\s.+)$/i.exec(heading);
    const split = dashed ?? plain;
    if (split?.[1] && split[2]) {
      panelTitle = split[1].trim();
      readerLabel = split[2].trim();
    } else {
      panelTitle = heading;
    }
  }

  const coverUrl = absoluteUrl(
    root.querySelector('meta[property="og:image"]')?.getAttribute('content'),
    baseUrl,
  );

  // Explicit prev/next links in the reader nav (rendered twice — top/bottom).
  let prevRef: RawChapterPages['prevRef'] = null;
  let nextRef: RawChapterPages['nextRef'] = null;
  for (const a of root.querySelectorAll('.nav-links a, .select-pagination a')) {
    const label = (a.text ?? '').trim().toLowerCase();
    const ref = chapterRefFromUrl(a.getAttribute('href') ?? '');
    if (!ref) continue;
    if (!prevRef && label === 'prev') prevRef = ref;
    if (!nextRef && label === 'next') nextRef = ref;
    if (prevRef && nextRef) break;
  }

  // Chapter jump <select>: options carry tokens, selected marks the open one.
  const chapterOptions: Array<{ token: string; title: string }> = [];
  let currentToken: string | null = null;
  const select = root.querySelector('select[class*="chapter"]');
  if (select) {
    for (const option of select.querySelectorAll('option')) {
      const value = option.getAttribute('value')?.trim();
      const title = textOf(option);
      if (!value || !title) continue;
      chapterOptions.push({ token: value, title });
      if (option.hasAttribute('selected')) currentToken = value;
    }
  }

  if (imageUrls.length === 0 && !readingContent && chapterOptions.length === 0 && !heading) {
    throw new PageNotRecognizedError('Chapter page did not contain reader data.');
  }

  return {
    imageUrls,
    panelTitle,
    readerLabel,
    coverUrl,
    prevRef,
    nextRef,
    chapterOptions,
    currentToken,
  };
}
