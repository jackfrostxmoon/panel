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
  type SourceSearchResult,
} from '@panel/shared';
import { SourceError } from '../../lib/errors.js';
import { SourceHttpClient } from '../../lib/httpClient.js';
import { logger } from '../../lib/logger.js';
import { isSameHost } from '../../lib/url.js';
import {
  PageNotRecognizedError,
  chapterNumberFromToken,
  chapterRefFromUrl,
  panelNativeIdFromUrl,
  parseChapterBatch,
  parseChapterReaderPage,
  parseGenreCatalog,
  parseGenreLinks,
  parseLatestPage,
  parsePanelChapters,
  parsePanelPage,
  parseSearchPage,
} from './parser.js';

/** Reader language segment (`/read/<slug>/en/chapter-12`). */
const READER_LANG = 'en';

/** Defensive cap on lazy-loaded chapter batches per getChapters call. */
const MAX_CHAPTER_BATCHES = 60;

export class RoliaScanSource implements PanelSource {
  readonly name: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly enabled: boolean;

  private readonly http: SourceHttpClient;

  constructor(config: SourceConfig, http?: SourceHttpClient) {
    this.name = config.name;
    this.label = config.label;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.enabled = config.enabled;
    this.http =
      http ??
      new SourceHttpClient(config.name, {
        allowedHosts: RoliaScanSource.allowedHostsFor(config.baseUrl),
        // Covers and reader images both live on the site's media CDN.
        imageHosts: ['azabria.tovahala.lol'],
        timeoutMs: config.requestTimeoutMs,
        retryCount: config.requestRetryCount,
        retryBaseDelayMs: config.requestRetryBaseDelayMs,
        maxTextBytes: config.maxTextBytes,
        maxImageBytes: config.maxImageBytes,
      });
  }

  static allowedHostsFor(baseUrl: string): string[] {
    try {
      return [new URL(baseUrl).hostname.toLowerCase()];
    } catch {
      return ['roliascan.xyz'];
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
   * Covers are served from the site's own media CDN (no hotlink
   * protection), but routing them through the API's image proxy lets the
   * client-side cache warm + persist them in the on-disk image cache.
   */
  async fetchImage(url: string, opts?: { signal?: AbortSignal }): Promise<SourceImage> {
    this.assertEnabled();
    return this.http.fetchImage(url, undefined, opts?.signal);
  }

  buildPanelUrl(nativePanelId: string): string {
    return `${this.baseUrl}/manga/${encodeURIComponent(nativePanelId)}`;
  }

  buildChapterUrl(nativeChapterId: string): string {
    const parts = splitNativeChapterId(nativeChapterId);
    if (!parts) {
      throw new SourceError(this.name, ErrorCodes.VALIDATION_ERROR, 'Malformed chapter id.', {
        nativeChapterId,
      });
    }
    return `${this.baseUrl}/read/${encodeURIComponent(parts.panelId)}/${READER_LANG}/${encodeURIComponent(parts.chapterToken)}`;
  }

  nativePanelIdFromUrl(url: string): string | null {
    if (!isSameHost(url, this.baseUrl)) return null;
    return chapterRefFromUrl(url)?.panelId ?? panelNativeIdFromUrl(url);
  }

  async search(query: string, page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    const params = new URLSearchParams({ q: query });
    if (page > 1) params.set('page', String(page));
    const url = `${this.baseUrl}/search?${params.toString()}`;
    const { body } = await this.http.fetchText(url);
    const parsed = parseSearchPage(body, this.baseUrl);
    return {
      results: parsed.items.map((item) => this.toPanelSummary(item)),
      page,
      hasMore: parsed.hasMore,
    };
  }

  async latest(page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    // "Latest updates" lives at /updated, paginated as ?page=N.
    const url = page <= 1 ? `${this.baseUrl}/updated` : `${this.baseUrl}/updated?page=${encodeURIComponent(String(page))}`;
    const { body } = await this.http.fetchText(url);
    const parsed = parseLatestPage(body, this.baseUrl);
    return {
      results: parsed.items.map((item) => this.toPanelSummary(item)),
      page,
      hasMore: parsed.hasMore,
    };
  }

  /**
   * Full genre catalog from the nav menu. Backs the filter dropdowns so
   * they offer every genre, not just the ones on the current result page.
   */
  async getGenreList(): Promise<string[]> {
    this.assertEnabled();
    const { body } = await this.http.fetchText(`${this.baseUrl}/updated`);
    return parseGenreCatalog(body);
  }

  /**
   * Server-side genre filtering through the `/genre/<slug>` archives
   * (single include only — the site has no multi-include or exclusion
   * endpoint; further constraints narrow client-side, and the service
   * always applies exclusions centrally as well).
   */
  async latestByGenre(
    genres: string[] | null,
    excludedGenres: string[] | null,
    page = 1,
  ): Promise<SourceSearchResult> {
    this.assertEnabled();
    void excludedGenres;
    const p = page >= 1 ? page : 1;
    const includes = genres ?? [];
    if (includes.length === 0) return this.latest(p);
    const { body: indexHtml } = await this.http.fetchText(`${this.baseUrl}/updated`);
    const href = parseGenreLinks(indexHtml, this.baseUrl).find(
      (entry) => entry.label.toLowerCase() === (includes[0] ?? '').toLowerCase(),
    )?.href;
    if (!href) return this.latest(p);
    const url = p <= 1 ? href : `${href}?page=${encodeURIComponent(String(p))}`;
    const { body } = await this.http.fetchText(url);
    const parsed = parseLatestPage(body, this.baseUrl);
    return {
      results: parsed.items.map((item) => this.toPanelSummary(item)),
      page: p,
      hasMore: parsed.hasMore,
    };
  }

  /**
   * The `/search` filter params are unverified, so genre-scoped search
   * falls back to the plain search — the UI still narrows client-side.
   */
  async searchByGenre(
    query: string,
    genres: string[] | null,
    excludedGenres: string[] | null,
    page = 1,
  ): Promise<SourceSearchResult> {
    this.assertEnabled();
    void genres;
    void excludedGenres;
    return this.search(query, page);
  }

  async getPanel(nativePanelId: string): Promise<Panel> {
    this.assertEnabled();
    const sourceUrl = this.buildPanelUrl(nativePanelId);
    const { body, finalUrl } = await this.http.fetchText(sourceUrl);

    try {
      const raw = parsePanelPage(body, finalUrl, this.baseUrl);
      return {
        ...this.toPanelSummary({
          nativeId: nativePanelId,
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
    const { body } = await this.http.fetchText(this.buildPanelUrl(nativePanelId));

    let parsed: ReturnType<typeof parsePanelChapters>;
    try {
      parsed = parsePanelChapters(body, this.baseUrl);
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

    // Long series lazy-load follow-up batches from
    // <chapters-url>?offset=N (200 per batch, newest-first).
    const allItems = [...parsed.items];
    let hasMore = parsed.hasMore;
    let offset = parsed.nextOffset;
    let batches = 0;
    while (hasMore && parsed.chaptersUrl && offset !== null && batches < MAX_CHAPTER_BATCHES) {
      batches += 1;
      const { body: batchHtml } = await this.http.fetchText(
        `${parsed.chaptersUrl}?offset=${encodeURIComponent(String(offset))}`,
      );
      const batch = parseChapterBatch(batchHtml, this.baseUrl);
      allItems.push(...batch.items);
      hasMore = batch.hasMore;
      offset = batch.nextOffset;
    }
    if (batches >= MAX_CHAPTER_BATCHES) {
      logger.warn('Chapter batch cap reached, list may be truncated', {
        source: this.name,
        nativePanelId,
      });
    }

    const globalPanelId = toGlobalId(this.name, nativePanelId);
    const chapters = allItems.map((raw): Chapter => ({
      id: toGlobalId(this.name, raw.nativeId),
      panelId: globalPanelId,
      source: this.name,
      title: raw.title,
      chapterNumber: raw.chapterNumber,
      sourceUrl: raw.sourceUrl,
      publishedAt: raw.publishedAt,
    }));

    chapters.sort((a, b) => (a.chapterNumber ?? Infinity) - (b.chapterNumber ?? Infinity));
    return chapters;
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

    let parsed: ReturnType<typeof parseChapterReaderPage>;
    try {
      parsed = parseChapterReaderPage(body, this.baseUrl);
    } catch (error) {
      if (error instanceof PageNotRecognizedError) {
        logger.error('Chapter page had no extractable images', {
          source: this.name,
          nativeChapterId,
        });
        throw SourceError.parse(this.name, 'chapter image list');
      }
      throw error;
    }

    if (parsed.imageUrls.length === 0) {
      logger.error('Chapter page had no extractable images', {
        source: this.name,
        nativeChapterId,
      });
      throw SourceError.parse(this.name, 'chapter image list');
    }

    const pages: PanelPage[] = parsed.imageUrls.map((url, index) => ({
      index,
      url,
      source: this.name,
      width: null,
      height: null,
    }));

    // Prev/next come straight from the page's chapter nav (no chapter-list
    // round-trip: long series would need dozens of batch fetches).
    const token = parsed.currentToken ?? parts.chapterToken;
    const chapterNumber = chapterNumberFromToken(token);
    const toId = (offsetToken: string | null): string | null =>
      offsetToken ? toGlobalId(this.name, joinNativeChapterId(parts.panelId, offsetToken)) : null;

    return {
      chapterId: toGlobalId(this.name, nativeChapterId),
      panelId: toGlobalId(this.name, parts.panelId),
      panelTitle: parsed.readerLabel ? parsed.readerLabel.split(' Chapter')[0] || null : null,
      chapterTitle: chapterNumber !== null ? `Chapter ${chapterNumber}` : token,
      coverUrl: parsed.coverUrl,
      pages,
      prevChapterId: toId(parsed.prevToken),
      nextChapterId: toId(parsed.nextToken),
    };
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
