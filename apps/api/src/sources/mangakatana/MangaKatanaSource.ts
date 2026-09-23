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
import { unionSearchResults } from '../../lib/searchUnion.js';
import { isSameHost } from '../../lib/url.js';
import {
  PageNotRecognizedError,
  panelNativeIdFromUrl,
  parseChapterList,
  parseChapterReaderPage,
  parseGenreCatalog,
  parseGenreLinks,
  parsePanelPage,
  parseSearchPage,
} from './parser.js';

/**
 * MangaKatana source adapter.
 *
 * URL layout (verified 2026-08):
 *   search:   GET {base}/?search=<q>&search_by=book_name
 *   panel:    GET {base}/manga/<slug>.<id>          (slug is cosmetic)
 *   chapter:  GET {base}/manga/<slug>.<id>/c<num>
 *
 * All HTML parsing lives in ./parser.ts — this class only deals with URLs,
 * ids, fetching and mapping raw data into the shared domain model.
 */
export class MangaKatanaSource implements PanelSource {
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
        allowedHosts: MangaKatanaSource.allowedHostsFor(config.baseUrl),
        timeoutMs: config.requestTimeoutMs,
        retryCount: config.requestRetryCount,
        retryBaseDelayMs: config.requestRetryBaseDelayMs,
        maxTextBytes: config.maxTextBytes,
        maxImageBytes: config.maxImageBytes,
      });
  }

  /** Allowlist = the source host itself (covers www. and the iN. image CDNs). */
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
   * Covers are served directly from mangakatana.com's own CDN (no hotlink
   * protection), but routing them through the API's image proxy lets the
    * client-side cache warm + persist them in the on-disk image cache.
   */
  async fetchImage(url: string): Promise<SourceImage> {
    this.assertEnabled();
    return this.http.fetchImage(url);
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
    return `${this.baseUrl}/manga/${encodeURIComponent(parts.panelId)}/${encodeURIComponent(parts.chapterToken)}`;
  }

  /** "<slug>" from a mangakatana.com/manga/… url (own host only). */
  nativePanelIdFromUrl(url: string): string | null {
    if (!isSameHost(url, this.baseUrl)) return null;
    return panelNativeIdFromUrl(url);
  }

  async search(query: string, page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    // Build the query with form-style encoding: URLSearchParams encodes spaces
    // as "+". MangaKatana only splits multi-word queries on "+" — an encoded
    // "%20" is treated literally and returns zero results, so full titles with
    // spaces silently failed while single words worked.
    const params = new URLSearchParams({
      search: query,
      search_by: 'book_name',
      page: String(page),
    });
    const url = `${this.baseUrl}/?${params.toString()}`;
    const { body, finalUrl } = await this.http.fetchText(url);
    const parsed = parseSearchPage(body, this.baseUrl);
    if (parsed.items.length === 0) {
      try {
        const detail = parsePanelPage(body, finalUrl, this.baseUrl);
        return {
          results: [
            this.toPanelSummary({
              nativeId: detail.nativeId,
              title: detail.title,
              coverUrl: detail.coverUrl,
              sourceUrl: detail.sourceUrl,
              status: detail.status,
              genres: detail.genres,
              summary: detail.description,
              latestChapterLabel: detail.latestChapterLabel,
              updatedAt: null,
            }),
          ],
          page,
          hasMore: false,
        };
      } catch (error) {
        if (!(error instanceof PageNotRecognizedError)) throw error;
      }
    }

    return {
      results: parsed.items.map((item) => this.toPanelSummary(item)),
      page,
      // The site paginates at ~20 items; a full page implies there may be more.
      hasMore: parsed.hasMore || parsed.items.length >= 20,
    };
  }

  async latest(page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    const pagePath = page <= 1 ? '/latest' : `/latest/page/${page}`;
    const { body } = await this.http.fetchText(`${this.baseUrl}${pagePath}`);
    const parsed = parseSearchPage(body, this.baseUrl);

    return {
      results: parsed.items.map((item) => this.toPanelSummary(item)),
      page,
      hasMore: parsed.hasMore || parsed.items.length >= 20,
    };
  }

  /**
   * Full genre catalog from the nav `Genres` sub-menu. Backs the filter
   * dropdowns so they offer every genre, not just the ones on the current
   * result page.
   */
  async getGenreList(): Promise<string[]> {
    this.assertEnabled();
    const { body } = await this.http.fetchText(`${this.baseUrl}/`);
    return parseGenreCatalog(body);
  }

  /**
   * Server-side genre filtering via the site's filter form
   * (`/latest/[page/N/]?filter=1&include=<slug>&exclude=<slug>` — include
   * AND a single exclude both work server-side). Dropdown labels resolve
   * to slugs through the nav genre index; an unresolvable label falls back
   * to the unfiltered listing (the UI still narrows client-side).
   * Multi-include is OR via one filtered fetch per genre, unioned
   * (approximate paging); further excludes are applied centrally by the
   * service (cards carry full genres).
   */
  async latestByGenre(
    genres: string[] | null,
    excludedGenres: string[] | null,
    page = 1,
  ): Promise<SourceSearchResult> {
    this.assertEnabled();
    const p = page >= 1 ? page : 1;
    const includes = genres ?? [];
    const excludes = excludedGenres ?? [];
    if (includes.length === 0 && excludes.length === 0) return this.latest(p);
    const { body: indexHtml } = await this.http.fetchText(`${this.baseUrl}/`);
    const links = parseGenreLinks(indexHtml, this.baseUrl);
    const slugOf = (label: string): string | null => {
      const href = links.find((entry) => entry.label.toLowerCase() === label.toLowerCase())?.href;
      return href ? (/\/genre\/([^/?#]+)\/?$/i.exec(href)?.[1] ?? null) : null;
    };
    const includeSlugs: string[] = [];
    for (const label of includes) {
      const slug = slugOf(label);
      if (!slug) return this.latest(p);
      includeSlugs.push(slug);
    }
    const excludeSlugs: string[] = [];
    for (const label of excludes) {
      const slug = slugOf(label);
      if (!slug) return this.latest(p);
      excludeSlugs.push(slug);
    }
    const fetchFiltered = async (includeSlug: string | null): Promise<SourceSearchResult> => {
      const params = new URLSearchParams({ filter: '1' });
      if (includeSlug) params.set('include', includeSlug);
      // The form takes a single exclusion; the rest is central.
      if (excludeSlugs.length === 1) params.set('exclude', excludeSlugs[0] as string);
      const pagePath = p <= 1 ? '/latest/' : `/latest/page/${p}/`;
      const { body } = await this.http.fetchText(`${this.baseUrl}${pagePath}?${params.toString()}`);
      const parsed = parseSearchPage(body, this.baseUrl);
      return {
        results: parsed.items.map((item) => this.toPanelSummary(item)),
        page: p,
        hasMore: parsed.hasMore || parsed.items.length >= 20,
      };
    };
    if (includeSlugs.length <= 1) {
      return fetchFiltered(includeSlugs[0] ?? null);
    }
    const settled = await Promise.allSettled(includeSlugs.map((slug) => fetchFiltered(slug)));
    return unionSearchResults(settled, p);
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
    const sourceUrl = this.buildPanelUrl(nativePanelId);
    const { body, finalUrl } = await this.http.fetchText(sourceUrl);

    const rawChapters = parseChapterList(body, this.baseUrl);

    if (rawChapters.length === 0) {
      // Distinguish "panel does not exist" from "no chapters listed".
      if (!body.includes('single_book')) {
        throw new SourceError(
          this.name,
          ErrorCodes.PANEL_NOT_FOUND,
          'The requested panel could not be found.',
          { nativePanelId },
        );
      }
      logger.warn('Panel page contained no chapters', {
        source: this.name,
        nativePanelId,
        finalUrl,
      });
    }

    const globalPanelId = toGlobalId(this.name, nativePanelId);
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

    if (raw.imageUrls.length === 0) {
      // Reader container existed but no image array — the site markup changed.
      logger.error('Chapter page had no extractable images', {
        source: this.name,
        nativeChapterId,
      });
      throw SourceError.parse(this.name, 'chapter image list');
    }

    const pages: PanelPage[] = raw.imageUrls.map((url, index) => {
      const dims = raw.dimensions[index] ?? null;
      return { index, url, source: this.name, width: dims?.width ?? null, height: dims?.height ?? null };
    });

    // Prev/next chapter from the reader's chapter <select> (ordered
    // newest-first, so the previous (older) chapter sits at index + 1).
    const currentToken = raw.currentToken ?? parts.chapterToken;
    const currentIdx = raw.chapterOptions.findIndex((o) => o.token === currentToken);
    const optionToId = (offset: number): string | null => {
      const option = raw.chapterOptions[currentIdx + offset];
      return option
        ? toGlobalId(this.name, joinNativeChapterId(parts.panelId, option.token))
        : null;
    };
    const prevChapterId = currentIdx >= 0 ? optionToId(1) : null;
    const nextChapterId = currentIdx >= 0 ? optionToId(-1) : null;

    return {
      chapterId: toGlobalId(this.name, nativeChapterId),
      panelId: toGlobalId(this.name, parts.panelId),
      panelTitle: raw.readerLabel ? raw.readerLabel.split(' - Chapter')[0] || null : null,
      chapterTitle: raw.chapterOptions[currentIdx]?.title ?? null,
      coverUrl: raw.coverUrl,
      pages,
      prevChapterId,
      nextChapterId,
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
