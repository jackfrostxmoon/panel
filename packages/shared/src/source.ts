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
export interface PanelSource {
  /** Unique source name, also used as the global id prefix, e.g. "mk". */
  readonly name: string;
  /** Human-readable label, e.g. "MangaKatana". */
  readonly label: string;
  readonly baseUrl: string;
  readonly enabled: boolean;

  /** Search for panel by title. `page` is 1-based. */
  search(query: string, page?: number): Promise<SourceSearchResult>;

  /** Fetch source latest updates. `page` is 1-based. */
  latest(page?: number): Promise<SourceSearchResult>;

  /** Fetch full metadata for one panel. Throws SourceError(PANEL_NOT_FOUND). */
  getPanel(nativePanelId: string): Promise<Panel>;

  /** List chapters, sorted ascending by chapter number where determinable. */
  getChapters(nativePanelId: string): Promise<Chapter[]>;

  /** Fetch the reader payload (pages + navigation) for one chapter. */
  getChapterPages(nativeChapterId: string): Promise<ChapterPages>;

  /**
   * Optional: proxy-fetch a raw image (cover / reader page) from this
   * source's CDN. Implement only when the CDN blocks direct browser access
   * (hotlink protection); adapters that do should also rewrite every image
   * URL they return to point at the API's /api/source-image endpoint.
   */
  fetchImage?(url: string): Promise<SourceImage>;

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
}
