import {
  ErrorCodes,
  joinNativeChapterId,
  splitNativeChapterId,
  toGlobalId,
  type Chapter,
  type ChapterPages,
  type GenreLookup,
  type Panel,
  type PanelPage,
  type PanelSource,
  type PanelSummary,
  type SourceConfig,
  type SourceImage,
  type SourceSearchResult,
} from '@panel/shared';
import { SourceError } from '../../lib/errors.js';
import { SourceHttpClient } from '../../lib/httpClient.js';
import { logger } from '../../lib/logger.js';
import { isSameHost } from '../../lib/url.js';
import { eachWithConcurrency } from '../../lib/concurrency.js';
import { fillGenresFromCache } from '../../lib/cachedGenres.js';
import { unionSearchResults } from '../../lib/searchUnion.js';
import {
  chapterNumberFromToken,
  hasNextPage,
  panelNativeIdFromUrl,
  PageNotRecognizedError,
  parseApiResponse,
  parseChapterList,
  parseChapterReaderPage,
  parseGenreCatalog,
  parseGenreLinks,
  parseListPage,
  parsePanelApiResponse,
  parsePanelPage,
  parseSearchPage,
  parseSpaListResponse,
} from './parser.js';

/**
 * RawUwU source adapter (rawuwu.net).
 *
 * Same site engine as RawSakura. URL layout (verified 2026-09):
 *   search:   GET {base}/spa/search?query=<query>&page=<n>   (SPA JSON API)
 *   latest:   GET {base}/spa/latest-manga?page=<n>           (SPA JSON API)
 *   panel:    GET {base}/raw/<numericId>
 *             SPA detail: GET {base}/spa/manga/<numericId>
 *   chapter:  GET {base}/read/<numericId>/chapter-<num>
 *             SPA reader: GET {base}/spa/manga/<numericId>/<num>
 *
 * Native panel id: "<digits>" (e.g., "870369")
 * Native chapter id: "<digits>~chapter-<num>" (e.g., "870369~chapter-78")
 *
 * All HTML/JSON parsing lives in ./parser.ts — this class only deals with
 * URLs, ids, fetching and mapping raw data into the shared domain model.
 */
export class RawUwUSource implements PanelSource {
  readonly name: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly enabled: boolean;

  private readonly http: SourceHttpClient;

  /**
   * Bulk genre lookup (panel metadata cache), wired by the registry.
   * Lets enrichment skip detail fetches for previously-seen panels.
   * Absent in tests / standalone use — everything is fetched then.
   */
  private readonly findGenres?: GenreLookup;

  /**
   * Parallel detail fetches when enriching a listing page. The JSON api is
   * small but slow per request, and a failed item only loses its genres —
   * never the page — so this can be generous.
   */
  private readonly enrichConcurrency = 8;

  constructor(config: SourceConfig, http?: SourceHttpClient, findGenres?: GenreLookup) {
    this.name = config.name;
    this.label = config.label;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.enabled = config.enabled;
    this.findGenres = findGenres;
    this.http =
      http ??
      new SourceHttpClient(config.name, {
        allowedHosts: RawUwUSource.allowedHostsFor(config.baseUrl),
        // Chapter images live on s1.rawuwu.net (same registrable domain,
        // covered by the allowlist) and the b-cdn.net mirror.
        imageHosts: ['b-cdn.net'],
        timeoutMs: config.requestTimeoutMs,
        retryCount: config.requestRetryCount,
        retryBaseDelayMs: config.requestRetryBaseDelayMs,
        maxTextBytes: config.maxTextBytes,
        maxImageBytes: config.maxImageBytes,
      });
  }

  /** Allowlist = the source host itself (subdomains are allowed by the client). */
  static allowedHostsFor(baseUrl: string): string[] {
    try {
      return [new URL(baseUrl).hostname.toLowerCase()];
    } catch {
      return [];
    }
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new SourceError(
        this.name,
        ErrorCodes.SOURCE_DISABLED,
        'This panel source is disabled.',
      );
    }
  }

  /**
   * Covers are served directly from rawuwu.net's own CDN (no hotlink
   * protection), but routing them through the API's image proxy lets the
   * client-side cache warm + persist them in the on-disk image cache.
   */
  async fetchImage(url: string, opts?: { signal?: AbortSignal }): Promise<SourceImage> {
    this.assertEnabled();
    return this.http.fetchImage(url, undefined, opts?.signal);
  }

  buildPanelUrl(nativePanelId: string): string {
    return `${this.baseUrl}/raw/${encodeURIComponent(nativePanelId)}`;
  }

  buildChapterUrl(nativeChapterId: string): string {
    const parts = splitNativeChapterId(nativeChapterId);
    if (!parts) {
      throw new SourceError(this.name, ErrorCodes.VALIDATION_ERROR, 'Malformed chapter id.', {
        nativeChapterId,
      });
    }
    // e.g. .../read/870369/chapter-78
    return `${this.baseUrl}/read/${encodeURIComponent(parts.panelId)}/${encodeURIComponent(parts.chapterToken)}`;
  }

  /** "870369" from a rawuwu.net/raw/… url (own host only). */
  nativePanelIdFromUrl(url: string): string | null {
    if (!isSameHost(url, this.baseUrl)) return null;
    return panelNativeIdFromUrl(url);
  }

  async search(query: string, page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    const p = page >= 1 ? page : 1;
    // Primary: the SPA search API (the /search HTML route is not
    // server-rendered; queries live at /tag?query= via this same API).
    try {
      const params = new URLSearchParams({ query, page: String(p) });
      const { body } = await this.http.fetchJson(`${this.baseUrl}/spa/search?${params.toString()}`);
      const { items, hasMore } = parseSpaListResponse(body, this.baseUrl);
      await this.enrichListGenres(items);
      return {
        results: items.map((item) => this.toPanelSummary(item)),
        page: p,
        hasMore,
      };
    } catch (error) {
      logger.warn('SPA search API failed; falling back to HTML', {
        source: this.name,
        error: error instanceof Error ? error.message : String(error),
      });
      const params = new URLSearchParams({ query });
      if (p > 1) params.set('page', String(p));
      const { body } = await this.http.fetchText(`${this.baseUrl}/tag?${params.toString()}`);
      const items = parseSearchPage(body, this.baseUrl);
      await this.enrichListGenres(items);
      return {
        results: items.map((item) => this.toPanelSummary(item)),
        page: p,
        hasMore: hasNextPage(body, p),
      };
    }
  }

  async latest(page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    const p = page >= 1 ? page : 1;
    // Primary: the SPA latest API (same payload the /latest page hydrates from).
    try {
      const url = p > 1 ? `${this.baseUrl}/spa/latest-manga?page=${p}` : `${this.baseUrl}/spa/latest-manga`;
      const { body } = await this.http.fetchJson(url);
      const { items, hasMore } = parseSpaListResponse(body, this.baseUrl);
      await this.enrichListGenres(items);
      return {
        results: items.map((item) => this.toPanelSummary(item)),
        page: p,
        hasMore,
      };
    } catch (error) {
      logger.warn('SPA latest API failed; falling back to HTML', {
        source: this.name,
        error: error instanceof Error ? error.message : String(error),
      });
      const url = p > 1 ? `${this.baseUrl}/latest?page=${p}` : `${this.baseUrl}/latest`;
      const { body } = await this.http.fetchText(url);
      const items = parseListPage(body, this.baseUrl);
      await this.enrichListGenres(items);
      return {
        results: items.map((item) => this.toPanelSummary(item)),
        page: p,
        hasMore: hasNextPage(body, p),
      };
    }
  }

  /**
   * Genre enrichment for listing results. The search/latest cards carry no
   * genre markup, so each item's genres are filled from its detail payload
   * (`getPanel` prefers the lightweight SPA JSON api). Bounded concurrency
   * + per-item tolerance: one slow or broken detail never fails the listing.
   */
  private async enrichListGenres(items: Array<{ nativeId: string; genres: string[] }>): Promise<void> {
    // Previously-seen panels resolve from the metadata cache — only the
    // remainder pays for a detail fetch below.
    await fillGenresFromCache(this.name, items, this.findGenres);
    await eachWithConcurrency(
      items.filter((item) => item.genres.length === 0),
      async (item) => {
        try {
          const panel = await this.getPanel(item.nativeId);
          if (panel.genres.length > 0) item.genres = panel.genres;
        } catch (error) {
          logger.debug('Could not enrich RawUwU list-item genres', {
            source: this.name,
            nativeId: item.nativeId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      this.enrichConcurrency,
    );
  }

  /**
   * Full genre catalog from the nav `Genre` dropdown. Backs the filter
   * dropdowns so they offer every genre, not just the ones on the current
   * result page.
   */
  async getGenreList(): Promise<string[]> {
    this.assertEnabled();
    const { body } = await this.http.fetchText(`${this.baseUrl}/latest`);
    return parseGenreCatalog(body);
  }

  /**
   * Server-side genre filtering via the site's genre archives
   * (`/genre/<id>/<name>`). Include semantics are OR: several includes
   * fetch one archive each and union (approximate paging). The dropdown
   * label resolves to the exact archive URL through the nav genre index
   * (the numeric id is opaque, so URLs can't be guessed); an unresolvable
   * label falls back to the unfiltered listing (the UI still narrows
   * client-side). Exclusion is applied centrally by the service (cards
   * are enriched to full genres first).
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
    const { body: indexHtml } = await this.http.fetchText(`${this.baseUrl}/latest`);
    const links = parseGenreLinks(indexHtml, this.baseUrl);
    const hrefs: string[] = [];
    for (const label of includes) {
      const href = links.find(
        (entry) => entry.label.toLowerCase() === label.toLowerCase(),
      )?.href;
      if (!href) return this.latest(p);
      hrefs.push(href);
    }
    const fetchArchive = async (href: string): Promise<SourceSearchResult> => {
      const archiveUrl = p <= 1 ? href : `${href}?page=${p}`;
      const { body } = await this.http.fetchText(archiveUrl);
      const items = parseListPage(body, this.baseUrl);
      await this.enrichListGenres(items);
      return {
        results: items.map((item) => this.toPanelSummary(item)),
        page: p,
        hasMore: hasNextPage(body, p),
      };
    };
    if (hrefs.length === 1) return fetchArchive(hrefs[0] as string);
    const settled = await Promise.allSettled(hrefs.map((href) => fetchArchive(href)));
    return unionSearchResults(settled, p);
  }

  async getPanel(nativePanelId: string): Promise<Panel> {
    this.assertEnabled();
    const sourceUrl = this.buildPanelUrl(nativePanelId);

    // Try the SPA API for richer/more accurate panel details.
    try {
      const apiUrl = `${this.baseUrl}/spa/manga/${encodeURIComponent(nativePanelId)}`;
      const { body: apiBody } = await this.http.fetchJson(apiUrl);
      const { details: raw } = parsePanelApiResponse(apiBody, this.baseUrl, sourceUrl);
      return {
        ...this.toPanelSummary({
          nativeId: raw.nativeId,
          title: raw.title,
          coverUrl: raw.coverUrl,
          sourceUrl: raw.sourceUrl,
          status: raw.status,
          genres: raw.genres,
          summary: raw.description,
          latestChapterLabel: raw.latestChapterLabel,
          updatedAt: null,
        }),
        altTitles: raw.altTitles,
        authors: raw.authors,
        artists: raw.artists,
        description: raw.description,
      };
    } catch (error) {
      logger.warn('SPA API for panel details failed; falling back to HTML', {
        source: this.name,
        nativePanelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const { body } = await this.http.fetchText(sourceUrl);
    try {
      const raw = parsePanelPage(body, sourceUrl, this.baseUrl);
      return {
        ...this.toPanelSummary({
          nativeId: raw.nativeId,
          title: raw.title,
          coverUrl: raw.coverUrl,
          sourceUrl: raw.sourceUrl,
          status: raw.status,
          genres: raw.genres,
          summary: null,
          latestChapterLabel: raw.latestChapterLabel,
          updatedAt: null,
        }),
        altTitles: raw.altTitles,
        authors: raw.authors,
        artists: raw.artists,
        description: raw.description,
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

  async getChapters(nativePanelId: string): Promise<Chapter[]> {
    this.assertEnabled();
    const sourceUrl = this.buildPanelUrl(nativePanelId);

    // Try to get the full chapter list from the SPA API endpoint.
    // The API at /spa/manga/{manga_id} returns the complete chapter list.
    try {
      const apiUrl = `${this.baseUrl}/spa/manga/${encodeURIComponent(nativePanelId)}`;
      const { body: apiBody } = await this.http.fetchJson(apiUrl);
      const { chapters: apiChapters } = parsePanelApiResponse(apiBody, this.baseUrl, sourceUrl);
      if (apiChapters.length > 0) {
        return this.mapToGlobalChapters(apiChapters);
      }
    } catch (error) {
      logger.warn('SPA API did not provide a chapter list; using embedded list', {
        source: this.name,
        nativePanelId,
        error,
      });
    }

    const { body } = await this.http.fetchText(sourceUrl);

    // The panel detail page renders the full chapter list server-side.
    const rawChapters = parseChapterList(body, this.baseUrl, sourceUrl);

    if (rawChapters.length === 0) {
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
      logger.warn('Panel page contained no chapters', {
        source: this.name,
        nativePanelId,
      });
    }

    // Fall back to fetching the latest chapter's reader page for the chapter list.
    // The panel page initially renders ~10 chapters behind a "+ Show All
    // Chapters" expander, so a present expander means the embedded list is
    // truncated even when it is non-empty.
    const latest = rawChapters.length > 0 ? rawChapters[0]! : null;
    const truncated = body.includes('show-all-chapters');
    if (latest && (rawChapters.length <= 2 || truncated)) {
      try {
        const readerBody = (await this.http.fetchText(latest.sourceUrl)).body;
        const reader = parseChapterReaderPage(readerBody, this.baseUrl);
        if (reader.chapterOptions.length > 0) {
          const fullChapters = reader.chapterOptions.map((option): typeof rawChapters[0] => ({
            nativeId: `${nativePanelId}~${option.token}`,
            panelNativeId: nativePanelId,
            chapterToken: option.token,
            title: option.title,
            chapterNumber: chapterNumberFromToken(option.token),
            sourceUrl: this.buildChapterUrl(`${nativePanelId}~${option.token}`),
            publishedAt: null,
          }));
          if (fullChapters.length > rawChapters.length) {
            return this.mapToGlobalChapters(fullChapters);
          }
        }
      } catch (error) {
        logger.warn('Reader page did not provide a chapter list; using embedded list', {
          source: this.name,
          nativePanelId,
          error,
        });
      }
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

    // The initial HTML page does not contain image URLs — they are loaded
    // dynamically via an AJAX call to /spa/manga/{manga_id}/{chapter_number}.
    // Try the SPA API first for actual image URLs.
    const chapterNumber = chapterNumberFromToken(parts.chapterToken);
    let raw: Awaited<ReturnType<typeof parseChapterReaderPage>>;

    try {
      if (!chapterNumber) {
        throw new Error('Missing chapter number');
      }
      const apiUrl = `${this.baseUrl}/spa/manga/${encodeURIComponent(parts.panelId)}/${chapterNumber}`;
      const { body: apiBody } = await this.http.fetchJson(apiUrl);
      raw = parseApiResponse(apiBody, this.baseUrl);
    } catch (apiError) {
      // Fall back to HTML parsing (images will be empty but chapter options still work)
      logger.warn('SPA API fetch failed; falling back to HTML parsing', {
        source: this.name,
        nativeChapterId,
        error: apiError instanceof Error ? apiError.message : String(apiError),
      });
      try {
        const htmlBody = (await this.http.fetchText(this.buildChapterUrl(nativeChapterId))).body;
        raw = parseChapterReaderPage(htmlBody, this.baseUrl);
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
    }

    const pages: PanelPage[] = raw.imageUrls.map((url, index) => ({
      index,
      url,
      source: this.name,
      width: null,
      height: null,
    }));

    // Prev/next navigation from chapter options
    // Chapter options are ordered newest-first (index 0 = latest)
    // Previous (older) = index + 1, Next (newer) = index - 1
    const currentToken = raw.currentToken ?? parts.chapterToken;
    const currentIdx = raw.chapterOptions.findIndex((o) => o.token === currentToken);
    const optionToId = (offset: number): string | null => {
      const option = raw.chapterOptions[currentIdx + offset];
      return option
        ? toGlobalId(this.name, joinNativeChapterId(parts.panelId, option.token))
        : null;
    };
    let prevChapterId = currentIdx >= 0 ? optionToId(1) : null; // Previous = older
    let nextChapterId = currentIdx >= 0 ? optionToId(-1) : null;   // Next = newer

    // Fall back to prevRef/nextRef from HTML/API if chapter options don't cover it
    if (!prevChapterId && raw.prevRef) {
      prevChapterId = toGlobalId(this.name, joinNativeChapterId(raw.prevRef.panelId, raw.prevRef.token));
    }
    if (!nextChapterId && raw.nextRef) {
      nextChapterId = toGlobalId(this.name, joinNativeChapterId(raw.nextRef.panelId, raw.nextRef.token));
    }

    return {
      chapterId: toGlobalId(this.name, nativeChapterId),
      panelId: toGlobalId(this.name, parts.panelId),
      panelTitle: raw.panelTitle,
      chapterTitle: raw.chapterOptions[currentIdx]?.title ?? raw.readerLabel,
      coverUrl: raw.coverUrl,
      pages,
      prevChapterId,
      nextChapterId,
    };
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

    // Source lists newest-first; return ascending by chapter number.
    chapters.sort((a, b) => (a.chapterNumber ?? Infinity) - (b.chapterNumber ?? Infinity));
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
}
