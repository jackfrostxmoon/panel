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
  type StreamedImage,
  type SourceSearchResult,
} from '@panel/shared';
import { SourceError } from '../../lib/errors.js';
import { SourceHttpClient } from '../../lib/httpClient.js';
import { logger } from '../../lib/logger.js';
import { isSameHost } from '../../lib/url.js';
import { fillGenresFromCache } from '../../lib/cachedGenres.js';
import { unionSearchResults } from '../../lib/searchUnion.js';
import {
  chapterNumberFromToken,
  extractNumericPanelId,
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
} from './parser.js';

/**
 * RawSakura source adapter (rawsakura.org).
 *
 * Custom-built panel site. URL layout (verified 2026-08):
 *   search:   GET {base}/search?q=<query>
 *   latest:   GET {base}/latest
 *   panel:    GET {base}/title/sa<id>
 *   chapter:  GET {base}/reader/sa<id>/chapter-<num>
 *
 * Native panel id: "sa<digits>" (e.g., "sa857458")
 * Native chapter id: "sa<digits>~chapter-<num>" (e.g., "sa857458~chapter-1190")
 *
 * All HTML parsing lives in ./parser.ts — this class only deals with URLs,
 * ids, fetching and mapping raw data into the shared domain model.
 */
export class RawSakuraSource implements PanelSource {
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

  constructor(config: SourceConfig, http?: SourceHttpClient, findGenres?: GenreLookup) {
    this.name = config.name;
    this.label = config.label;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.enabled = config.enabled;
    this.findGenres = findGenres;
    this.http =
      http ??
      new SourceHttpClient(config.name, {
        allowedHosts: RawSakuraSource.allowedHostsFor(config.baseUrl),
        // Chapter images live on the rawuwu.net CDN, not rawsakura.org.
        imageHosts: ['rawuwu.net'],
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
   * Covers are served directly from rawsakura.org's own CDN (no hotlink
   * protection), but routing them through the API's image proxy lets the
    * client-side cache warm + persist them in the on-disk image cache.
   */
  async fetchImage(url: string, opts?: { signal?: AbortSignal }): Promise<SourceImage> {
    this.assertEnabled();
    return this.http.fetchImage(url, undefined, opts?.signal);
  }

  /**
   * Streaming variant of `fetchImage` for the image cache: bytes go
   * straight to `destPath`, never accumulating in heap.
   */
  async fetchImageStream(url: string, destPath: string, opts?: { signal?: AbortSignal }): Promise<StreamedImage> {
    this.assertEnabled();
    return this.http.fetchImageToFile(url, destPath, undefined, opts?.signal);
  }

  buildPanelUrl(nativePanelId: string): string {
    return `${this.baseUrl}/title/${encodeURIComponent(nativePanelId)}`;
  }

  buildChapterUrl(nativeChapterId: string): string {
    const parts = splitNativeChapterId(nativeChapterId);
    if (!parts) {
      throw new SourceError(this.name, ErrorCodes.VALIDATION_ERROR, 'Malformed chapter id.', {
        nativeChapterId,
      });
    }
    // e.g. .../reader/sa857458/chapter-1190
    return `${this.baseUrl}/reader/${encodeURIComponent(parts.panelId)}/${encodeURIComponent(parts.chapterToken)}`;
  }

  /** "sa857458" from a rawsakura.org/title/… url (own host only). */
  nativePanelIdFromUrl(url: string): string | null {
    if (!isSameHost(url, this.baseUrl)) return null;
    return panelNativeIdFromUrl(url);
  }

  async search(query: string, page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    // The site uses GET /search?q=... with no pagination in the initial implementation
    // but we'll support page parameter for consistency
    const params = new URLSearchParams({ query });
    if (page > 1) params.set('page', String(page));
    const url = `${this.baseUrl}/search?${params.toString()}`;
    const { body } = await this.http.fetchText(url);

    const items = parseSearchPage(body, this.baseUrl);
    await this.enrichListGenres(items);
    return {
      results: items.map((item) => this.toPanelSummary(item)),
      page,
      hasMore: hasNextPage(body, page),
    };
  }

  async latest(page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    const url = page > 1 ? `${this.baseUrl}/latest?page=${page}` : `${this.baseUrl}/latest`;
    const { body } = await this.http.fetchText(url);

    const items = parseListPage(body, this.baseUrl);
    await this.enrichListGenres(items);
    return {
      results: items.map((item) => this.toPanelSummary(item)),
      page,
      hasMore: hasNextPage(body, page),
    };
  }

  /**
   * Genre enrichment for listing results. The search/latest cards carry no
   * genre markup, so genres are filled from the panel metadata cache only
   * (panels the user has opened before).
   *
   * Deliberately cache-only: a live per-item detail fetch here costs two
   * fetches per card (HTML page + SPA JSON api) plus a full DOM parse, at
   * concurrency 8 — the cold-start memory/CPU spike. Genre-less items are
   * kept as-is — the service's exclude filter is fail-open and the UI still
   * narrows client-side, so nothing is over-dropped.
   */
  private async enrichListGenres(items: Array<{ nativeId: string; genres: string[] }>): Promise<void> {
    await fillGenresFromCache(this.name, items, this.findGenres);
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
    const { body } = await this.http.fetchText(sourceUrl);

    // Try the SPA API for richer/more accurate panel details.
    const numericPanelId = extractNumericPanelId(nativePanelId);
    if (numericPanelId) {
      try {
        const apiUrl = `${this.baseUrl}/spa/manga/${numericPanelId}`;
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
    }

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
    const { body } = await this.http.fetchText(sourceUrl);

    // The panel detail page only has first/latest chapter links.
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

    // Try to get full chapter list from the SPA API endpoint.
    // The API at /spa/manga/{manga_id} returns the complete chapter list.
    const numericPanelId = extractNumericPanelId(nativePanelId);
    if (numericPanelId) {
      try {
        const apiUrl = `${this.baseUrl}/spa/manga/${numericPanelId}`;
        const { body: apiBody } = await this.http.fetchJson(apiUrl);
        const { chapters: apiChapters } = parsePanelApiResponse(apiBody, this.baseUrl, sourceUrl);
        if (apiChapters.length > rawChapters.length) {
          return this.mapToGlobalChapters(apiChapters);
        }
      } catch (error) {
        logger.warn('SPA API did not provide a chapter list; using embedded list', {
          source: this.name,
          nativePanelId,
          error,
        });
      }
    }

    // Fall back to fetching the latest chapter's reader page for the chapter list.
    const latest = rawChapters[0];
    if (latest) {
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

    const htmlBody = (await this.http.fetchText(this.buildChapterUrl(nativeChapterId))).body;

    // The initial HTML page does not contain image URLs — they are loaded
    // dynamically via an AJAX call to /spa/manga/{manga_id}/{chapter_number}.
    // Try the SPA API first for actual image URLs.
    const numericPanelId = extractNumericPanelId(parts.panelId);
    const chapterNumber = chapterNumberFromToken(parts.chapterToken);
    let raw: Awaited<ReturnType<typeof parseChapterReaderPage>>;

    try {
      if (numericPanelId && chapterNumber) {
        const apiUrl = `${this.baseUrl}/spa/manga/${numericPanelId}/${chapterNumber}`;
        const { body: apiBody } = await this.http.fetchJson(apiUrl);
        raw = parseApiResponse(apiBody, this.baseUrl);
      } else {
        throw new Error('Missing numeric panel ID or chapter number');
      }
    } catch (apiError) {
      // Fall back to HTML parsing (images will be empty but chapter options still work)
      logger.warn('SPA API fetch failed; falling back to HTML parsing', {
        source: this.name,
        nativeChapterId,
        error: apiError instanceof Error ? apiError.message : String(apiError),
      });
      try {
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