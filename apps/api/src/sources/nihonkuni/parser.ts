import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import type { PanelStatus } from '@panel/shared';

/**
 * NihonKuni (nihonkuni.com) HTML parser.
 *
 * nihonkuni.com is a custom-built (non-WordPress) raw panel site. Pure
 * functions: HTML string in → plain data out. No fetching, no global state,
 * no id prefixing (that is the source adapter's job).
 *
 * Everything is defensive, mirroring the MangaKatana parsers: the
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
  /** Native chapter id: "<panelSlug>~chapter-<n>", e.g. "one-piece-raw~chapter-1190". */
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
  /** All chapters listed in the reader sidebar (newest-first). */
  chapterOptions: Array<{ token: string; title: string }>;
  /** The token of the currently open chapter. */
  currentToken: string | null;
  /** Panel title from the reader header. */
  panelTitle: string | null;
  /** "Chapter N" heading from the reader page. */
  readerLabel: string | null;
  /** Cover image URL (og:image), used for continue-reading metadata. */
  coverUrl: string | null;
  /** ISO timestamp from article:published_time (only present on reader pages). */
  publishedAt: string | null;
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

/**
 * Cover image for an element. NihonKuni renders covers in two ways:
 *   - `style="background-image: url('...')"` on `a.manga-cover` (list cards)
 *   - `data-bg="..."` on lazy `a.manga-cover`
 *   - `data-original="..."` / `src` on `img.manga-cover-image` (detail page)
 */
function coverUrlOf(el: HTMLElement | null | undefined, baseUrl: string): string | null {
  if (!el) return null;
  const dataBg = el.getAttribute('data-bg')?.trim();
  if (dataBg && !isCoverPlaceholder(dataBg)) return absoluteUrl(dataBg, baseUrl);
  const style = el.getAttribute('style') ?? '';
  // Pagespeed mangles some covers by injecting an onload attribute INSIDE the
  // url('...') quotes (url('….jpg" data-pagespeed-url-hash="…" …')), which
  // makes the HTML parser truncate the style attribute at the first stray `"`.
  // So: capture everything after url( with no requirement on a closing quote,
  // then cut at the first stray quote — the clean URL survives either way.
  const bg = /background-image\s*:\s*url\(\s*['"]?([^)]*)/i.exec(style);
  const bgUrl = bg?.[1];
  if (bgUrl) {
    const clean = (bgUrl.split(/['"]/, 1)[0] ?? '').trim();
    return absoluteUrl(clean || null, baseUrl);
  }
  const src =
    el.getAttribute('data-original') ??
    el.getAttribute('data-src') ??
    el.getAttribute('data-lazy-src') ??
    el.getAttribute('data-lazy') ??
    el.getAttribute('src');
  const trimmed = src?.trim() ?? null;
  if (trimmed && !isCoverPlaceholder(trimmed)) return absoluteUrl(trimmed, baseUrl);
  // Lazy `srcset` variants (first candidate wins).
  for (const attr of ['srcset', 'data-srcset']) {
    const first = firstSrcsetCandidate(el.getAttribute(attr));
    if (first && !isCoverPlaceholder(first)) return absoluteUrl(first, baseUrl);
  }
  return null;
}

/** Placeholder `src` values that must not become covers (case-insensitive). */
function isCoverPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.startsWith('data:image/') || lower.includes('blank.gif') || lower.includes('lazyload')
  );
}

/** First URL of a `srcset` list (`"a.jpg 1x, b.jpg 2x"` → `"a.jpg"`). */
function firstSrcsetCandidate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const first = raw.split(',')[0]?.trim().split(/\s+/)[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/**
 * "one-piece-raw" from "https://nihonkuni.com/manga-one-piece-raw.html"
 * (redirect form) or "https://nihonkuni.com/manga/one-piece-raw-12345.html"
 * (detail form).
 *
 * The detail form ALWAYS carries the site's numeric panel id as a trailing
 * `-<digits>` segment, and the redirect form NEVER does — so the strip
 * applies to `/manga/…` URLs only. Stripping it unconditionally would
 * corrupt redirect URLs whose real slug ends in digits (e.g.
 * `/manga-kaiju-no-8.html`) and, worse, would mint ids (`…-5969`) that the
 * site's redirect endpoint 404s on — which is exactly what used to make
 * pasted detail links unresolvable while the same panel opened fine from
 * Latest (whose cards link the redirect form).
 */
export function panelNativeIdFromUrl(url: string): string | null {
  const detail = /\/manga\/([^/?#]+?)-(\d+)\.html$/i.exec(url);
  if (detail?.[1]) return detail[1];
  const redirect = /\/manga-([^/?#]+)\.html$/i.exec(url);
  if (redirect?.[1]) return redirect[1];
  // Detail URL without a numeric suffix (not observed on the live site,
  // but tolerated so such links keep resolving instead of 404ing the
  // resolve step).
  const bareDetail = /\/manga\/([^/?#]+)\.html$/i.exec(url);
  return bareDetail?.[1] ?? null;
}



/**
 * { panelId: "one-piece-raw", token: "chapter-1190" } from a chapter URL:
 *   "read-one-piece-raw-chapter-1190.html"
 *   "read-dandadan-chapter-244.1646023630.html"  (cache-busted reader href)
 * The panel id is greedy so the LAST "-chapter-" is treated as the separator.
 */
export function readerRefFromUrl(url: string): { panelId: string; token: string } | null {
  const match = /^read-(.+)-chapter-(.+?)\.html$/i.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { panelId: match[1], token: `chapter-${match[2]}` };
}

/**
 * "chapter-1190" → 1190, "chapter-20.1" → 20.1, "chapter-244.1646023630" → 244
 * (the `.1234567890` suffix is a cache-busting id, not a decimal), "chapter-0"
 * → 0, anything else → null.
 */
export function chapterNumberFromToken(token: string): number | null {
  const match = /^chapter-(\d+)(?:\.(\d+))?$/i.exec(token);
  if (!match) return null;
  const whole = Number.parseInt(match[1]!, 10);
  const frac = match[2];
  if (frac && frac.length <= 2) return Number(`${whole}.${frac}`);
  return whole;
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

/** The h1 title is base64 ("data-enc"); decode it, falling back to its text. */
export function decodeDataEnc(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8').trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/** "Last chapter: 20.1" → "Chapter 20.1"; "Chapter 18.2" stays as-is. */
function normalizeChapterLabel(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.replace(/^last\s+chapter\s*:\s*/i, '').trim();
  if (/^chapter\b/i.test(value)) return value;
  return value.length > 0 ? `Chapter ${value}` : null;
}

/** Link texts inside a `.manga-info-item` whose label contains `labelMatch`. */
function infoItemLinks(scope: HTMLElement, labelMatch: string): string[] {
  for (const item of scope.querySelectorAll('.manga-info-item')) {
    const label = textOf(item.querySelector('.info-field-label'));
    if (label && label.toLowerCase().includes(labelMatch)) {
      return item
        .querySelectorAll('.info-field-value a')
        .map((a) => textOf(a))
        .filter((t): t is string => t !== null);
    }
  }
  return [];
}

/** Raw text of a `.manga-info-item` value whose label contains `labelMatch`. */
function infoItemText(scope: HTMLElement, labelMatch: string): string | null {
  for (const item of scope.querySelectorAll('.manga-info-item')) {
    const label = textOf(item.querySelector('.info-field-label'));
    if (label && label.toLowerCase().includes(labelMatch)) {
      return textOf(item.querySelector('.info-field-value'));
    }
  }
  return null;
}

/** article:published_time (with timezone) → ISO; absent/invalid → null. */
function publishedTimeFromMeta(root: HTMLElement): string | null {
  const raw = root
    .querySelector('meta[property="article:published_time"]')
    ?.getAttribute('content');
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/* -------------------------------------------------------------------------- */
/* List pages (search + latest share the same `.manga-card` grid)              */
/* -------------------------------------------------------------------------- */

export function parseListPage(html: string, baseUrl: string): RawListItem[] {
  const root = parseHtml(html);
  const items: RawListItem[] = [];

  for (const card of root.querySelectorAll('.manga-card')) {
    const titleLink = card.querySelector('a.manga-title');
    const sourceUrl = absoluteUrl(titleLink?.getAttribute('href'), baseUrl);
    const nativeId = sourceUrl ? panelNativeIdFromUrl(sourceUrl) : null;
    const title = textOf(titleLink);
    if (!sourceUrl || !nativeId || !title) continue;

    items.push({
      nativeId,
      title,
      coverUrl: coverUrlOf(card.querySelector('a.manga-cover'), baseUrl),
      sourceUrl,
      status: 'unknown',
      genres: [],
      summary: null,
      latestChapterLabel: normalizeChapterLabel(textOf(card.querySelector('a.manga-chap'))),
      updatedAt: null, // "2 minutes ago" style labels are not parseable
    });
  }

  return items;
}

/** Pagination: `.page-link.next` is an <a> while results remain; a disabled
 *  `<span class="page-link next">` appears on the last page. */
export function hasNextPage(html: string): boolean {
  const root = parseHtml(html);
  return root.querySelector('a.page-link.next') !== null;
}

/**
 * Full genre catalog from the navbar `.genres-grid` (rendered on every
 * page, including the manga list). Site order is kept; blank and duplicate
 * entries are dropped.
 */
export function parseGenreCatalog(html: string): string[] {
  const root = parseHtml(html);
  const seen = new Set<string>();
  const genres: string[] = [];
  for (const a of root.querySelectorAll('.genres-grid a.genre-item')) {
    const label = textOf(a);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    genres.push(label);
  }
  return genres;
}

/**
 * Navbar genre index as label → absolute archive-url pairs (same markup as
 * the catalog). Lets `latestByGenre` resolve a dropdown label to the exact
 * site URL instead of guessing slugs.
 */
export function parseGenreLinks(html: string, baseUrl: string): Array<{ label: string; href: string }> {
  const root = parseHtml(html);
  const links: Array<{ label: string; href: string }> = [];
  for (const a of root.querySelectorAll('.genres-grid a.genre-item')) {
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

  const titleEl = root.querySelector('h1.manga-main-title');
  const title = decodeDataEnc(titleEl?.getAttribute('data-enc') ?? null) ?? textOf(titleEl);
  if (!title) {
    throw new PageNotRecognizedError('Panel page did not contain a title.');
  }

  const nativeId =
    panelNativeIdFromUrl(sourceUrl) ?? root.querySelector('.h0rating')?.getAttribute('slug') ?? '';
  const coverEl = root.querySelector('img.manga-cover-image');
  const latestChapterRow = root.querySelector('#chapters_raw_data a');
  const latestChapterLabel =
    textOf(latestChapterRow?.querySelector('.chapter-name')) ?? textOf(latestChapterRow);

  return {
    nativeId,
    title,
    altTitles: (infoItemText(root, 'other names') ?? '')
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean),
    authors: infoItemLinks(root, 'author'),
    artists: infoItemLinks(root, 'artist'),
    genres: infoItemLinks(root, 'genre'),
    status: normalizeStatus(infoItemLinks(root, 'status').join(' ')),
    description: textOf(root.querySelector('.manga-description-section .description-text-content')),
    coverUrl:
      coverUrlOf(coverEl, baseUrl) ??
      absoluteUrl(
        root.querySelector('meta[property="og:image"]')?.getAttribute('content'),
        baseUrl,
      ),
    sourceUrl,
    latestChapterLabel,
  };
}

/* -------------------------------------------------------------------------- */
/* Chapter list (on the panel page)                                            */
/* -------------------------------------------------------------------------- */

export function parseChapterList(html: string, baseUrl: string): RawChapterItem[] {
  const root = parseHtml(html);
  const chapters: RawChapterItem[] = [];

  for (const row of root.querySelectorAll('#chapters_raw_data a')) {
    const href = row.getAttribute('href');
    const sourceUrl = absoluteUrl(href, baseUrl);
    const title = textOf(row.querySelector('.chapter-name')) ?? textOf(row);
    const ref = href ? readerRefFromUrl(href) : null;
    if (!sourceUrl || !title || !ref) continue;

    chapters.push({
      nativeId: `${ref.panelId}~${ref.token}`,
      panelNativeId: ref.panelId,
      chapterToken: ref.token,
      title,
      chapterNumber: chapterNumberFromToken(ref.token),
      sourceUrl,
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

  const imageUrls: string[] = [];
  for (const img of root.querySelectorAll('#chapter_images_container img')) {
    const src = (img.getAttribute('src') ?? '').trim();
    const url = absoluteUrl(src || null, baseUrl);
    if (url) imageUrls.push(url);
  }

  const coverUrl = absoluteUrl(
    root.querySelector('meta[property="og:image"]')?.getAttribute('content'),
    baseUrl,
  );

  const panelTitle = textOf(root.querySelector('.manga-title-header a'));

  const chapterHeading = textOf(root.querySelector('.chapter-title-header'));
  // Header reads "Chapter 1190 - Chapter 1190"; keep the first half.
  const readerLabel = chapterHeading ? chapterHeading.split(' - ')[0]!.trim() : null;

  // Full chapter navigation lives in the reader sidebar (newest-first).
  const chapterOptions: Array<{ token: string; title: string }> = [];
  let currentToken: string | null = null;
  for (const li of root.querySelectorAll('ul.chapters-list-sidebar li')) {
    const href = li.querySelector('a')?.getAttribute('href');
    const ref = href ? readerRefFromUrl(href) : null;
    const label = textOf(li.querySelector('a'));
    if (!ref || !label) continue;
    chapterOptions.push({ token: ref.token, title: label });
    if (li.classList.contains('current')) currentToken = ref.token;
  }

  // Fallback: the chapter <select> dropdown on the reader page.
  if (chapterOptions.length === 0) {
    for (const option of root.querySelectorAll('select.chapter-selector option')) {
      const ref = readerRefFromUrl(option.getAttribute('value') ?? '');
      const label = textOf(option);
      if (!ref || !label) continue;
      chapterOptions.push({ token: ref.token, title: label });
      if (option.hasAttribute('selected')) currentToken = ref.token;
    }
  }

  if (imageUrls.length === 0 && !readerLabel && chapterOptions.length === 0 && !panelTitle) {
    // Nothing reader-like on the page at all → not a chapter page.
    throw new PageNotRecognizedError('Chapter page did not contain reader data.');
  }

  return {
    imageUrls,
    chapterOptions,
    currentToken,
    panelTitle,
    readerLabel,
    coverUrl,
    publishedAt: publishedTimeFromMeta(root),
  };
}
