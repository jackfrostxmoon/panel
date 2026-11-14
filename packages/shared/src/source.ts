/// <reference lib="dom" />
// Type-only DOM lib reference: `AbortSignal` below is used purely as an
// opaque cancellation token (it also exists in Bun/Node) — no DOM runtime
// usage lives in this package.
import type { Chapter, ChapterPages, Panel, PanelSummary } from './types.js';

/**
 * Panel source abstraction.
 *
 * The rest of the application only ever talks to this interface — it never
 * knows how a particular source works internally. To add a new source:
 * implement this interface and register it in the API's source registry.
 *
 * Id convention:
 *  - Methods RECEIVE native (unprefixed) source ids, e.g.
 *    `solo-leveling.21708` or `solo-leveling.21708~c200`.
 *  - Returned entities carry GLOBAL ids (prefix included, e.g.
 *    `mk:solo-leveling.21708`) so clients never have to assemble ids.
 */
/** The credit field of a panel used by `searchByCredit`. */
export type CreditKind = 'author' | 'artist';

/** Search modes exposed by `GET /api/panel/search?mode=`: titles (default) or credits. */
export type SearchMode = 'title' | CreditKind;

export interface PanelSource {
  /** Unique source name, also used as the global id prefix, e.g. "mk". */
  readonly name: string;
  /** Human-readable label, e.g. "MangaKatana". */
  readonly label: string;
  readonly baseUrl: string;
  readonly enabled: boolean;

  /** Search for panel by title. `page` is 1-based. */
  search(query: string, page?: number): Promise<SourceSearchResult>;

  /**
   * Optional: server-side credit (author/artist) search. Implement only
   * when the site can filter by that credit — the UI's author/artist mode
   * fans out to this; sources without it simply return nothing and the
   * service merges the local metadata cache instead. `kind` is the credit
   * to match ('author' | 'artist'), `page` is 1-based.
   */
  searchByCredit?(
    kind: CreditKind,
    query: string,
    page?: number,
  ): Promise<SourceSearchResult>;

  /** Fetch source latest updates. `page` is 1-based. */
  latest(page?: number): Promise<SourceSearchResult>;

  /** Fetch full metadata for one panel. Throws SourceError(PANEL_NOT_FOUND). */
  getPanel(nativePanelId: string): Promise<Panel>;

  /** List chapters, sorted ascending by chapter number where determinable. */
  getChapters(nativePanelId: string): Promise<Chapter[]>;

  /** Fetch the reader payload (pages + navigation) for one chapter. */
  getChapterPages(
    nativeChapterId: string,
    opts?: { serverPreference?: string; sourceUrl?: string },
  ): Promise<ChapterPages>;

  /**
   * Optional: proxy-fetch a raw image (cover / reader page) from this
   * source's CDN. Implement only when the CDN blocks direct browser access
   * (hotlink protection); adapters that do should also rewrite every image
   * URL they return to point at the API's /api/source-image endpoint.
   *
   * `opts.signal` aborts the upstream fetch — the image proxy passes the
   * client connection's signal through, so closing the reader (or hopping
   * to an already-cached chapter) stops the abandoned upstream fetch
   * instead of letting it hold a proxy slot.
   */
  fetchImage?(url: string, opts?: { signal?: AbortSignal }): Promise<SourceImage>;

  /**
   * Optional: streaming variant of `fetchImage` for the image proxy's cache
   * misses. Writes the upstream bytes straight to `destPath` (chunk by
   * chunk, enforcing the source's max-image cap) and resolves with the byte
   * count — the full image is never accumulated in heap. The image cache
   * prefers this when implemented and falls back to `fetchImage` otherwise.
   */
  fetchImageStream?(
    url: string,
    destPath: string,
    opts?: { signal?: AbortSignal },
  ): Promise<StreamedImage>;

  /**
   * Optional: runtime max-throughput profile for the performance-mode
   * toggle (longer attempt timeouts, snappier retries). The registry fans
   * it out to every adapter; adapters without it simply keep their
   * construction values. Must restore exact defaults when OFF.
   */
  setPerformanceMode?(on: boolean): void;

  /** Canonical source URL for a panel (the source owns its URL layout). */
  buildPanelUrl(nativePanelId: string): string;

  /** Canonical source URL for a chapter. */
  buildChapterUrl(nativeChapterId: string): string;

  /**
   * Optional: map a page url belonging to THIS source (e.g. pasted by the
   * user) to the native panel id it points at; null when it does not match
   * this source's url layout or host. Enables GET /api/panel/resolve.
   */
  nativePanelIdFromUrl?(url: string): string | null;

  /**
   * Optional: the source's full genre catalog for the filter dropdowns
   * (labels in site order). Implement only when the site publishes a genre
   * index (nav menu / genre page); sources without one omit it and the UI
   * falls back to the genres seen on the current result page.
   * Enables GET /api/panel/genres.
   */
  getGenreList?(): Promise<string[]>;

  /**
   * Optional: server-side genre-filtered listing for the Latest page.
   * `genres` / `excludedGenres` are DISPLAY LABELS as shown in the filter
   * dropdowns (null/empty = no constraint); the adapter maps them to its
   * own archive URLs and falls back to `latest(page)` when a label cannot
   * be resolved. Include semantics are OR (a title carrying ANY listed
   * genre matches); exclusion drops anything carrying ANY excluded label.
   * Adapters whose site only filters a single genre apply the first
   * include via their archive and union further includes across one fetch
   * per genre (approximate paging); adapters that cannot exclude
   * server-side ignore `excludedGenres` — the service always applies the
   * exclude filter centrally as well. `page` is 1-based.
   */
  latestByGenre?(
    genres: string[] | null,
    excludedGenres: string[] | null,
    page?: number,
  ): Promise<SourceSearchResult>;

  /**
   * Optional: server-side text search combined with genre filters (same
   * label semantics as `latestByGenre`). Implement only when the site's
   * search endpoint accepts genre constraints; otherwise the UI searches
   * unfiltered and narrows client-side. `page` is 1-based.
   */
  searchByGenre?(
    query: string,
    genres: string[] | null,
    excludedGenres: string[] | null,
    page?: number,
  ): Promise<SourceSearchResult>;
}

/**
 * Bulk genre lookup: global panel id → known genres from the API's panel
 * metadata cache. Wired into enriching adapters at construction; during
 * listing enrichment they fill hits from this first and only fetch detail
 * pages for the remainder. Absent ids (and lookup failures) mean "fetch".
 */
export type GenreLookup = (
  globalIds: readonly string[],
) => Promise<ReadonlyMap<string, readonly string[]>>;

export interface SourceSearchResult {
  results: PanelSummary[];
  /** 1-based page that was returned. */
  page: number;
  hasMore: boolean;
}

/** Raw image bytes fetched through the API (see PanelSource.fetchImage). */
export interface SourceImage {
  bytes: ArrayBuffer;
  contentType: string | null;
}

/**
 * Image streamed straight to disk (see PanelSource.fetchImageStream):
 * `bytes` is the count written, not a buffer.
 */
export interface StreamedImage {
  bytes: number;
  contentType: string | null;
}

/** Static, environment-driven configuration for a source. */
export interface SourceConfig {  readonly name: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly requestTimeoutMs: number;
  /**
   * Number of automatic retries on transient failures (timeout, network
   * error, 429, 5xx) before surfacing a SOURCE_TIMEOUT / SOURCE_UNAVAILABLE
   * to the client. Retries use exponential backoff with jitter.
   */
  readonly requestRetryCount: number;
  /**
   * Base delay (ms) for the first retry; subsequent attempts double it
   * (plus jitter). Defaults to SOURCE_REQUEST_RETRY_BASE_DELAY_MS.
   */
  readonly requestRetryBaseDelayMs: number;
  /**
   * Split response cap (bytes). Listings are KBs of HTML — a rogue multi-MB
   * page used to become a multi-MB JS string. Optional: the HTTP client
   * falls back to 3 MiB text / 8 MiB image when unset.
   */
  readonly maxTextBytes?: number;
  readonly maxImageBytes?: number;
  /**
   * Stream upstream image misses through an isolated child process instead
   * of in-process (see fetchImageChild.ts). Contains intermittent native
   * RSS grabs below app code: the child exits per fetch and the OS reclaims
   * all of its pages. Kill-switch: IMAGE_FETCH_ISOLATED=false.
   */
  readonly isolatedImageFetch: boolean;
}
