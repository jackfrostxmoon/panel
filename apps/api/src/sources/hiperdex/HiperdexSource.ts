import {
  ErrorCodes,
  joinNativeChapterId,
  splitNativeChapterId,
  toGlobalId,
  type Chapter,
  type ChapterPages,
  type Panel,
  type PanelPage,
  type PanelSource,
  type PanelSummary,
  type SourceConfig,
  type SourceImage,
  type StreamedImage,
  type SourceSearchResult,
} from '@panel/shared';
import { TtlCache } from '../../lib/cache.js';
import { SourceError } from '../../lib/errors.js';
import { SourceHttpClient } from '../../lib/httpClient.js';
import { logger } from '../../lib/logger.js';
import { isSameHost } from '../../lib/url.js';
import {
  PageNotRecognizedError,
  buildChapterPagesApiUrl,
  buildGenreListApiUrl,
  buildSearchQueryApiUrl,
  buildSeriesChaptersApiUrl,
  buildSeriesIdApiUrl,
  chapterNumberFromToken,
  SEARCH_PAGE_SIZE,
  HIPERDEX_API_HEADER,
  HIPERDEX_API_KEY,
  HIPERDEX_SESSION_COOKIE,
  panelNativeIdFromUrl,
  parseChapterPagesApi,
  parseChapterReaderPage,
  parseChapterSitemaps,
  parseGenreListApi,
  parseSearchQueryApi,
  parsePanelPage,
  parseRecentUpdatesFromSitemaps,
  parseSeriesChaptersApi,
  parseSeriesDetailsApi,
  parseSeriesIdApi,
  parseSeriesSitemap,
  parseSitemapIndex,
  pickNewestChapterSitemaps,
  sessionCookieFromSetCookies,
  type RawApiPage,
  type RawChapterItem,
  type RawListItem,
  type RecentUpdateEntry,
} from './parser.js';

/** How long the SPA api's __st session cookie is reused before re-bootstrap. */
const SESSION_TTL_MS = 30 * 60_000;

/** How long per-series title/cover metadata scraped for latest() stays fresh. */
const SERIES_META_TTL_MS = 10 * 60_000;
/** Rate-limit failures (429) are transient — re-check soon, don't stick for the full TTL. */
const SERIES_META_NEGATIVE_TTL_MS = 60_000;
/** Sitemaps are large and change slowly — reuse them across calls (the site
 *  answers with 429 quickly when hammered). */
const SITEMAP_TTL_MS = 5 * 60_000;
/**
 * Sitemap XMLs are catalog-scale files (the series sitemap lists the whole
 * catalog) — far above the default 3MB text cap, which guards HTML pages.
 * Sitemaps still fail fast, just at 10MB.
 */
const SITEMAP_MAX_BYTES = 10 * 1024 * 1024;
/** Parallel detail-page fetches when enriching one latest() page. The site
 *  rate-limits (429) aggressively, so keep this low and pace the requests. */
const ENRICH_CONCURRENCY = 2;
/** Delay between detail-page fetches per worker (rate-limit headroom). */
const ENRICH_DELAY_MS = 400;
/** Extra passes over items whose first fetch was rate-limited (429). */
const ENRICH_429_RETRIES = 2;
const ENRICH_429_RETRY_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/** How many of the newest chapter sitemaps to scan for latest-chapter info.
 *  New uploads always land in the newest files, so 3 (~2.4k chapters) covers
 *  the recent-updates window at a fraction of fetching all ~260 sitemaps. */
const RECENT_CHAPTER_SITEMAPS = 3;

/**
 * Hiperdex source adapter (hiperdex.com).
 *
 * React SPA with Cloudflare protection. Key pages have SSR metadata:
 *   panel:    GET {base}/manga/<slug>/ — OG tags + JSON-LD Book schema
 *   chapter:  GET {base}/manga/<slug>/<chapter_num>/ — JSON-LD Article with ALL images
 *   latest:   sitemap-series.xml (sorted by lastmod) + detail pages for covers/titles
 *   chapters: sitemap-chapters-*.xml (filter by panel slug)
 *   search:   search.query tRPC (text + genre filters, paginated)
 *
 * Native panel id: slug (e.g., "lost-seven")
 * Native chapter id: "<slug>~<chapter_num>" (e.g., "lost-seven~1", "lost-seven~2.5")
 *
 * Image CDNs (cloud-7/i1/*.r2d2storage.com) enforce hotlink protection —
 * they only serve images with a hiperdex.com Referer, which browsers cannot
 * send for cross-origin <img> tags. All image URLs returned by this adapter
 * are therefore rewritten to the API's /api/source-image proxy, which adds
 * the required Referer server-side (see fetchImage).
 *
 * Search: search.query tRPC (text + genre filters, paginated).
 */
export class HiperdexSource implements PanelSource {
  readonly name: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly enabled: boolean;

  private readonly http: SourceHttpClient;
  private sitemapChapterUrls: string[] | null = null;
  /** nativeId → { title, coverUrl, genres, status } for latest(); null = negative cache. */
  private readonly seriesMeta = new TtlCache<{
    title: string;
    coverUrl: string | null;
    genres: string[];
    status: Panel['status'];
  } | null>(500);
  /**
   * sitemap url → xml body. The site publishes ~260 chapter sitemaps
   * (~100KB each); holding all of them lets any panel's chapter list be
   * served without re-downloading the whole set (the site answers 429
   * quickly when hammered). Expired entries free the memory again.
   */
  private readonly sitemapCache = new TtlCache<string>(300);
  /** Parsed chapter lists per panel (fast tRPC path); short TTL. */
  private readonly chaptersCache = new TtlCache<RawChapterItem[]>(300);
  /** __st cookie value for the SPA's reader api; null = bootstrap failed. */
  private sessionCookie: { value: string; fetchedAt: number } | null = null;
  /** Parsed recent-updates feed (from the newest chapter sitemaps). */
  private recentFeed: { entries: RecentUpdateEntry[]; fetchedAt: number } | null = null;

  constructor(config: SourceConfig, http?: SourceHttpClient) {
    this.name = config.name;
    this.label = config.label;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.enabled = config.enabled;
    this.http =
      http ??
      new SourceHttpClient(config.name, {
        allowedHosts: HiperdexSource.allowedHostsFor(config.baseUrl),
        // Chapter images live on the r2d2storage.com CDN, not hiperdex.com.
        imageHosts: ['r2d2storage.com'],
        timeoutMs: config.requestTimeoutMs,
        retryCount: config.requestRetryCount,
        retryBaseDelayMs: config.requestRetryBaseDelayMs,
        maxTextBytes: config.maxTextBytes,
        maxImageBytes: config.maxImageBytes,
        isolatedImageFetch: config.isolatedImageFetch,
      });
  }

  private async fetchSitemap(url: string): Promise<string> {
    const cached = this.sitemapCache.get(url);
    if (cached !== undefined) return cached;
    const { body } = await this.http.fetchText(url, SITEMAP_MAX_BYTES);
    this.sitemapCache.set(url, body, SITEMAP_TTL_MS);
    return body;
  }

  /** Allowlist = source host + image CDN (subdomains allowed by client). */
  static allowedHostsFor(baseUrl: string): string[] {
    try {
      const hostname = new URL(baseUrl).hostname.toLowerCase();
      return [hostname, 'cloud-7.r2d2storage.com', 'i1.r2d2storage.com', 'r2d2storage.com'];
    } catch {
      return [];
    }
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new SourceError(this.name, ErrorCodes.SOURCE_DISABLED, 'This panel source is disabled.');
    }
  }

  buildPanelUrl(nativePanelId: string): string {
    return `${this.baseUrl}/manga/${encodeURIComponent(nativePanelId)}/`;
  }

  buildChapterUrl(nativeChapterId: string): string {
    const parts = splitNativeChapterId(nativeChapterId);
    if (!parts) {
      throw new SourceError(this.name, ErrorCodes.VALIDATION_ERROR, 'Malformed chapter id.', {
        nativeChapterId,
      });
    }
    // e.g. .../manga/lost-seven/1/
    return `${this.baseUrl}/manga/${encodeURIComponent(parts.panelId)}/${encodeURIComponent(
      parts.chapterToken,
    )}/`;
  }

  /** "lost-seven" from a hiperdex.com/manga/… url (own host only). */
  nativePanelIdFromUrl(url: string): string | null {
    if (!isSameHost(url, this.baseUrl)) return null;
    return panelNativeIdFromUrl(url);
  }

  async search(query: string, page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    return this.searchViaApi(query, [], page);
  }

  /**
   * Text search through the SPA's own `search.query` (relevance order).
   * Shared by `search` and `searchByGenre` — the only difference is the
   * genre include list (multi-include is OR, verified live).
   */
  private async searchViaApi(
    query: string,
    genres: readonly string[],
    page: number,
  ): Promise<SourceSearchResult> {
    const p = page >= 1 ? page : 1;
    const cookie = await this.ensureSessionCookie();
    const headers: Record<string, string> = {
      [HIPERDEX_API_HEADER]: HIPERDEX_API_KEY,
      ...(cookie ? { Cookie: cookie } : {}),
    };
    const { body } = await this.http.fetchJson(
      buildSearchQueryApiUrl(this.baseUrl, {
        q: query,
        sort: 'relevance',
        genres: [...genres],
        limit: SEARCH_PAGE_SIZE,
        offset: (p - 1) * SEARCH_PAGE_SIZE,
      }),
      headers,
    );
    const parsed = parseSearchQueryApi(body, this.baseUrl);
    if (!parsed) {
      throw new SourceError(
        this.name,
        ErrorCodes.SOURCE_PARSE_ERROR,
        'The source returned an unrecognized search payload.',
      );
    }
    return {
      results: parsed.items.map((item) => this.toPanelSummary(item)),
      page: p,
      hasMore: (p - 1) * SEARCH_PAGE_SIZE + parsed.items.length < parsed.totalHits,
    };
  }

  /**
   * Server-side text search combined with genre include filters (same
   * `search.query` call with `filters.genres`; multi-include is OR).
   * Exclusion is applied centrally by the service (hits carry full
   * genres inline).
   */
  async searchByGenre(
    query: string,
    genres: string[] | null,
    _excludedGenres: string[] | null,
    page = 1,
  ): Promise<SourceSearchResult> {
    this.assertEnabled();
    const includes = genres ?? [];
    if (includes.length === 0) return this.search(query, page);
    return this.searchViaApi(query, includes, page);
  }

  async latest(page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    const perPage = 20;

    // Primary: the site's real update feed, derived from the newest chapter
    // sitemaps (same data the SPA's "Recent Updates" grid renders).
    const feed = await this.recentUpdatesFeed();

    // Fallback: series sitemap ordered by lastmod (no chapter info).
    if (feed.length === 0) return this.latestFromSeriesSitemap(page, perPage);

    const start = (page - 1) * perPage;
    const pageEntries = feed.slice(start, start + perPage);
    if (pageEntries.length === 0) {
      return { results: [], page, hasMore: false };
    }

    const items: RawListItem[] = pageEntries.map((entry) => ({
      nativeId: entry.nativeId,
      title: entry.nativeId, // placeholder until detail-page enrichment
      coverUrl: null,
      sourceUrl: this.buildPanelUrl(entry.nativeId),
      status: 'unknown',
      genres: [],
      summary: null,
      // Site encodes decimal chapters with dashes in urls ("5-1" = 5.1).
      latestChapterLabel: `Chapter ${entry.token.replace(/-/g, '.')}`,
      updatedAt: entry.publishedAt,
    }));

    // Real titles + covers + status from the detail pages (TTL-cached).
    await this.enrichListItems(items);

    return {
      results: items.map((item) => this.toPanelSummary(item)),
      page,
      hasMore: start + perPage < feed.length,
    };
  }

  /**
   * Ordered newest-first list of recently updated panel, derived from the
   * newest RECENT_CHAPTER_SITEMAPS chapter sitemaps. Cached briefly — the
   * underlying bodies are already TTL-cached, this just avoids re-parsing.
   */
  private async recentUpdatesFeed(): Promise<RecentUpdateEntry[]> {
    const cached = this.recentFeed;
    if (cached && Date.now() - cached.fetchedAt < SITEMAP_TTL_MS) {
      return cached.entries;
    }
    try {
      if (!this.sitemapChapterUrls) {
        const indexBody = await this.fetchSitemap(`${this.baseUrl}/sitemap_index.xml`);
        this.sitemapChapterUrls = parseSitemapIndex(indexBody).filter((url) =>
          url.includes('sitemap-chapters-'),
        );
      }
      const recent = pickNewestChapterSitemaps(this.sitemapChapterUrls!, RECENT_CHAPTER_SITEMAPS);
      if (recent.length === 0) return [];

      // Oldest-first so the seq ordering inside the parser ends newest-first.
      const oldestFirst = [...recent].reverse();
      const xmls = await Promise.all(oldestFirst.map((url) => this.fetchSitemap(url)));
      const entries = parseRecentUpdatesFromSitemaps(xmls);
      this.recentFeed = { entries, fetchedAt: Date.now() };
      return entries;
    } catch (error) {
      logger.warn('Could not build Hiperdex recent-updates feed from chapter sitemaps', {
        source: this.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** Legacy fallback when the chapter-sitemap feed is unavailable. */
  private async latestFromSeriesSitemap(page: number, perPage: number): Promise<SourceSearchResult> {
    const body = await this.fetchSitemap(`${this.baseUrl}/sitemap-series.xml`);
    const items = parseSeriesSitemap(body, this.baseUrl);

    const start = (page - 1) * perPage;
    const pageItems = items.slice(start, start + perPage);
    await this.enrichListItems(pageItems);

    return {
      results: pageItems.map((item) => this.toPanelSummary(item)),
      page,
      hasMore: start + perPage < items.length,
    };
  }

  /** Fill in real titles/covers/genres for sitemap-derived list items. */
  private async enrichListItems(items: RawListItem[]): Promise<void> {
    let cursor = 0;
    const rateLimited: RawListItem[] = [];
    const workers = Array.from({ length: Math.min(ENRICH_CONCURRENCY, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor];
        cursor += 1;
        if (!item) continue;
        const limited = await this.enrichListItem(item);
        if (limited) rateLimited.push(item);
        await sleep(ENRICH_DELAY_MS);
      }
    });
    await Promise.all(workers);

    // Second chance for items the site rate-limited (429) on the first pass —
    // a slower, spaced-out retry usually gets through and avoids cards with
    // missing covers on the latest page.
    for (let attempt = 1; attempt <= ENRICH_429_RETRIES && rateLimited.length > 0; attempt++) {
      await sleep(ENRICH_429_RETRY_DELAY_MS * attempt);
      for (const item of rateLimited.splice(0)) {
        this.seriesMeta.delete(item.nativeId); // drop the short negative entry
        const stillLimited = await this.enrichListItem(item);
        if (stillLimited) rateLimited.push(item);
        await sleep(ENRICH_DELAY_MS);
      }
    }
  }

  /** Returns true when the fetch was rate-limited (429) — caller may retry. */
  private async enrichListItem(item: RawListItem): Promise<boolean> {
    const cached = this.seriesMeta.get(item.nativeId);
    if (cached !== undefined) {
      if (cached) {
        item.title = cached.title || item.title;
        item.coverUrl = cached.coverUrl;
        if (cached.genres.length > 0) item.genres = cached.genres;
        if (cached.status !== 'unknown') item.status = cached.status;
      }
      return false;
    }
    // Fast path first: the series API answers title/cover/status/genres in
    // ~2KB, versus ~370KB of SSR HTML per item on the old path.
    const enriched = await this.fetchSeriesDetails(item.nativeId);
    if (enriched && enriched.genres.length > 0) {
      item.title = enriched.title || item.title;
      item.coverUrl = enriched.coverUrl ?? item.coverUrl;
      if (enriched.status !== 'unknown') item.status = enriched.status;
      item.genres = enriched.genres;
      this.seriesMeta.set(
        item.nativeId,
        { title: item.title, coverUrl: item.coverUrl, genres: item.genres, status: item.status },
        SERIES_META_TTL_MS,
      );
      return false;
    }
    // Fallback: the SSR page (also covers API outages — a null/empty API
    // payload degrades to the previous behavior instead of losing the item).
    try {
      const { body } = await this.http.fetchText(this.buildPanelUrl(item.nativeId));
      const detail = parsePanelPage(body, item.sourceUrl, this.baseUrl);
      item.title = detail.title || item.title;
      item.coverUrl = detail.coverUrl;
      item.status = detail.status;
      // The SSR page carries no genres — the SPA's series api does.
      const retryEnriched = await this.fetchSeriesDetails(item.nativeId);
      const genres =
        retryEnriched && retryEnriched.genres.length > 0 ? retryEnriched.genres : detail.genres;
      if (genres.length > 0) item.genres = genres;
      this.seriesMeta.set(
        item.nativeId,
        { title: item.title, coverUrl: item.coverUrl, genres: item.genres, status: item.status },
        SERIES_META_TTL_MS,
      );
      return false;
    } catch (error) {
      // A 429 exhausts the client's internal retries and surfaces as a public
      // SourceError carrying details.upstreamStatus — detect it there.
      const status =
        error instanceof SourceError
          ? (error.details as { upstreamStatus?: number } | undefined)?.upstreamStatus
          : undefined;
      const isRateLimited = status === 429;
      if (!isRateLimited) {
        logger.debug('Could not enrich Hiperdex series metadata', {
          source: this.name,
          nativeId: item.nativeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // Negative cache so one broken entry doesn't re-fetch on every call.
      // 429s expire quickly so a later visit re-tries instead of sticking null.
      this.seriesMeta.set(item.nativeId, null, isRateLimited ? SERIES_META_NEGATIVE_TTL_MS : SERIES_META_TTL_MS);
      return isRateLimited;
    }
  }

  async getPanel(nativePanelId: string): Promise<Panel> {
    this.assertEnabled();
    const sourceUrl = this.buildPanelUrl(nativePanelId);
    const { body } = await this.http.fetchText(sourceUrl);

    try {
      const raw = parsePanelPage(body, sourceUrl, this.baseUrl);
      // The SSR page carries only title/cover/synopsis — the SPA's own
      // by-slug api holds status/genres/authors/artists/alt-titles and the
      // full (untruncated) synopsis. Best-effort enrichment; SSR wins on
      // failure so a tRPC hiccup never breaks panel details.
      const enriched = await this.fetchSeriesDetails(nativePanelId);
      const description = enriched?.synopsis ?? raw.description;
      const status = enriched && enriched.status !== 'unknown' ? enriched.status : raw.status;
      return {
        ...this.toPanelSummary({
          nativeId: raw.nativeId,
          title: enriched?.title ?? raw.title,
          coverUrl: enriched?.coverUrl ?? raw.coverUrl,
          sourceUrl: raw.sourceUrl,
          status,
          genres: enriched && enriched.genres.length > 0 ? enriched.genres : raw.genres,
          summary: description,
          latestChapterLabel: raw.latestChapterLabel,
          updatedAt: null,
        }),
        altTitles: enriched && enriched.altTitles.length > 0 ? enriched.altTitles : raw.altTitles,
        authors: enriched && enriched.authors.length > 0 ? enriched.authors : raw.authors,
        artists: enriched && enriched.artists.length > 0 ? enriched.artists : raw.artists,
        description,
      };
    } catch (error) {
      if (error instanceof PageNotRecognizedError) {
        logger.info('Panel page not recognized', { source: this.name, nativePanelId });
        throw new SourceError(
          this.name,
          ErrorCodes.PANEL_NOT_FOUND,
          'The requested panel could not be found.',
          { nativePanelId },
        );
      }
      throw error;
    }
  }

  /** Rich panel metadata via `series.bySlugWithGenres`; null → keep SSR data. */
  private async fetchSeriesDetails(nativePanelId: string) {    try {
      const cookie = await this.ensureSessionCookie();
      const headers: Record<string, string> = {
        [HIPERDEX_API_HEADER]: HIPERDEX_API_KEY,
        ...(cookie ? { Cookie: cookie } : {}),
      };
      const { body } = await this.http.fetchJson(
        buildSeriesIdApiUrl(this.baseUrl, nativePanelId),
        headers,
      );
      return parseSeriesDetailsApi(body);
    } catch (error) {
      logger.debug('Hiperdex series details unavailable — using SSR metadata', {
        source: this.name,
        nativePanelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Server-side genre filtering through the SPA's own `search.query`
   * (newest-first, paginated, genres included in every hit — no enrichment
   * pass needed). Multi-include is OR (verified live). An unparseable
   * payload falls back to the unfiltered feed (the UI still narrows
   * client-side). Exclusion is applied centrally by the service.
   */
  async latestByGenre(
    genres: string[] | null,
    _excludedGenres: string[] | null,
    page = 1,
  ): Promise<SourceSearchResult> {
    this.assertEnabled();
    const p = page >= 1 ? page : 1;
    const includes = genres ?? [];
    if (includes.length === 0) return this.latest(p);
    const cookie = await this.ensureSessionCookie();
    const headers: Record<string, string> = {
      [HIPERDEX_API_HEADER]: HIPERDEX_API_KEY,
      ...(cookie ? { Cookie: cookie } : {}),
    };
    const { body } = await this.http.fetchJson(
      buildSearchQueryApiUrl(this.baseUrl, {
        q: '',
        sort: 'recent',
        genres: [...includes],
        limit: SEARCH_PAGE_SIZE,
        offset: (p - 1) * SEARCH_PAGE_SIZE,
      }),
      headers,
    );
    const parsed = parseSearchQueryApi(body, this.baseUrl);
    if (!parsed) return this.latest(p);
    return {
      results: parsed.items.map((item) => this.toPanelSummary(item)),
      page: p,
      hasMore: (p - 1) * SEARCH_PAGE_SIZE + parsed.items.length < parsed.totalHits,
    };
  }

  /**
   * Full genre catalog via `search.genres` (feeds the SPA's own genre
   * picker). Backs the filter dropdowns so they offer every genre, not
   * just the ones on the current result page.
   */
  async getGenreList(): Promise<string[]> {
    this.assertEnabled();
    const cookie = await this.ensureSessionCookie();
    const headers: Record<string, string> = {
      [HIPERDEX_API_HEADER]: HIPERDEX_API_KEY,
      ...(cookie ? { Cookie: cookie } : {}),
    };
    const { body } = await this.http.fetchJson(buildGenreListApiUrl(this.baseUrl), headers);
    return parseGenreListApi(body);
  }

  async getChapters(nativePanelId: string): Promise<Chapter[]> {
    this.assertEnabled();

    // Fast path: the SPA's private tRPC api answers in one small request.
    const cached = this.chaptersCache.get(nativePanelId);
    if (cached !== undefined) return this.mapToGlobalChapters(cached);

    const viaApi = await this.getChaptersViaApi(nativePanelId);
    if (viaApi) {
      this.chaptersCache.set(nativePanelId, viaApi, SITEMAP_TTL_MS);
      return this.mapToGlobalChapters(viaApi);
    }

    return this.getChaptersViaSitemaps(nativePanelId);
  }

  /**
   * Full chapter list via two tiny tRPC queries (~KBs, ~1s). Returns null on
   * any failure so the caller falls back to the sitemap scan — which also
   * preserves PANEL_NOT_FOUND semantics for unknown slugs.
   */
  private async getChaptersViaApi(nativePanelId: string): Promise<RawChapterItem[] | null> {
    try {
      const cookie = await this.ensureSessionCookie();
      let headers: Record<string, string> = {
        [HIPERDEX_API_HEADER]: HIPERDEX_API_KEY,
        ...(cookie ? { Cookie: cookie } : {}),
      };

      const idResponse = await this.http.fetchJson(
        buildSeriesIdApiUrl(this.baseUrl, nativePanelId),
        headers,
      );
      const seriesId = parseSeriesIdApi(idResponse.body);
      if (seriesId === null) return null;

      let listBody: string;
      try {
        listBody = (
          await this.http.fetchJson(buildSeriesChaptersApiUrl(this.baseUrl, seriesId), headers)
        ).body;
      } catch {
        // The __st cookie may have expired server-side — bootstrap once more.
        this.sessionCookie = null;
        const freshCookie = await this.ensureSessionCookie();
        if (!freshCookie || freshCookie === cookie) throw new Error('series.chapters failed');
        headers = { [HIPERDEX_API_HEADER]: HIPERDEX_API_KEY, Cookie: freshCookie };
        listBody = (
          await this.http.fetchJson(buildSeriesChaptersApiUrl(this.baseUrl, seriesId), headers)
        ).body;
      }

      const chapters = parseSeriesChaptersApi(listBody, nativePanelId, this.baseUrl);
      if (chapters) {
        logger.debug('Hiperdex chapter list via tRPC api', {
          source: this.name,
          nativePanelId,
          count: chapters.length,
        });
      }
      return chapters;
    } catch (error) {
      logger.debug('Hiperdex chapters api unavailable — falling back to sitemaps', {
        source: this.name,
        nativePanelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Legacy path: scan every chapter sitemap (~260 files, ~26MB) for the slug. */
  private async getChaptersViaSitemaps(nativePanelId: string): Promise<Chapter[]> {
    const sourceUrl = this.buildPanelUrl(nativePanelId);
    const { body } = await this.http.fetchText(sourceUrl);

    // Verify panel exists
    try {
      parsePanelPage(body, sourceUrl, this.baseUrl);
    } catch (error) {
      if (error instanceof PageNotRecognizedError) {
        throw new SourceError(
          this.name,
          ErrorCodes.PANEL_NOT_FOUND,
          'The requested panel could not be found.',
          { nativePanelId },
        );
      }
      throw error;
    }

    // Fetch sitemap index to discover chapter sitemap URLs
    if (!this.sitemapChapterUrls) {
      const indexBody = await this.fetchSitemap(`${this.baseUrl}/sitemap_index.xml`);
      const allSitemaps = parseSitemapIndex(indexBody);
      this.sitemapChapterUrls = allSitemaps.filter((url) => url.includes('sitemap-chapters-'));
      logger.debug('Discovered chapter sitemaps', { count: this.sitemapChapterUrls.length });
    }

    // Fetch all chapter sitemaps with bounded concurrency — 264 parallel
    // requests trip the site's 429 rate limit and turn a working panel
    // into a "No chapters found" page. Bodies are TTL-cached, so later
    // panels reuse them without refetching. Parsed per batch so the ~26MB
    // of bodies never sits in heap at once (the parser handles each XML
    // independently — concatenating per-batch results is identical).
    const urls = this.sitemapChapterUrls!;
    const rawChapters: RawChapterItem[] = [];
    const CONCURRENCY = 8;
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const batch = urls.slice(i, i + CONCURRENCY);
      const bodies = await Promise.all(batch.map((url) => this.fetchSitemap(url)));
      rawChapters.push(...parseChapterSitemaps(bodies, this.baseUrl, nativePanelId));
    }

    if (rawChapters.length === 0) {
      logger.warn('No chapters found in sitemaps for panel', { source: this.name, nativePanelId });
    }

    return this.mapToGlobalChapters(rawChapters);
  }

  async getChapterPages(nativeChapterId: string): Promise<ChapterPages> {
    this.assertEnabled();
    const parts = splitNativeChapterId(nativeChapterId);
    if (!parts) {
      throw new SourceError(this.name, ErrorCodes.VALIDATION_ERROR, 'Malformed chapter id.', {
        nativeChapterId,
      });
    }

    const { body } = await this.http.fetchText(this.buildChapterUrl(nativeChapterId));

    let raw;
    try {
      raw = parseChapterReaderPage(body, this.baseUrl);
    } catch (error) {
      if (error instanceof PageNotRecognizedError) {
        throw new SourceError(
          this.name,
          ErrorCodes.CHAPTER_NOT_FOUND,
          'The requested chapter could not be found.',
          { nativeChapterId },
        );
      }
      throw error;
    }

    // The SSR JSON-LD often embeds only the first three pages — or nothing at
    // all (e.g. decimal chapters like "35-2"). Ask the site's own reader api
    // for the COMPLETE list; JSON-LD remains a fallback.
    let apiPages: RawApiPage[] | null = null;
    const chapterNumber = chapterNumberFromToken(parts.chapterToken);
    if (chapterNumber !== null) {
      apiPages = await this.fetchApiPages(parts.panelId, chapterNumber, nativeChapterId);
    }

    const jsonLdCount = raw.imageUrls.length;
    const canUseJsonLd = jsonLdCount > 0;
    const canUseApi = apiPages !== null && apiPages.length > 0;

    if (!canUseJsonLd && !canUseApi) {
      logger.error('Chapter had no extractable images from JSON-LD or the reader api', {
        source: this.name,
        nativeChapterId,
      });
      throw SourceError.parse(this.name, 'chapter image list');
    }

    const useApi = canUseApi && (!canUseJsonLd || apiPages!.length > jsonLdCount);

    const pages: PanelPage[] = useApi
      ? apiPages!.map((page, index) => ({
          index,
          url: this.proxiedImageUrl(page.url) ?? page.url,
          width: page.width,
          height: page.height,
        }))
      : raw.imageUrls.map((url, index) => ({
          index,
          url: this.proxiedImageUrl(url) ?? url,
          width: null,
          height: null,
        }));

    if (!useApi && canUseJsonLd) {
      logger.warn('Hiperdex reader api unavailable — using truncated JSON-LD page list', {
        source: this.name,
        nativeChapterId,
        jsonLdPages: jsonLdCount,
      });
    }

  const prevRef = raw.prevRef && raw.prevRef.panelId === parts.panelId ? raw.prevRef : null;
  const nextRef = raw.nextRef && raw.nextRef.panelId === parts.panelId ? raw.nextRef : null;

  let prevChapterId = prevRef
    ? toGlobalId(this.name, joinNativeChapterId(prevRef.panelId, prevRef.token))
    : null;
  let nextChapterId = nextRef
    ? toGlobalId(this.name, joinNativeChapterId(nextRef.panelId, nextRef.token))
    : null;

  // SSR JSON-LD rarely carries both refs (prev is never present, next is
  // missing on decimal chapters) — infer them from the ordered chapter list.
  if (!prevChapterId || !nextChapterId) {
    const siblings = await this.getOrderedChapters(parts.panelId);
    const idx = siblings.findIndex((c) => c.nativeId === nativeChapterId);
    if (idx !== -1) {
      const prevSibling = idx > 0 ? siblings[idx - 1] : undefined;
      const nextSibling = idx < siblings.length - 1 ? siblings[idx + 1] : undefined;
      if (!prevChapterId && prevSibling) {
        prevChapterId = toGlobalId(this.name, prevSibling.nativeId);
      }
      if (!nextChapterId && nextSibling) {
        nextChapterId = toGlobalId(this.name, nextSibling.nativeId);
      }
    }
  }

  return {
    chapterId: toGlobalId(this.name, nativeChapterId),
    panelId: toGlobalId(this.name, parts.panelId),
    panelTitle: raw.panelTitle,
    chapterTitle: raw.readerLabel,
    // Absolute upstream URL (not the pre-proxied path): the client proxies
    // at render time via getProxiedImageUrl, and the progress endpoint only
    // accepts absolute cover URLs — a relative one here silently broke
    // reading-progress tracking for this source (every save 400d).
    coverUrl: raw.coverUrl,
    pages,
    prevChapterId,
    nextChapterId,
  };
}

/**
 * Ascending RawChapterItem[] for one panel — serves prev/next inference.
 * Reuses the chapters cache / fast tRPC path; empty on failure (best-effort).
 */
private async getOrderedChapters(nativePanelId: string): Promise<RawChapterItem[]> {
  const cached = this.chaptersCache.get(nativePanelId);
  if (cached !== undefined) return cached;

  const viaApi = await this.getChaptersViaApi(nativePanelId);
  if (viaApi) {
    this.chaptersCache.set(nativePanelId, viaApi, SITEMAP_TTL_MS);
    return viaApi;
  }
  return [];
}

  private mapToGlobalChapters(rawChapters: Array<{
    nativeId: string;
    panelNativeId: string;
    chapterToken: string;
    title: string;
    chapterNumber: number | null;
    sourceUrl: string;
    publishedAt: string | null;
  }>): Chapter[] {
    const globalPanelId = toGlobalId(this.name, rawChapters[0]?.panelNativeId ?? '');
    const chapters = rawChapters.map((raw): Chapter => ({
      id: toGlobalId(this.name, raw.nativeId),
      panelId: globalPanelId,
      source: this.name,
      title: raw.title,
      chapterNumber: raw.chapterNumber,
      sourceUrl: raw.sourceUrl,
      publishedAt: raw.publishedAt,
    }));

    // Already sorted ascending by chapter number in parser
    return chapters;
  }

  private toPanelSummary(raw: {
    nativeId: string;
    title: string;
    coverUrl: string | null;
    sourceUrl: string;
    status: PanelSummary['status'];
    genres: string[];
    summary: string | null;
    latestChapterLabel: string | null;
    updatedAt: string | null;
  }): PanelSummary {
    return {
      id: toGlobalId(this.name, raw.nativeId),
      source: this.name,
      title: raw.title,
      coverUrl: raw.coverUrl,
      sourceUrl: raw.sourceUrl,
      status: raw.status,
      genres: raw.genres,
      summary: raw.summary,
      latestChapter: raw.latestChapterLabel,
      updatedAt: raw.updatedAt,
    };
  }

  /**
   * The r2d2storage CDNs only serve images carrying a hiperdex.com Referer
   * (hotlink protection) — browsers cannot send that cross-origin. Point
   * clients at the API's image proxy instead, which adds it server-side.
   * The kind path selects the proxy cache bucket (cover vs chapter).
   */
  private proxiedImageUrl(
    url: string | null,
    kind: 'cover' | 'chapter' = 'chapter',
  ): string | null {
    if (!url) return null;
    const params = new URLSearchParams({ source: this.name, u: url });
    return `/api/source-image/${kind}?${params.toString()}`;
  }

  /**
   * Serve one CDN image with the Referer the source requires.
   */
  async fetchImage(url: string, opts?: { signal?: AbortSignal }): Promise<SourceImage> {
    this.assertEnabled();
    const { bytes, contentType } = await this.http.fetchImage(url, {
      Referer: `${this.baseUrl}/`,
    }, opts?.signal);
    return { bytes, contentType };
  }

  /**
   * Streaming variant of `fetchImage` for the image cache: bytes go
   * straight to `destPath`, never accumulating in heap.
   */
  async fetchImageStream(url: string, destPath: string, opts?: { signal?: AbortSignal }): Promise<StreamedImage> {
    this.assertEnabled();
    return this.http.fetchImageToFile(url, destPath, {
      Referer: `${this.baseUrl}/`,
    }, opts?.signal);
  }

  /** Complete page list via the SPA's reader api; null → caller falls back. */
  private async fetchApiPages(
    seriesSlug: string,
    chapterNumber: number,
    nativeChapterId: string,
  ): Promise<RawApiPage[] | null> {
    try {
      const body = await this.callReaderApi(seriesSlug, chapterNumber);
      return parseChapterPagesApi(body);
    } catch (error) {
      logger.debug('Hiperdex reader api call failed', {
        source: this.name,
        nativeChapterId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async callReaderApi(seriesSlug: string, chapterNumber: number): Promise<string> {
    const cookie = await this.ensureSessionCookie();
    const headers: Record<string, string> = {
      [HIPERDEX_API_HEADER]: HIPERDEX_API_KEY,
      ...(cookie ? { Cookie: cookie } : {}),
    };
    const url = buildChapterPagesApiUrl(this.baseUrl, seriesSlug, chapterNumber);
    try {
      return (await this.http.fetchJson(url, headers)).body;
    } catch (error) {
      // The __st cookie may have expired server-side — bootstrap once more.
      this.sessionCookie = null;
      const freshCookie = await this.ensureSessionCookie();
      if (!freshCookie || freshCookie === cookie) throw error;
      return (
        await this.http.fetchJson(url, {
          [HIPERDEX_API_HEADER]: HIPERDEX_API_KEY,
          Cookie: freshCookie,
        })
      ).body;
    }
  }

  private async ensureSessionCookie(): Promise<string | null> {
    const cached = this.sessionCookie;
    if (cached && Date.now() - cached.fetchedAt < SESSION_TTL_MS) {
      return `${HIPERDEX_SESSION_COOKIE}=${cached.value}`;
    }
    try {
      // Any HTML page sets the __st session cookie.
      const home = await this.http.fetchText(`${this.baseUrl}/`);
      const value = sessionCookieFromSetCookies(home.setCookie);
      if (value) {
        this.sessionCookie = { value, fetchedAt: Date.now() };
        return `${HIPERDEX_SESSION_COOKIE}=${value}`;
      }
    } catch (error) {
      logger.debug('Could not bootstrap Hiperdex session cookie', {
        source: this.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}