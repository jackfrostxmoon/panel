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

  /**
   * Runtime max-throughput profile for the performance-mode toggle —
   * see SourceHttpClient.setPerformanceMode. Restores exact defaults OFF.
   */
  setPerformanceMode(on: boolean): void {
    this.http.setPerformanceMode(on);
  }

  /**
   * Mirror bases tried in order when the configured base is unreachable.
   * KaliScan hops TLDs to dodge blocks and its `.io` registration expired
   * in 2026, so every text/JSON fetch fails over across these (configured
   * base first) and sticks to the first mirror that answers.
   */
  private static readonly FALLBACK_BASE_URLS = [
    'https://kaliscan.me',
    'https://kaliscan.com',
    'https://kaliscan.net',
  ];

  /**
   * Substrings present on genuine reader pages / API fragments but absent
   * from the SEO-spam squatters currently parked on retired KaliScan
   * domains — guards failover so a squatter's HTTP 200 never counts as a
   * working mirror (which would otherwise stick and serve empty results
   * instead of the offline cache fallback).
   */
  private static readonly READER_MARKERS = [
    'book-item',
    'genres__wrapper',
    'paginator',
    'book-info',
    'chapter-select',
    'chapter__content',
    'reading-box',
    'chapter-image',
    'chapterId',
  ];

  /** All candidate bases (configured first, then mirrors, deduplicated). */
  private readonly baseUrls: string[];
  /** Last base that answered — tried first so failover only costs extra
   * latency while every mirror is actually down. */
  private activeBaseUrl: string;

  constructor(config: SourceConfig, http?: SourceHttpClient) {
    this.name = config.name;
    this.label = config.label;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.enabled = config.enabled;
    this.baseUrls = [
      this.baseUrl,
      ...KaliscanSource.FALLBACK_BASE_URLS.filter((mirror) => mirror !== this.baseUrl),
    ];
    this.activeBaseUrl = this.baseUrls[0] ?? this.baseUrl;
    this.http =
      http ??
      new SourceHttpClient(config.name, {
        allowedHosts: KaliscanSource.allowedHostsFor(config.baseUrl),
        // Chapter images rotate across s<N> hosts in two CDN families
        // (legacy 1stmggv7.xyz, current 1stmggv2.org with signed URLs), so
        // allow the parent domains rather than one fixed s9 host.
        imageHosts: ['1stmggv7.xyz', '1stmggv2.org', '1stmangago.com'],
        timeoutMs: config.requestTimeoutMs,
        retryCount: config.requestRetryCount,
        retryBaseDelayMs: config.requestRetryBaseDelayMs,
        maxTextBytes: config.maxTextBytes,
        maxImageBytes: config.maxImageBytes,
        isolatedImageFetch: config.isolatedImageFetch,
      });
  }

  static allowedHostsFor(baseUrl: string): string[] {
    const hosts = new Set<string>();
    try {
      hosts.add(new URL(baseUrl).hostname.toLowerCase());
    } catch {
      hosts.add('kaliscan.io');
    }
    // Mirror failover targets must pass the SSRF allowlist too.
    for (const mirror of KaliscanSource.FALLBACK_BASE_URLS) {
      hosts.add(new URL(mirror).hostname.toLowerCase());
    }
    hosts.add('cdn.1stmangago.com');
    hosts.add('s9.1stmggv7.xyz');
    return [...hosts];
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
   * Transport failures worth trying the next mirror for: timeouts, DNS /
   * connection resets and 429/5xx. HTTP 404 is definitive (the same path
   * 404s on every mirror) and any other code propagates immediately.
   */
  private static isFailoverTransportError(error: unknown): boolean {
    if (!(error instanceof SourceError)) return false;
    if (error.code !== ErrorCodes.SOURCE_TIMEOUT && error.code !== ErrorCodes.SOURCE_UNAVAILABLE) {
      return false;
    }
    const upstreamStatus = (error.details as { upstreamStatus?: unknown } | undefined)
      ?.upstreamStatus;
    return upstreamStatus !== 404;
  }

  /** Reject squatter/parked-domain HTML so failover keeps looking. */
  private static assertReaderMarkup(body: string, what: string): void {
    if (KaliscanSource.READER_MARKERS.some((marker) => body.includes(marker))) return;
    throw new PageNotRecognizedError(`Kaliscan ${what} contained no reader markup.`);
  }

  /**
   * Run `attempt` against each candidate base (last-working first),
   * failing over on transport errors and unrecognized (squatter) pages.
   * Client aborts and definitive errors propagate immediately. When every
   * mirror answered with non-reader content the result is a
   * PageNotRecognizedError (callers map it as "not found"); when at least
   * one mirror was unreachable the last transport error wins so the
   * offline cache fallback engages.
   */
  private async withFailover<T>(
    label: string,
    attempt: (base: string) => Promise<T>,
  ): Promise<{ result: T; baseUrl: string }> {
    const ordered = [this.activeBaseUrl, ...this.baseUrls.filter((base) => base !== this.activeBaseUrl)];
    let lastTransportError: unknown = null;
    let sawTransportError = false;
    for (const base of ordered) {
      try {
        const result = await attempt(base);
        this.activeBaseUrl = base;
        return { result, baseUrl: base };
      } catch (error) {
        if (error instanceof PageNotRecognizedError) {
          logger.warn('Kaliscan mirror served an unrecognized page, trying next', {
            source: this.name,
            base,
            label,
          });
          continue;
        }
        if (KaliscanSource.isFailoverTransportError(error)) {
          sawTransportError = true;
          lastTransportError = error;
          logger.warn('Kaliscan mirror unreachable, trying next', {
            source: this.name,
            base,
            label,
            code: error instanceof SourceError ? error.code : 'unknown',
          });
          continue;
        }
        throw error;
      }
    }
    if (!sawTransportError) {
      throw new PageNotRecognizedError(`No Kaliscan mirror served a recognizable ${label}.`);
    }
    throw lastTransportError;
  }

  /** Map an all-mirrors-unrecognized failure to "source unavailable" for
   * listing endpoints (where empty results are legitimate and must not
   * read as a parse error). */
  private unavailableAfterFailover(path: string): SourceError {
    return SourceError.unavailable(this.name, `${this.baseUrl}${path}`);
  }

  /** Rewrite site-host image URLs (e.g. stale cached covers pointing at a
   * dead base) onto the last-working mirror. CDN hosts pass through. */
  private rebaseToActiveBase(url: string): string {
    let parsed: URL;
    let activeHost: string;
    try {
      parsed = new URL(url);
      activeHost = new URL(this.activeBaseUrl).hostname.toLowerCase();
    } catch {
      return url;
    }
    if (parsed.hostname.toLowerCase() === activeHost) return url;
    const isSiteHost = this.baseUrls.some((base) => {
      try {
        return new URL(base).hostname.toLowerCase() === parsed.hostname.toLowerCase();
      } catch {
        return false;
      }
    });
    if (!isSiteHost) return url;
    parsed.hostname = activeHost;
    return parsed.toString();
  }

  /**
   * Covers are served directly from kaliscan.io's own CDN (no hotlink
   * protection), but routing them through the API's image proxy lets the
   * client-side cache warm + persist them in the on-disk image cache.
   */
  async fetchImage(url: string, opts?: { signal?: AbortSignal }): Promise<SourceImage> {
    this.assertEnabled();
    return this.http.fetchImage(this.rebaseToActiveBase(url), undefined, opts?.signal);
  }

  /**
   * Streaming variant of `fetchImage` for the image cache: bytes go
   * straight to `destPath`, never accumulating in heap.
   */
  async fetchImageStream(url: string, destPath: string, opts?: { signal?: AbortSignal }): Promise<StreamedImage> {
    this.assertEnabled();
    return this.http.fetchImageToFile(this.rebaseToActiveBase(url), destPath, undefined, opts?.signal);
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
    if (!this.baseUrls.some((base) => isSameHost(url, base))) return null;
    return panelNativeIdFromUrl(url);
  }

  async search(query: string, page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    const params = new URLSearchParams({
      q: query,
      page: String(page),
    });
    const path = `/search?${params.toString()}`;
    let fetched: { result: { body: string; finalUrl: string }; baseUrl: string };
    try {
      fetched = await this.withFailover('search page', async (base) => {
        const { body, finalUrl } = await this.http.fetchText(`${base}${path}`);
        KaliscanSource.assertReaderMarkup(body, 'search page');
        return { body, finalUrl };
      });
    } catch (error) {
      if (error instanceof PageNotRecognizedError) throw this.unavailableAfterFailover(path);
      throw error;
    }
    const { result, baseUrl } = fetched;
    const parsed = parseSearchPage(result.body, baseUrl);
    if (parsed.items.length === 0) {
      try {
        const detail = parsePanelPage(result.body, result.finalUrl, baseUrl);
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
    const path = page <= 1 ? '/latest' : `/latest?page=${encodeURIComponent(String(page))}`;
    let fetched: { result: { body: string; finalUrl: string }; baseUrl: string };
    try {
      fetched = await this.withFailover('latest page', async (base) => {
        const { body, finalUrl } = await this.http.fetchText(`${base}${path}`);
        KaliscanSource.assertReaderMarkup(body, 'latest page');
        return { body, finalUrl };
      });
    } catch (error) {
      if (error instanceof PageNotRecognizedError) throw this.unavailableAfterFailover(path);
      throw error;
    }
    const { result, baseUrl } = fetched;
    const parsed = parseLatestPage(result.body, baseUrl);

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
    try {
      const { result } = await this.withFailover('genre index', async (base) => {
        const { body } = await this.http.fetchText(`${base}/latest`);
        KaliscanSource.assertReaderMarkup(body, 'genre index');
        return { body };
      });
      return parseGenreCatalog(result.body);
    } catch (error) {
      if (error instanceof PageNotRecognizedError) throw this.unavailableAfterFailover('/latest');
      throw error;
    }
  }

  /**
   * Server-side genre filtering. Include semantics are OR; exclusion runs
   * through the site's advanced search (`/search?include[]=&exclude[]=`,
   * verified to honor `exclude[]` server-side, with `include_mode=or` for
   * multi-include).
   *
   * Archive cards only carry the first ~4 genre tags, so a client-side
   * exclude over card genres is blind to anything truncated off (e.g. an
   * Action+Yaoi title whose card shows Action/Adult/Drama/Mature keeps
   * leaking when Yaoi is excluded). Single-include without exclusions
   * keeps the archive path (canonical latest-update order); anything
   * involving an exclusion or several includes uses update-ordered search
   * instead. Unresolvable labels fall back to the unfiltered listing (the
   * UI still narrows client-side).
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
    if (includes.length <= 1 && excludes.length === 0) {
      return this.latestByGenreArchive(includes[0] ?? null, p);
    }
    const slugs = await this.resolveGenreSlugs(includes, excludes);
    if (!slugs) return this.latestByGenreArchive(includes[0] ?? null, p);
    const params = new URLSearchParams({ sort: 'updated_at' });
    for (const include of slugs.includes) params.append('include[]', include);
    // Multi-include is OR (verified live: mode=or returns titles carrying
    // only one of the includes; mode=and is ignored by the site).
    if (slugs.includes.length > 1) params.append('include_mode', 'or');
    for (const exclude of slugs.excludes) params.append('exclude[]', exclude);
    if (p > 1) params.set('page', String(p));
    const path = `/search?${params.toString()}`;
    let fetched: { result: { body: string }; baseUrl: string };
    try {
      fetched = await this.withFailover('genre-filtered search', async (base) => {
        const { body } = await this.http.fetchText(`${base}${path}`);
        KaliscanSource.assertReaderMarkup(body, 'genre-filtered search');
        return { body };
      });
    } catch (error) {
      if (error instanceof PageNotRecognizedError) throw this.unavailableAfterFailover(path);
      throw error;
    }
    const parsed = parseSearchPage(fetched.result.body, fetched.baseUrl);
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
    try {
      const { result: index } = await this.withFailover('genre index', async (base) => {
        const { body } = await this.http.fetchText(`${base}/latest`);
        KaliscanSource.assertReaderMarkup(body, 'genre index');
        return { body };
      });
      const href = parseGenreLinks(index.body, this.activeBaseUrl).find(
        (entry) => entry.label.toLowerCase() === genre.toLowerCase(),
      )?.href;
      if (!href) return this.latest(p);
      const target = p <= 1 ? href : `${href}?page=${encodeURIComponent(String(p))}`;
      const { result, baseUrl } = await this.withFailover('genre archive', async (base) => {
        // `href` is absolute (built from the winning index base); reduce it
        // to a path so failover actually changes hosts per attempt.
        let relative = target;
        try {
          const parsedHref = new URL(target);
          relative = `${parsedHref.pathname}${parsedHref.search}`;
        } catch {
          // Already relative — use as-is.
        }
        const { body } = await this.http.fetchText(`${base}${relative}`);
        KaliscanSource.assertReaderMarkup(body, 'genre archive');
        return { body };
      });
      const parsed = parseLatestPage(result.body, baseUrl);
      return {
        results: parsed.items.map((item) => this.toPanelSummary(item)),
        page: p,
        hasMore: parsed.hasMore || parsed.items.length >= 20,
      };
    } catch (error) {
      if (error instanceof PageNotRecognizedError) {
        throw SourceError.unavailable(this.name, `${this.baseUrl}/latest`);
      }
      throw error;
    }
  }

  /**
   * Dropdown labels → search-filter slugs through the nav genre index
   * (exact match, case-insensitive). The `/genres/<slug>` space matches
   * the search form's `include[]`/`exclude[]` values. Null when any
   * provided label cannot be resolved — callers fall back to the
   * unfiltered endpoint.
   */
  private async resolveGenreSlugs(
    genres: readonly string[],
    excludedGenres: readonly string[],
  ): Promise<{ includes: string[]; excludes: string[] } | null> {
    let indexHtml: string;
    try {
      const { result } = await this.withFailover('genre index', async (base) => {
        const { body } = await this.http.fetchText(`${base}/latest`);
        KaliscanSource.assertReaderMarkup(body, 'genre index');
        return { body };
      });
      indexHtml = result.body;
    } catch (error) {
      // Unresolvable labels fall back to the unfiltered listing.
      if (error instanceof PageNotRecognizedError) return null;
      throw error;
    }
    const links = parseGenreLinks(indexHtml, this.activeBaseUrl);
    const slugOf = (label: string): string | null => {
      const href = links.find((entry) => entry.label.toLowerCase() === label.toLowerCase())?.href;
      if (!href) return null;
      return /\/genres\/([^/?#]+)/i.exec(href)?.[1] ?? null;
    };
    const includes: string[] = [];
    for (const label of genres) {
      const slug = slugOf(label);
      if (!slug) return null;
      includes.push(slug);
    }
    const excludes: string[] = [];
    for (const label of excludedGenres) {
      const slug = slugOf(label);
      if (!slug) return null;
      excludes.push(slug);
    }
    return { includes, excludes };
  }

  /**
   * Server-side text search combined with genre filters (same `/search`
   * endpoint and slug resolution as the exclusion path of
   * `latestByGenre`; the site honors `exclude[]` natively, multi-include
   * is OR via `include_mode=or`). Unresolvable labels fall back to the
   * plain search (the UI still narrows client-side).
   */
  async searchByGenre(
    query: string,
    genres: string[] | null,
    excludedGenres: string[] | null,
    page = 1,
  ): Promise<SourceSearchResult> {
    this.assertEnabled();
    const p = page >= 1 ? page : 1;
    const includes = genres ?? [];
    const excludes = excludedGenres ?? [];
    if (includes.length === 0 && excludes.length === 0) return this.search(query, p);
    const slugs = await this.resolveGenreSlugs(includes, excludes);
    if (!slugs) return this.search(query, p);
    const params = new URLSearchParams({ q: query });
    for (const include of slugs.includes) params.append('include[]', include);
    if (slugs.includes.length > 1) params.append('include_mode', 'or');
    for (const exclude of slugs.excludes) params.append('exclude[]', exclude);
    if (p > 1) params.set('page', String(p));
    const path = `/search?${params.toString()}`;
    let fetched: { result: { body: string }; baseUrl: string };
    try {
      fetched = await this.withFailover('genre-filtered search', async (base) => {
        const { body } = await this.http.fetchText(`${base}${path}`);
        KaliscanSource.assertReaderMarkup(body, 'genre-filtered search');
        return { body };
      });
    } catch (error) {
      if (error instanceof PageNotRecognizedError) throw this.unavailableAfterFailover(path);
      throw error;
    }
    const parsed = parseSearchPage(fetched.result.body, fetched.baseUrl);
    return {
      results: parsed.items.map((item) => this.toPanelSummary(item)),
      page: p,
      hasMore: parsed.hasMore || parsed.items.length >= 20,
    };
  }

  async getPanel(nativePanelId: string): Promise<Panel> {
    this.assertEnabled();
    const path = `/manga/${encodeURIComponent(nativePanelId)}`;
    let fetched: { result: { body: string; finalUrl: string }; baseUrl: string };
    try {
      fetched = await this.withFailover('panel page', async (base) => {
        const { body, finalUrl } = await this.http.fetchText(`${base}${path}`);
        KaliscanSource.assertReaderMarkup(body, 'panel page');
        return { body, finalUrl };
      });
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
    const { result, baseUrl } = fetched;

    try {
      const raw = parsePanelPage(result.body, result.finalUrl, baseUrl);
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

    let body: string;
    let baseUrl: string;
    try {
      const fetched = await this.withFailover('chapter list', async (base) => {
        const { body: listHtml } = await this.http.fetchText(
          `${base}/service/backend/chapterList/?manga_id=${bookId}`,
        );
        KaliscanSource.assertReaderMarkup(listHtml, 'chapter list');
        return { body: listHtml };
      });
      body = fetched.result.body;
      baseUrl = fetched.baseUrl;
    } catch (error) {
      // A mirror that answers without reader markup behaves like an empty
      // chapter list; transport errors still propagate to the cache fallback.
      if (error instanceof PageNotRecognizedError) {
        logger.warn('Chapter list API returned no recognizable content', {
          source: this.name,
          nativePanelId,
          bookId,
        });
        return [];
      }
      throw error;
    }

    const rawChapters = parseChapterListFromApi(body, baseUrl);

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

    const chapterPath = `/manga/${encodeURIComponent(parts.panelId)}/${encodeURIComponent(parts.chapterToken)}`;
    const { result: chapterPage, baseUrl: pageBaseUrl } = await this.withFailover(
      'chapter page',
      async (base) => {
        const { body } = await this.http.fetchText(`${base}${chapterPath}`);
        KaliscanSource.assertReaderMarkup(body, 'chapter page');
        return { body };
      },
    );
    const chapterPageBody = chapterPage.body;

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
      const { result } = await this.withFailover('chapter list', async (base) => {
        const { body } = await this.http.fetchText(`${base}/service/backend/chapterList/?manga_id=${bookId}`);
        KaliscanSource.assertReaderMarkup(body, 'chapter list');
        return { body };
      });
      chapterListHtml = result.body;
    } catch {
      logger.warn('Failed to fetch chapter list API', { source: this.name, nativePanelId: parts.panelId });
    }

    if (chapterId) {
      const imagesPath = `/service/backend/chapterServer/?server_id=1&chapter_id=${chapterId}`;
      const { result: imagesFetched, baseUrl: imagesBaseUrl } = await this.withFailover(
        'chapter images',
        async (base) => {
          const { body } = await this.http.fetchJson(
            `${base}${imagesPath}`,
            {
              Referer: `${base}${chapterPath}`,
              'X-Requested-With': 'XMLHttpRequest',
            },
          );
          if (!body.includes('chapter-image') && !body.includes('data-src')) {
            throw new PageNotRecognizedError('Chapter image API returned no reader markup.');
          }
          return { body };
        },
      );
      const imagesHtml = imagesFetched.body;

      imageUrls = parseChapterImagesFromApi(imagesHtml, imagesBaseUrl);

      const chapterPageRoot = parseHtml(chapterPageBody);
      coverUrl = absoluteUrl(
        chapterPageRoot.querySelector('meta[property="og:image"]')?.getAttribute('content'),
        pageBaseUrl,
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
      const fallback = parseChapterReaderPage(chapterPageBody, pageBaseUrl);
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