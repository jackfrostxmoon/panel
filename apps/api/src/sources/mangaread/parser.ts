import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import type { PanelStatus } from '@panel/shared';
import { pickCoverSrc } from '../coverImage.js';

/**
 * MangaRead (mangaread.org) HTML parser.
 *
 * WordPress site running the Madara theme. URL layout (verified 2026-08):
 *   archive:  GET {base}/manga/            (ordered by latest update)
 *             GET {base}/manga/page/<n>/   (no pagination markup — probe by url)
 *   search:   GET {base}/?s=<q>&post_type=wp-manga   (single page, no paging)
 *   panel:    GET {base}/manga/<slug>/
 *   chapter:  GET {base}/manga/<slug>/<chapter-token>/  (token = "chapter-N")
 *
 * All HTML parsing lives in this file — pure functions: HTML string in,
 * plain data out. No fetching, no global state, no id prefixing (that is
 * the source adapter's job).
 *
 * Everything is defensive: the source is untrusted and its markup can
 * change at any time, so missing pieces degrade to nulls/empty arrays
 * instead of throwing — except when the page fundamentally is not what we
 * asked for, which is signalled via `PageNotRecognizedError` so the adapter
 * can map it to a proper "not found" API error.
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
  /** Native chapter id: "<slug>~<chapterToken>", e.g. "one-piece~chapter-1014". */
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
  chapterTitle: string | null;
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

/** "one-piece" from "https://www.mangaread.org/manga/one-piece/" or ".../chapter-4-5/". */
export function panelNativeIdFromUrl(url: string): string | null {
  const match = /\/manga\/([^/?#]+)/i.exec(url);
  const slug = match?.[1];
  if (!slug || /^chapter-/i.test(slug)) return null; // skip chapter path segment
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

/** { panelId: "one-piece", token: "chapter-1014" } from a chapter URL. */
export function chapterRefFromUrl(url: string): { panelId: string; token: string } | null {
  const match = /\/manga\/([^/?#]+)\/(chapter-[^/?#]+)/i.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { panelId: match[1], token: match[2].replace(/\/+$/, '') };
}

/**
 * "chapter-271" → 271, "chapter-4-5" → 4.5 (Madara encodes decimal points as
 * dashes in urls). Some urls append a title slug after the number
 * ("chapter-32-the-time-we-cant-meet") — the extra fragment is ignored.
 * Anything else (e.g. "epilogue") → null.
 */
export function chapterNumberFromToken(token: string): number | null {
  const match = /^chapter-(\d+(?:-\d+)*)/i.exec(token);
  if (!match?.[1]) return null;
  const value = Number.parseFloat(match[1].replace(/-/g, '.'));
  return Number.isFinite(value) ? value : null;
}

const RELATIVE_UNITS: Record<string, number> = {
  sec: 1000,
  second: 1000,
  min: 60_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000, // 30 days — site granularity is coarse anyway
  year: 31_536_000_000, // 365 days
};

/**
 * Parse MangaRead release dates into ISO strings:
 *  - relative:  "just now", "13 mins ago", "2 hours ago", "3 days ago"
 *  - dotted:    "17.08.2026"
 *  - sql-ish:   "2024-04-07 13:26:02"
 * Returns null for anything unrecognised.
 */
export function parseSourceDate(raw: string | null): string | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();

  // Relative ("2 hours ago").
  const rel = /^(?:about|over|almost)?\s*(\d+)\s+(sec|second|min|minute|hour|day|week|month|year)s?\s+ago$/.exec(
    text,
  );
  if (rel?.[1] && rel[2]) {
    const ms = Number.parseInt(rel[1], 10) * (RELATIVE_UNITS[rel[2]] ?? 0);
    if (ms > 0) return new Date(Date.now() - ms).toISOString();
  }
  if (text === 'just now' || text === 'now') return new Date().toISOString();

  // Dotted absolute ("17.08.2026") — treated as UTC midnight.
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
  if (dotted?.[1] && dotted[2] && dotted[3]) {
    const date = new Date(Date.UTC(+dotted[3], +dotted[2] - 1, +dotted[1]));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  // SQL-ish datetime ("2024-04-07 13:26:02") — site renders local times with
  // no zone; interpret as UTC for stable output.
  const sql = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(raw.trim());
  if (sql) {
    const date = new Date(`${sql[1]}T${sql[2]}Z`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  // Last resort: let the platform try.
  const fallback = new Date(raw.trim());
  return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
}

export function normalizeStatus(raw: string | null): PanelStatus {
  if (!raw) return 'unknown';
  const value = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (value.includes('ongoing')) return 'ongoing';
  if (value.includes('completed') || value.includes('complete')) return 'completed';
  if (value.includes('hiatus') || value.includes('onhold')) return 'hiatus';
  if (value.includes('cancel') || value.includes('dropped')) return 'cancelled';
  return 'unknown';
}

/** Comma/slash-separated free-text list → trimmed entries. */
function splitList(raw: string): string[] {
  return raw
    .split(/[,/]|\band\b/i)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/* -------------------------------------------------------------------------- */
/* Archive / latest page (`/manga/`, `/manga/page/N/`)                         */
/* -------------------------------------------------------------------------- */

export function parseArchivePage(html: string, baseUrl: string): RawListItem[] {
  const root = parseHtml(html);
  const items: RawListItem[] = [];

  for (const card of root.querySelectorAll('.page-item-detail')) {
    const titleLink = card.querySelector('.post-title a');
    const sourceUrl = absoluteUrl(titleLink?.getAttribute('href'), baseUrl);
    const nativeId = sourceUrl ? panelNativeIdFromUrl(sourceUrl) : null;
    const title = textOf(titleLink);
    if (!sourceUrl || !nativeId || !title) continue;

    const coverImg = card.querySelector('.item-thumb img');
    const coverUrl = absoluteUrl(coverImg ? pickCoverSrc(coverImg) : null, baseUrl);

    // First .chapter-item is the newest release for this panel.
    const firstChapterItem = card.querySelector('.list-chapter .chapter-item');
    const latestChapterLabel = textOf(firstChapterItem?.querySelector('.chapter a'));
    const updatedRaw =
      textOf(firstChapterItem?.querySelector('.post-on')) ??
      textOf(firstChapterItem?.querySelector('.post-on i'));

    items.push({
      nativeId,
      title,
      coverUrl,
      sourceUrl,
      status: 'unknown', // not shown on archive cards
      genres: [],
      summary: null,
      latestChapterLabel,
      updatedAt: parseSourceDate(updatedRaw),
    });
  }

  return items;
}

/**
 * Full genre catalog from the nav `Genres` sub-menu (taxonomy menu items,
 * rendered on every page). Site order is kept; duplicates are dropped.
 */
export function parseGenreCatalog(html: string): string[] {
  const root = parseHtml(html);
  const seen = new Set<string>();
  const genres: string[] = [];
  for (const a of root.querySelectorAll('.menu-item-object-wp-manga-genre a')) {
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
  for (const a of root.querySelectorAll('.menu-item-object-wp-manga-genre a')) {
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
    const titleLink = row.querySelector('.post-title h3 a');
    const sourceUrl = absoluteUrl(titleLink?.getAttribute('href'), baseUrl);
    const nativeId = sourceUrl ? panelNativeIdFromUrl(sourceUrl) : null;
    const title = textOf(titleLink);
    if (!sourceUrl || !nativeId || !title) continue;

    const coverImg = row.querySelector('.tab-thumb img');
    const coverUrl = absoluteUrl(coverImg ? pickCoverSrc(coverImg) : null, baseUrl);

    const genres = row
      .querySelectorAll('.mg_genres .summary-content a')
      .map((a) => textOf(a))
      .filter((g): g is string => g !== null);

    const status = normalizeStatus(textOf(row.querySelector('.mg_status .summary-content')));

    const latestChapterLabel = textOf(row.querySelector('.latest-chap .chapter a'));
    const updatedRaw = textOf(row.querySelector('.meta-item.post-on'));

    items.push({
      nativeId,
      title,
      coverUrl,
      sourceUrl,
      status,
      genres,
      // Madara search rows do not include the synopsis.
      summary: textOf(row.querySelector('.tab-summary .summary__content')),
      latestChapterLabel,
      updatedAt: parseSourceDate(updatedRaw),
    });
  }

  return items;
}

/* -------------------------------------------------------------------------- */
/* Panel details page (`/manga/<slug>/`)                                       */
/* -------------------------------------------------------------------------- */

export function parsePanelPage(html: string, sourceUrl: string, baseUrl: string): RawPanelDetails {
  const root = parseHtml(html);

  const profile = root.querySelector('.profile-manga');
  const heading = textOf(root.querySelector('.post-title h1')) ?? textOf(profile?.querySelector('h1'));
  const ogTitle = root.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const title = heading ?? (ogTitle ? decodeEntities(ogTitle).trim() : null);
  if (!title || !profile) {
    throw new PageNotRecognizedError('Panel page did not contain the profile container.');
  }

  const nativeId = panelNativeIdFromUrl(sourceUrl) ?? '';

  // Summary rows are generic `.post-content_item` blocks whose `.summary-heading`
  // text names the field ("Alternative", "Author(s)", "Status", ...).
  const rowValue = (label: RegExp): string | null => {
    for (const item of root.querySelectorAll('.post-content_item')) {
      const heading = textOf(item.querySelector('.summary-heading'));
      if (heading && label.test(heading)) return textOf(item.querySelector('.summary-content'));
    }
    return null;
  };

  const linksInRow = (label: RegExp): string[] => {
    for (const item of root.querySelectorAll('.post-content_item')) {
      const heading = textOf(item.querySelector('.summary-heading'));
      if (!heading || !label.test(heading)) continue;
      const links = item
        .querySelectorAll('.summary-content a')
        .map((a) => textOf(a))
        .filter((a): a is string => a !== null);
      if (links.length > 0) return links;
    }
    return [];
  };

  const altTitles = splitList(rowValue(/^alternative/i) ?? '');

  const authors = linksInRow(/^author/i);
  const authorList =
    authors.length > 0 ? authors : splitList(rowValue(/^author/i) ?? '');

  const artists = linksInRow(/^artist/i);
  const artistList =
    artists.length > 0 ? artists : splitList(rowValue(/^artist/i) ?? '');

  let genres = [
    ...profile.querySelectorAll('.genres-content a'),
    ...root.querySelectorAll('.post-content_item .summary-content a[href*="/genres/"]'),
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
    textOf(root.querySelector('.description-summary .summary__content')) ??
    (() => {
      const ogDesc = root
        .querySelector('meta[property="og:description"]')
        ?.getAttribute('content');
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
      publishedAt: parseSourceDate(textOf(li.querySelector('.chapter-release-date i'))),
    });
  }

  return chapters;
}

/* -------------------------------------------------------------------------- */
/* Chapter reader page (`/manga/<slug>/<chapter-token>/`)                      */
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
    : [];

  // "The Great Mage Returns After 4000 Years - Chapter 270"
  const heading = textOf(root.querySelector('#chapter-heading'));
  let panelTitle: string | null = null;
  let chapterTitle: string | null = null;
  if (heading) {
    const idx = heading.lastIndexOf('- Chapter ');
    if (idx > 0) {
      panelTitle = heading.slice(0, idx).trim();
      chapterTitle = heading.slice(idx + 1).trim();
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

  // Chapter jump <select>: options carry tokens ("chapter-270"), the selected
  // one marks the open chapter.
  const chapterOptions: Array<{ token: string; title: string }> = [];
  let currentToken: string | null = null;
  const select = root.querySelector('select[class*="chapter"]');
  if (select) {
    for (const option of select.querySelectorAll('option')) {
      const token = option.getAttribute('value')?.trim();
      const title = textOf(option);
      if (!token || !title) continue;
      chapterOptions.push({ token, title });
      if (option.hasAttribute('selected')) currentToken = token;
    }
  }

  if (imageUrls.length === 0 && !readingContent && chapterOptions.length === 0 && !heading) {
    throw new PageNotRecognizedError('Chapter page did not contain reader data.');
  }

  return {
    imageUrls,
    panelTitle,
    chapterTitle,
    coverUrl,
    prevRef,
    nextRef,
    chapterOptions,
    currentToken,
  };
}
