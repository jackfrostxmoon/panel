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
import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import {
  PageNotRecognizedError,
  chapterNumberFromToken,
  chapterRefFromUrl,
  panelNativeIdFromUrl,
  parseChapterListFromApi,
  parseChapterImagesFromApi,
  parseChapterReaderPage,
  parseGenreCatalog,
  parseGenreLinks,
  parseLatestPage,
  parsePanelPage,
  parseSearchPage,
} from './parser.js';

function absoluteUrl(href: string | undefined | null, baseUrl: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function textOf(el: HTMLElement | null | undefined): string | null {
  if (!el) return null;
  const text = (el.text ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : null;
}

export class KaliscanSource implements PanelSource {
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
        allowedHosts: KaliscanSource.allowedHostsFor(config.baseUrl),
        // Chapter images rotate across s<N>.1stmggv7.xyz (varying subdomain),
        // so allow the parent domain rather than one fixed s9 host.
        imageHosts: ['1stmggv7.xyz', '1stmangago.com'],
        timeoutMs: config.requestTimeoutMs,
        retryCount: config.requestRetryCount,
        retryBaseDelayMs: config.requestRetryBaseDelayMs,
      });
  }

  static allowedHostsFor(baseUrl: string): string[] {
    try {
      return [
        new URL(baseUrl).hostname.toLowerCase(),
        'cdn.1stmangago.com',
        's9.1stmggv7.xyz',
      ];
    } catch {
      return ['kaliscan.io', 'cdn.1stmangago.com', 's9.1stmggv7.xyz'];
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
   * Covers are served directly from kaliscan.io's own CDN (no hotlink
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

  nativePanelIdFromUrl(url: string): string | null {
    if (!isSameHost(url, this.baseUrl)) return null;
    return panelNativeIdFromUrl(url);
  }

  async search(query: string, page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    const params = new URLSearchParams({
      q: query,
      page: String(page),
    });
    const url = `${this.baseUrl}/search?${params.toString()}`;
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
      hasMore: parsed.hasMore || parsed.items.length >= 20,
    };
  }

  async latest(page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    // Kaliscan's "Latest" page is paginated as a query string, not a path
    // segment — the pagination link on the live site is
    //   <a href="/latest?page=2" class="btn btn-default link" type="button">Next »</a>
    // (see `.paginator` in parser.ts), so the path form `/latest/page/N/`
    // the adapter used to build is just served as a 200 with the same
    // first page of items, which made every "page 2+" load appear empty.
    const url =
      page <= 1
        ? `${this.baseUrl}/latest`
        : `${this.baseUrl}/latest?page=${encodeURIComponent(String(page))}`;
    const { body } = await this.http.fetchText(url);
    const parsed = parseLatestPage(body, this.baseUrl);

    return {
      results: parsed.items.map((item) => this.toPanelSummary(item)),
      page,
      hasMore: parsed.hasMore || parsed.items.length >= 20,
    };
  }

  /**
   * Full genre catalog from the nav `GENRES` menu. Backs the filter
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
   * (`/genres/<slug>`). The dropdown label resolves to the exact archive
   * URL through the nav genre index; an unresolvable label falls back to
   * the unfiltered listing (the UI still narrows client-side).
   *
   * Exclusion runs through the site's advanced search
   * (`/search?include[]=&exclude[]=`, verified to honor `exclude[]`
   * server-side): archive cards only carry the first ~4 genre tags, so a
   * client-side exclude over card genres is blind to anything truncated
   * off (e.g. an Action+Yaoi title whose card shows
   * Action/Adult/Drama/Mature keeps leaking when Yaoi is excluded).
   * Include-only keeps the archive path (canonical latest-update order);
   * anything involving an exclusion uses update-ordered search instead.
   */
  async latestByGenre(
    genre: string | null,
    excludedGenre: string | null,
    page = 1,
  ): Promise<SourceSearchResult> {
    this.assertEnabled();
    const p = page >= 1 ? page : 1;
    if (!genre && !excludedGenre) return this.latest(p);
    if (!excludedGenre) return this.latestByGenreArchive(genre, p);
    const slugs = await this.resolveGenreSlugs(genre, excludedGenre);
    if (!slugs?.exclude) return this.latestByGenreArchive(genre, p);
    const params = new URLSearchParams({ sort: 'updated_at' });
    if (slugs.include) params.append('include[]', slugs.include);
    params.append('exclude[]', slugs.exclude);
    if (p > 1) params.set('page', String(p));
    const { body } = await this.http.fetchText(`${this.baseUrl}/search?${params.toString()}`);
    const parsed = parseSearchPage(body, this.baseUrl);
    return {
      results: parsed.items.map((item) => this.toPanelSummary(item)),
      page: p,
      hasMore: parsed.hasMore || parsed.items.length >= 20,
    };
  }

  /** Include-only archive path (no exclusion involved). */
  private async latestByGenreArchive(
    genre: string | null,
    page: number,
  ): Promise<SourceSearchResult> {
    const p = page >= 1 ? page : 1;
    if (!genre) return this.latest(p);
    const { body: indexHtml } = await this.http.fetchText(`${this.baseUrl}/latest`);
    const href = parseGenreLinks(indexHtml, this.baseUrl).find(
      (entry) => entry.label.toLowerCase() === genre.toLowerCase(),
    )?.href;
    if (!href) return this.latest(p);
    const archiveUrl = p <= 1 ? href : `${href}?page=${encodeURIComponent(String(p))}`;
    const { body } = await this.http.fetchText(archiveUrl);
    const parsed = parseLatestPage(body, this.baseUrl);
    return {
      results: parsed.items.map((item) => this.toPanelSummary(item)),
      page: p,
      hasMore: parsed.hasMore || parsed.items.length >= 20,
    };
  }

  /**
   * Dropdown labels → search-filter slugs through the nav genre index
   * (exact match, case-insensitive). The `/genres/<slug>` space matches
   * the search form's `include[]`/`exclude[]` values. Null when a provided
   * label cannot be resolved — callers fall back to the unfiltered
   * endpoint. `exclude` is non-null here whenever `excludedGenre` was
   * given (both null only when neither label was given).
   */
  private async resolveGenreSlugs(
    genre: string | null,
    excludedGenre: string | null,
  ): Promise<{ include: string | null; exclude: string | null } | null> {
    const { body: indexHtml } = await this.http.fetchText(`${this.baseUrl}/latest`);
    const links = parseGenreLinks(indexHtml, this.baseUrl);
    const slugOf = (label: string): string | null => {
      const href = links.find((entry) => entry.label.toLowerCase() === label.toLowerCase())?.href;
      if (!href) return null;
      return /\/genres\/([^/?#]+)/i.exec(href)?.[1] ?? null;
    };
    const include = genre ? slugOf(genre) : null;
    const exclude = excludedGenre ? slugOf(excludedGenre) : null;
    if ((genre && !include) || (excludedGenre && !exclude)) return null;
    return { include, exclude };
  }

  /**
   * Server-side text search combined with genre filters (same `/search`
   * endpoint and slug resolution as the exclusion path of
   * `latestByGenre`; the site honors `exclude[]` natively). Unresolvable
   * labels fall back to the plain search (the UI still narrows
   * client-side).
   */
  async searchByGenre(
    query: string,
    genre: string | null,
    excludedGenre: string | null,
    page = 1,
  ): Promise<SourceSearchResult> {
    this.assertEnabled();
    const p = page >= 1 ? page : 1;
    if (!genre && !excludedGenre) return this.search(query, p);
    const slugs = await this.resolveGenreSlugs(genre, excludedGenre);
    if (!slugs) return this.search(query, p);
    const params = new URLSearchParams({ q: query });
    if (slugs.include) params.append('include[]', slugs.include);
    if (slugs.exclude) params.append('exclude[]', slugs.exclude);
    if (p > 1) params.set('page', String(p));
    const { body } = await this.http.fetchText(`${this.baseUrl}/search?${params.toString()}`);
    const parsed = parseSearchPage(body, this.baseUrl);
    return {
      results: parsed.items.map((item) => this.toPanelSummary(item)),
      page: p,
      hasMore: parsed.hasMore || parsed.items.length >= 20,
    };
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

    const bookIdMatch = /(\d+)-/.exec(nativePanelId);
    const bookId = bookIdMatch ? bookIdMatch[1] : nativePanelId;

    const { body } = await this.http.fetchText(
      `${this.baseUrl}/service/backend/chapterList/?manga_id=${bookId}`,
    );

    const rawChapters = parseChapterListFromApi(body, this.baseUrl);

    if (rawChapters.length === 0) {
      logger.warn('Chapter list API returned no chapters', {
        source: this.name,
        nativePanelId,
        bookId,
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
      publishedAt: null,
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

    const { body: chapterPageBody } = await this.http.fetchText(this.buildChapterUrl(nativeChapterId));

    const chapterIdMatch = /var chapterId\s*=\s*(\d+);/.exec(chapterPageBody);
    const chapterId = chapterIdMatch ? chapterIdMatch[1] : null;

    let imageUrls: string[] = [];
    let chapterOptions: Array<{ token: string; title: string }> = [];
    let currentToken: string | null = null;
    let coverUrl: string | null = null;
    let readerLabel: string | null = null;
    let panelTitleFromBreadcrumbs: string | null = null;

    const bookIdMatch = /(\d+)-/.exec(parts.panelId);
    const bookId = bookIdMatch ? bookIdMatch[1] : parts.panelId;

    // Fetch chapter list API to get chapter options (titles like "Chapter 1")
    let chapterListHtml = '';
    try {
      const { body } = await this.http.fetchText(`${this.baseUrl}/service/backend/chapterList/?manga_id=${bookId}`);
      chapterListHtml = body;
    } catch {
      logger.warn('Failed to fetch chapter list API', { source: this.name, nativePanelId: parts.panelId });
    }

    if (chapterId) {
      const { body: imagesHtml } = await this.http.fetchJson(
        `${this.baseUrl}/service/backend/chapterServer/?server_id=1&chapter_id=${chapterId}`,
        {
          Referer: this.buildChapterUrl(nativeChapterId),
          'X-Requested-With': 'XMLHttpRequest',
        },
      );

      imageUrls = parseChapterImagesFromApi(imagesHtml, this.baseUrl);

      const chapterPageRoot = parseHtml(chapterPageBody);
      coverUrl = absoluteUrl(
        chapterPageRoot.querySelector('meta[property="og:image"]')?.getAttribute('content'),
        this.baseUrl,
      );

      // Extract panel title from breadcrumbs (second item)
      const breadcrumbLinks = chapterPageRoot.querySelectorAll('.breadcrumbs-item a');
      if (breadcrumbLinks.length >= 2) {
        const panelLink = breadcrumbLinks[1];
        if (panelLink) {
          const panelSpan = panelLink.querySelector('span');
          panelTitleFromBreadcrumbs = textOf(panelSpan) ?? textOf(panelLink);
        }
      }

      // Parse chapter options from chapter list API (not from chapter page HTML)
      if (chapterListHtml) {
        const listRoot = parseHtml(chapterListHtml);
        for (const option of listRoot.querySelectorAll('.chapter-select option')) {
          const rawValue = option.getAttribute('value');
          const label = textOf(option);
          if (!rawValue || !label) continue;
          // Values are reader URLs like "/manga/<id>/chapter-12" — reduce them
          // to bare tokens ("chapter-12") so they match the current chapter
          // token (the list API marks no option as selected).
          const ref = chapterRefFromUrl(rawValue);
          const token = ref ? ref.token : rawValue;
          chapterOptions.push({ token, title: label });
        }
      }

      readerLabel = textOf(chapterPageRoot.querySelector('.viewer-header .chapter-title, .page-title, h1'));
    }

    if (imageUrls.length === 0) {
      const fallback = parseChapterReaderPage(chapterPageBody, this.baseUrl);
      imageUrls = fallback.imageUrls;
      chapterOptions = fallback.chapterOptions;
      currentToken = fallback.currentToken;
      coverUrl = fallback.coverUrl;
      readerLabel = fallback.readerLabel;
    }

    if (imageUrls.length === 0) {
      logger.error('Chapter page had no extractable images', {
        source: this.name,
        nativeChapterId,
      });
      throw SourceError.parse(this.name, 'chapter image list');
    }

    const pages: PanelPage[] = imageUrls.map((url, index) => ({
      index,
      url,
      source: this.name,
      width: null,
      height: null,
    }));

    const token = currentToken ?? parts.chapterToken;
    // Sort options ascending by chapter number so prev/next are positional and
    // independent of the source's newest-first option ordering.
    const ascending = [...chapterOptions].sort((a, b) => {
      const na = chapterNumberFromToken(a.token);
      const nb = chapterNumberFromToken(b.token);
      if (na !== null && nb !== null && na !== nb) return na - nb;
      return 0;
    });
    const currentIdx = ascending.findIndex((o) => o.token === token);
    const optionToId = (offset: number): string | null => {
      const option = ascending[currentIdx + offset];
      return option
        ? toGlobalId(this.name, joinNativeChapterId(parts.panelId, option.token))
        : null;
    };
    const prevChapterId = currentIdx > 0 ? optionToId(-1) : null;
    const nextChapterId = currentIdx >= 0 && currentIdx < ascending.length - 1 ? optionToId(1) : null;

    return {
      chapterId: toGlobalId(this.name, nativeChapterId),
      panelId: toGlobalId(this.name, parts.panelId),
      panelTitle: panelTitleFromBreadcrumbs ?? (readerLabel ? readerLabel.split(' - Chapter')[0] || null : null),
      chapterTitle: (currentIdx >= 0 ? ascending[currentIdx]?.title : null) ?? null,
      coverUrl,
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