/**
 * Core domain models shared between the API and the web client.
 *
 * All `id` fields exposed through the API are *global* source-prefixed ids
 * (see `id.ts`), e.g. `mk:solo-leveling.21708` or
 * `mk:solo-leveling.21708~c200`. The prefix lets the backend route a request
 * to the correct source without a database lookup.
 */

export type PanelStatus = 'ongoing' | 'completed' | 'hiatus' | 'cancelled' | 'unknown';

/** Compact representation used in search results and lists. */
export interface PanelSummary {
  /** Global id, e.g. "mk:solo-leveling.21708". */
  id: string;
  /** Source identifier, e.g. "mangakatana". */
  source: string;
  title: string;
  coverUrl: string | null;
  /** Canonical URL of the panel on the source website. */
  sourceUrl: string;
  status: PanelStatus;
  genres: string[];
  /** Short synopsis when the source provides one inline (search results). */
  summary: string | null;
  /** e.g. "Chapter 200" — latest chapter label when known. */
  latestChapter: string | null;
  /** ISO date string of the last source update, when known. */
  updatedAt: string | null;
}

/** Full panel metadata for the details screen. */
export interface Panel extends PanelSummary {
  altTitles: string[];
  authors: string[];
  artists: string[];
  description: string | null;
}

export interface Chapter {
  /** Global id, e.g. "mk:solo-leveling.21708~c200". */
  id: string;
  /** Global panel id this chapter belongs to. */
  panelId: string;
  source: string;
  /** Full chapter label, e.g. "Chapter 200: Side Story 21 [END]". */
  title: string;
  /** Numeric chapter number when it can be parsed (200, 12.5, ...). */
  chapterNumber: number | null;
  sourceUrl: string;
  /** ISO date string when the source publishes one. */
  publishedAt: string | null;
}

/** A single reader page (one image). */
export interface PanelPage {
  /** 0-based page index within the chapter. */
  index: number;
  url: string;
  /**
   * Source prefix of this image (e.g. "mk"), so the client can point the
   * reader at the API's image proxy without re-resolving the global id.
   * Optional — set by adapters that know their own prefix.
   */
  source?: string;
  /** Intrinsic dimensions when the source exposes them (used to reserve
   *  layout space and avoid content jumping while images load). */
  width: number | null;
  height: number | null;
}

/** Payload for the reader: pages plus chapter-navigation context. */
export interface ChapterPages {
  chapterId: string;
  panelId: string;
  panelTitle: string | null;
  chapterTitle: string | null;
  /** Cover image (from the chapter page's og:image) — lets the client store
   *  progress with display metadata without an extra source request. */
  coverUrl: string | null;
  pages: PanelPage[];
  /** Global ids of adjacent chapters for prev/next navigation. */
  prevChapterId: string | null;
  nextChapterId: string | null;
}

export interface Bookmark {
  /** Database id (uuid). */
  id: string;
  /** Global panel id. */
  panelId: string;
  title: string;
  coverUrl: string | null;
  source: string;
  sourceUrl: string;
  createdAt: string;
  updatedAt: string;
  /** Cached metadata (from the panel cache) so bookmark cards can render like source cards. */
  status?: PanelStatus;
  genres?: string[];
  summary?: string | null;
  latestChapter?: string | null;
  /**
   * ISO timestamp of when the latest chapter was cached server-side.
   * Drives the bookmarks-page sort so a freshly-released chapter bubbles a
   * panel to the top even when the bookmark row itself hasn't changed.
   * `null` when no chapters have been cached yet.
   */
  latestChapterCachedAt?: string | null;
  /**
   * Folder ids this bookmark belongs to. Always includes the default
   * "Reading list" folder id when set. The frontend uses this to render
   * folder badges and to check/uncheck the right folder in the picker
   * without an extra round-trip.
   */
  folderIds?: string[];
  /** Joined reading progress for "continue reading", when present. */
  progress?: {
    chapterId: string;
    chapterTitle: string | null;
    page: number;
    updatedAt: string;
  } | null;
}

export interface ReadingProgress {
  panelId: string;
  chapterId: string;
  /** 0-based page index. */
  page: number;
  /**
   * Overall chapter scroll fraction (0–1) in vertical mode:
   * `scrollTop / (scrollHeight - clientHeight)`. Null when the position is
   * page-granular (paged/gallery modes or legacy rows). A fraction stays
   * valid across image loads and screen widths where absolute page offsets
   * shift, so continue-reading restores the same relative content.
   */
  scrollFraction: number | null;
  /**
   * Horizontal pan (scroller `scrollLeft` in CSS px) in vertical mode —
   * the precision complement to the fraction: image widths never grow on
   * load, so X is layout-stable where Y needs the fraction. Nonzero while
   * pinch-zoomed and panned; null when page-granular. Browsers clamp out
   * of range values on restore (including RTL negative origins).
   */
  scrollX: number | null;
  /**
   * Intra-page anchor ratio (0–1) in vertical mode: how far the viewport
   * center has progressed through the saved `page`. Unlike the overall
   * chapter fraction, this survives non-uniform image growth (long-strip
   * chapters whose boxes grow 10x on load while lazy siblings stay small)
   * because it is relative to one page's own box, not the chapter total.
   * Null when page-granular or saved by an older client.
   */
  anchorRatio: number | null;
  updatedAt: string;
}

/** Reading-list status (T1-5): a user-chosen shelf for a panel. */
export type ReadingListStatus = 'want_to_read' | 'reading' | 'completed';

/** One entry on the reading list, joined with panel metadata for display. */
export interface ReadingListEntry {
  id: string;
  panelId: string;
  status: ReadingListStatus;
  createdAt: string;
  updatedAt: string;
  title: string;
  coverUrl: string | null;
  source: string;
  sourceUrl: string;
  /** Joined reading progress, when present. */
  progress?: ReadingProgress | null;
}

/** Reading progress enriched with display metadata (home screen). */
export interface ReadingProgressEntry extends ReadingProgress {
  panelTitle: string | null;
  coverUrl: string | null;
  chapterTitle: string | null;
  sourceUrl: string;
}
