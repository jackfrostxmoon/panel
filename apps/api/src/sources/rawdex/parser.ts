import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import type { PanelStatus } from '@panel/shared';
import { pickCoverSrc } from '../coverImage.js';

/**
 * RawDex (rawdex.net) HTML parser.
 *
 * rawdex.net is a WordPress (Madara) site with a fully custom "rawdex-nova"
 * theme (`rdx-*` class prefixes). Pure functions: HTML string in → plain data
 * out. No fetching, no global state, no id prefixing (that is the source
 * adapter's job).
 *
 * Everything is defensive: missing pieces degrade to nulls/empty arrays
 * instead of throwing — except when the page fundamentally is not what we
 * asked for, which is signalled via `PageNotRecognizedError` so the adapter
 * can map it to a proper "not found" API error.
 *
 * Selectors were verified against live pages (2026-08) and are kept in one
 * place (this file) so a site redesign only touches this module.
 *
 * Page inventory:
 *   search/latest cards : article.rdx-library-card / article.rdx-home-card
 *   panel detail        : dl.rdx-manga-meta + a.rdx-chapter-row list
 *   reader              : .rdx-longstrip-pages figure > img (img.rawdex.net)
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
  updatedAt: null;
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
  /** Native chapter id: "<panelSlug>~<chapterNumber>" e.g. "tentacle-hole~4". */
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

function textOf(el: HTMLElement | null | undefined): string | null {
  const text = (el?.text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
}

function absoluteUrl(href: string | undefined | null, baseUrl: string): string | null {
  if (!href) return null;
  try {
    return new URL(href.trim(), baseUrl).toString();
  } catch {
    return null;
  }
}

export function normalizeStatus(raw: string | null): PanelStatus {
  if (!raw) return 'unknown';
  // The site writes "on-going"; collapse separators before matching.
  const value = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (value.includes('ongoing') || value.includes('updating')) return 'ongoing';
  if (value.includes('complete')) return 'completed';
  if (value.includes('hiatus') || value.includes('paused')) return 'hiatus';
  if (value.includes('cancel') || value.includes('drop')) return 'cancelled';
  return 'unknown';
}

/** "<slug>" from "https://rawdex.net/manga/<slug>/" — own host only. */
export function panelNativeIdFromUrl(url: string): string | null {
  const match = /\/manga\/([^/?#]+)\/?$/i.exec(url);
  if (!match?.[1]) return null;
  return match[1];
}

/**
 * { panelId, token } from a chapter url:
 *   "https://rawdex.net/manga/<slug>/13" → { panelId: slug, token: "13" }
 */
export function readerRefFromUrl(url: string): { panelId: string; token: string } | null {
  const match = /\/manga\/([^/?#]+)\/(\d+(?:[.-]\d+)*)\/?$/i.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { panelId: match[1], token: match[2] };
}

/** "13.5" → 13.5; anything else → null. Tokens are plain decimal numbers. */
export function chapterNumberFromToken(token: string): number | null {
  const num = Number(token);
  return Number.isFinite(num) ? num : null;
}

/**
 * Cover images are served through the WordPress image CDN
 * ("https://i0.wp.com/rawdex.net/wp-content/…?fit=…&ssl=1"). Rewrite those
 * back to the origin path so every URL stays inside the SSRF allowlist.
 */
export function normalizeCoverUrl(url: string | null): string | null {
  if (!url) return null;
  const wpMirror = /^https?:\/\/i\d\.wp\.com\/(.+)$/i.exec(url);
  if (wpMirror?.[1]) {
    try {
      const restored = new URL(`https://${wpMirror[1]}`);
      restored.search = '';
      return restored.toString();
    } catch {
      return null;
    }
  }
  return url;
}

function metaContent(root: HTMLElement, selector: string): string | null {
  const el = root.querySelector(selector);
  const content = el?.getAttribute('content');
  const text = content?.replace(/\s+/g, ' ').trim();
  return text && text.length > 0 ? text : null;
}

/* -------------------------------------------------------------------------- */
/* Search / latest list pages                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Parse a card grid page. The home page's "Latest releases" section
 * (.rdx-home-section--latest) is preferred when present — other sections on
 * that page (top-rated etc.) must not leak into the feed. Search pages have
 * no section wrapper, so every card article is considered there.
 *
 * Cards are `article.rdx-search-card` / `article.rdx-home-card` /
 * `article.rdx-library-card` with a cover link (aria-label = title), an
 * <h2>/<h3> title, a status chip and up to two recent-chapter links.
 */
export function parseListPage(html: string, baseUrl: string): RawListItem[] {
  const root = parseHtml(html);
  const scope = root.querySelector('.rdx-home-section--latest') ?? root;
  const items: RawListItem[] = [];
  const seen = new Set<string>();

  for (const article of scope.querySelectorAll('article')) {
    // Prefer the dedicated cover link for the href.
    const coverLink =
      article.querySelector('a[class*="cover"]') ??
      article.querySelector('a[href*="/manga/"] h2 a') ??
      article.querySelector('a[href*="/manga/"]');
    const href = absoluteUrl(coverLink?.getAttribute('href'), baseUrl);
    if (!href) continue;

    const ref = panelNativeIdFromUrl(href);
    if (!ref || seen.has(ref)) continue;

    const titleEl =
      article.querySelector('[class*="__body"] h2 a, [class*="__body"] h3 a') ??
      article.querySelector('h2 a, h3 a');
    const ariaLabel = coverLink?.getAttribute('aria-label') ?? null;
    const title = textOf(titleEl) ?? stripOpenPrefix(ariaLabel);

    const img = coverLink?.querySelector('img') ?? article.querySelector('img');
    const coverUrl = normalizeCoverUrl(absoluteUrl(img ? pickCoverSrc(img) : null, baseUrl));

    const statusText = textOf(article.querySelector('[class*="status"]'));

    // Newest chapter link inside the card ("Chapter 15" / "Chapter 06").
    const firstChapterSpan = article.querySelector(
      '[class*="chapters"] a[href*="/manga/"] span',
    );
    const latestChapterLabel = textOf(firstChapterSpan);

    seen.add(ref);
    items.push({
      nativeId: ref,
      title: title ?? ref,
      coverUrl,
      sourceUrl: `${baseUrl}/manga/${ref}/`,
      status: normalizeStatus(statusText),
      genres: [],
      summary: metaContent(root, 'meta[property="og:description"]'),
      latestChapterLabel,
      updatedAt: null,
    });
  }

  return items;
}

/** "Open I Drank the Love Potion Instead of My Husband" → title part. */
function stripOpenPrefix(ariaLabel: string | null): string | null {
  if (!ariaLabel) return null;
  return ariaLabel.replace(/^open\s+/i, '').trim() || null;
}

/** Does a paginated grid have a next page? (rel=next or /page/<n+1>/ link) */
export function hasNextPage(html: string, currentPage: number): boolean {
  const relNext = /<link[^>]+rel="next"[^>]*>/i.test(html);
  if (relNext) return true;
  const nextPage = new RegExp(`href="[^"]*/page/${currentPage + 1}/?"`, 'i').test(html);
  return nextPage;
}

/* -------------------------------------------------------------------------- */
/* Panel detail page                                                           */
/* -------------------------------------------------------------------------- */

/** dt/dd pairs of the meta definition list → { label: value }. */
function parseMetaList(root: HTMLElement): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of root.querySelectorAll('dl div')) {
    const label = textOf(group.querySelector('dt'));
    const value = textOf(group.querySelector('dd'));
    if (label && value) map.set(label.toLowerCase(), value);
  }
  return map;
}

function splitNames(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,;/]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Best-effort display label → genre archive slug (`/manga-genre/<slug>/`).
 * RawDex publishes no genre index, so slugs are derived from the label;
 * `latestByGenre` treats an unreachable archive as an unresolvable label
 * and falls back to the unfiltered listing.
 */
export function slugifyGenre(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function parsePanelPage(
  html: string,
  sourceUrl: string,
  _baseUrl: string,
): RawPanelDetails {
  const root = parseHtml(html);

  const title =
    textOf(root.querySelector('.rdx-manga-heading h1')) ??
    textOf(root.querySelector('h1')) ??
    metaContent(root, 'meta[property="og:title"]')?.replace(/\s*-\s*RawDEX\s*$/i, '') ??
    null;
  if (!title) {
    throw new PageNotRecognizedError('Panel page did not contain a title.');
  }

  const ref = panelNativeIdFromUrl(sourceUrl);
  if (!ref) {
    throw new PageNotRecognizedError('Could not derive the panel native id.');
  }

  const meta = parseMetaList(root);
  // Genres live in the `.rdx-manga-tags` chip row (links to
  // /manga-genre/<slug>/); the meta `dl` carries no genre entry on the
  // live site, but keep it as a fallback for theme variants.
  const tagGenres = root
    .querySelectorAll('.rdx-manga-tags a')
    .map((a) => textOf(a))
    .filter((g): g is string => g !== null && g.length > 0);
  const description =
    metaContent(root, 'meta[property="og:description"]') ??
    metaContent(root, 'meta[name="description"]');
  const coverUrl = normalizeCoverUrl(metaContent(root, 'meta[property="og:image"]'));
  const statusWord =
    textOf(root.querySelector('[class*="status"]')) ??
    textOf(root.querySelector('.rdx-manga-status'));

  return {
    nativeId: ref,
    title,
    altTitles: [],
    authors: splitNames(meta.get('author')),
    artists: splitNames(meta.get('artist')),
    genres: tagGenres.length > 0 ? [...new Set(tagGenres)] : splitNames(meta.get('genre')),
    status: normalizeStatus(statusWord),
    description,
    coverUrl,
    sourceUrl,
    latestChapterLabel: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Chapter list (server-rendered on the panel detail page)                      */
/* -------------------------------------------------------------------------- */

/**
 * Parse `a.rdx-chapter-row` rows. Newest-first on the wire; the caller sorts.
 * Dates are relative strings ("2 days ago") with no machine-readable value,
 * so publishedAt stays null.
 */
export function parseChapterList(html: string, baseUrl: string): RawChapterItem[] {
  const root = parseHtml(html);
  const chapters: RawChapterItem[] = [];

  for (const row of root.querySelectorAll('a[class*="chapter-row"]')) {
    const href = absoluteUrl(row.getAttribute('href'), baseUrl);
    const ref = href ? readerRefFromUrl(href) : null;
    if (!ref) continue;

    const label = textOf(row.querySelector('[class*="label"]')) ?? `Chapter ${ref.token}`;
    chapters.push({
      nativeId: `${ref.panelId}~${ref.token}`,
      panelNativeId: ref.panelId,
      chapterToken: ref.token,
      title: label,
      chapterNumber: chapterNumberFromToken(ref.token),
      sourceUrl: href!,
      publishedAt: null,
    });
  }

  return chapters;
}

/* -------------------------------------------------------------------------- */
/* Chapter reader page                                                         */
/* -------------------------------------------------------------------------- */

export function parseChapterReaderPage(html: string, baseUrl: string): RawChapterPages {
  const root = parseHtml(html);

  // Reader images live inside .rdx-longstrip-pages figures; fall back to any
  // WordPress chapter image class.
  const imageUrls: string[] = [];
  const imgSelector =
    '.rdx-longstrip-pages figure img, .reading-content img.wp-manga-chapter-img';
  for (const img of root.querySelectorAll(imgSelector)) {
    const url = absoluteUrl((img.getAttribute('src') ?? '').trim() || null, baseUrl);
    if (url) imageUrls.push(url);
  }

  const titleTag = textOf(root.querySelector('title'));
  // "<Panel> - <Chapter> - RawDEX" → [panel, chapterLabel, site]. The middle
  // part is the bare chapter number ("13").
  const titleParts =
    titleTag
      ?.split(/\s+-\s+/)
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  const head = titleParts[0] ?? null;
  const midLabel = titleParts.length >= 3 ? titleParts[1] ?? null : null;

  const panelTitle =
    textOf(root.querySelector('.rdx-reader-end h2')) ??
    textOf(root.querySelector('.rdx-reader-title a')) ??
    (head ? head.replace(/\s+chapter\b.*$/i, '').trim() || null : null);

  // Reader label: "13" → "Chapter 13"; non-numeric labels pass through.
  let readerLabel: string | null;
  if (midLabel) {
    readerLabel = /^\d+(?:\.\d+)?$/.test(midLabel) ? `Chapter ${midLabel}` : midLabel;
  } else if (head && panelTitle && head.startsWith(`${panelTitle} `)) {
    readerLabel = head.slice(panelTitle.length + 1).trim() || head;
  } else {
    readerLabel = head;
  }

  const coverUrl = normalizeCoverUrl(metaContent(root, 'meta[property="og:image"]'));

  // Prev/next chapter links in the end-of-chapter navigation.
  const prevRef = refFromNavLink(root.querySelector('a[class*="chapter-link--previous"]'));
  const nextRef = refFromNavLink(root.querySelector('a[class*="chapter-link--next"]'));

  if (imageUrls.length === 0 && !readerLabel && !panelTitle) {
    throw new PageNotRecognizedError('Chapter page did not contain reader data.');
  }

  return {
    imageUrls,
    panelTitle,
    readerLabel,
    coverUrl,
    publishedAt: null,
    prevRef,
    nextRef,
  };
}

function refFromNavLink(el: HTMLElement | null): { panelId: string; token: string } | null {
  const href = el?.getAttribute('href');
  if (!href || href === '#' || href.trim() === '') return null;
  return readerRefFromUrl(href);
}
