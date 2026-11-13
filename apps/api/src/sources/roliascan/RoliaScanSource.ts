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

/**
 * Cap on the rotating image-CDN hosts remembered for failover. The site has
 * served at most a couple of hosts at a time (azabria → azc1bia, …), so this
 * is a generous safety bound, not an expected steady state.
 */
const MAX_LIVE_IMAGE_HOSTS = 6;

export class RoliaScanSource implements PanelSource {
  readonly name: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly enabled: boolean;

  private readonly http: SourceHttpClient;

  /**
   * Bulk genre lookup (panel metadata cache), wired by the registry.
   * Lets enrichment skip detail fetches for previously-seen panels.
   * Absent in tests / standalone use.
   */
  private readonly findGenres?: GenreLookup;

  /**
   * Image CDN root hosts (e.g. "tovahala.lol" — any subdomain matches), as
   * declared on the HTTP client's SSRF allowlist. Host *learning* below uses
   * the same roots to decide which observed hosts are CDN mirrors.
   */
  private readonly imageHostRoots: readonly string[];

  /**
   * Image CDN hosts the site has actually served, most recently seen first.
   * RoliaScan rotates these subdomains over time (azabria → azc1bia → …),
   * and each rotation kills the previous host at the DNS level — every
   * still-cached URL on the dead host then 504s through the proxy. URLs
   * captured from freshly parsed HTML keep this list current (see
   * `noteImageHosts`); failed fetches retry their path against the other
   * known hosts (see `fetchImageWithFailover`).
   */
  private readonly liveImageHosts: string[] = [];

  /**
   * Runtime max-throughput profile for the performance-mode toggle —
   * see SourceHttpClient.setPerformanceMode. Restores exact defaults OFF.
   */
  setPerformanceMode(on: boolean): void {
    this.http.setPerformanceMode(on);
  }

  constructor(config: SourceConfig, http?: SourceHttpClient, findGenres?: GenreLookup) {
    this.name = config.name;
    this.label = config.label;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.enabled = config.enabled;
    this.findGenres = findGenres;
    this.imageHostRoots = ['tovahala.lol'];
    this.http =
      http ??
      new SourceHttpClient(config.name, {
        allowedHosts: RoliaScanSource.allowedHostsFor(config.baseUrl),
        // Covers and reader images both live on the site's media CDN.
        imageHosts: this.imageHostRoots,
        timeoutMs: config.requestTimeoutMs,
        retryCount: config.requestRetryCount,
        retryBaseDelayMs: config.requestRetryBaseDelayMs,
        maxTextBytes: config.maxTextBytes,
        maxImageBytes: config.maxImageBytes,
        isolatedImageFetch: config.isolatedImageFetch,
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
   * Stale URLs pointing at an already-rotated CDN host recover through the
   * host failover below.
   */
  async fetchImage(url: string, opts?: { signal?: AbortSignal }): Promise<SourceImage> {
    this.assertEnabled();
    return this.fetchImageWithFailover(url, 'image', (candidate) =>
      this.http.fetchImage(candidate, undefined, opts?.signal).then(({ bytes, contentType }) => ({
        bytes,
        contentType,
      })), opts?.signal,
    );
  }

  /**
   * Streaming variant of `fetchImage` for the image cache: bytes go
   * straight to `destPath`, never accumulating in heap.
   */
  async fetchImageStream(url: string, destPath: string, opts?: { signal?: AbortSignal }): Promise<StreamedImage> {
    this.assertEnabled();
    return this.fetchImageWithFailover(url, 'streamed image', (candidate) =>
      this.http.fetchImageToFile(candidate, destPath, undefined, opts?.signal),
      opts?.signal,
    );
  }

  /**
   * Retry a failed image fetch by rewriting its host to the other image CDN
   * hosts the site has been observed serving (in-memory, learned from parsed
   * HTML — see `noteImageHosts`).
   *
   * Only retries TRANSIENT terminal failures: upstream timeouts and
   * DNS/connection-level errors surface as `SOURCE_TIMEOUT`, and upstream
   * 429/5xx as `SOURCE_UNAVAILABLE`. Definitive 4xx (a genuinely deleted
   * image) and SSRF allowlist rejections would fail identically on every
   * host, so they propagate unchanged.
   */
  private async fetchImageWithFailover<T>(
    url: string,
    label: string,
    attempt: (candidate: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await attempt(url);
    } catch (error) {
      const candidates = this.failoverCandidates(url, error, signal);
      if (candidates.length === 0) throw error;
      logger.warn('Image host failed — retrying on other known CDN hosts', {
        source: this.name,
        what: label,
        url,
        hosts: candidates.map((candidate) => new URL(candidate).hostname),
      });
      let lastError = error;
      for (const candidate of candidates) {
        try {
          const result = await attempt(candidate);
          logger.info('Image fetch succeeded after host failover', {
            source: this.name,
            what: label,
            from: new URL(url).hostname,
            to: new URL(candidate).hostname,
          });
          return result;
        } catch (candidateError) {
          // A reader that hung up mid-failover should abort the whole chain
          // instead of grinding through every remaining host.
          if (signal?.aborted) throw candidateError;
          lastError = candidateError;
        }
      }
      throw lastError;
    }
  }

  /** Candidate URLs: same path on the other learned image-CDN hosts. */
  private failoverCandidates(url: string, error: unknown, signal?: AbortSignal): string[] {
    if (signal?.aborted) return [];
    if (!(error instanceof SourceError)) return [];
    // SOURCE_TIMEOUT: upstream timeout OR a DNS/connection-level error —
    // exactly the two shapes a dead or unreachable CDN host produces.
    // SOURCE_UNAVAILABLE (not an allowlist rejection): upstream 429/5xx or
    // connection failure with a status — still worth another host.
    const retriable =
      error.code === ErrorCodes.SOURCE_TIMEOUT ||
      (error.code === ErrorCodes.SOURCE_UNAVAILABLE && !/not allowed/i.test(error.message));
    if (!retriable) return [];
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return [];
    }
    const host = parsed.hostname.toLowerCase();
    const candidates: string[] = [];
    for (const liveHost of this.liveImageHosts) {
      if (liveHost === host) continue;
      const rewritten = new URL(url);
      rewritten.hostname = liveHost;
      candidates.push(rewritten.toString());
    }
    return candidates;
  }

  /** True when `host` is (a subdomain of) one of the image CDN roots. */
  private isImageHost(host: string): boolean {
    return this.imageHostRoots.some((root) => host === root || host.endsWith(`.${root}`));
  }

  /**
   * Record the image CDN hosts seen in freshly parsed markup, newest first.
   * Called on every successfully parsed panel/chapter page, so the failover
   * list tracks the site's current rotation without any configuration.
   */
  private noteImageHosts(urls: ReadonlyArray<string | null | undefined>): void {
    for (const url of urls) {
      if (!url) continue;
      let host: string;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        continue;
      }
      if (!this.isImageHost(host) || this.liveImageHosts[0] === host) continue;
      const existing = this.liveImageHosts.indexOf(host);
      if (existing >= 0) this.liveImageHosts.splice(existing, 1);
      this.liveImageHosts.unshift(host);
      if (this.liveImageHosts.length > MAX_LIVE_IMAGE_HOSTS) {
        this.liveImageHosts.length = MAX_LIVE_IMAGE_HOSTS;
      }
      logger.info('Observed RoliaScan image CDN host', { source: this.name, host });
    }
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
    await this.enrichListGenres(parsed.items);
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
    await this.enrichListGenres(parsed.items);
    return {
      results: parsed.items.map((item) => this.toPanelSummary(item)),
      page,
      hasMore: parsed.hasMore,
    };
  }

  /**
   * Genre enrichment for listing results. The latest/search cards carry no
   * genre markup, so genres are filled from the panel metadata cache only
   * (panels the user has opened before).
   *
   * Deliberately cache-only: per-item detail fetches would be a full DOM
   * parse per card at high concurrency. Genre-less items are kept as-is —
   * the service's exclude filter is fail-open and the UI still narrows
   * client-side, so nothing is over-dropped.
   */
  private async enrichListGenres(items: Array<{ nativeId: string; genres: string[] }>): Promise<void> {
    await fillGenresFromCache(this.name, items, this.findGenres);
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
    await this.enrichListGenres(parsed.items);
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
      this.noteImageHosts([raw.coverUrl]);
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

  async getChapterPages(nativeChapterId: string, opts?: { serverPreference?: string; sourceUrl?: string }): Promise<ChapterPages> {
    this.assertEnabled();
    const parts = splitNativeChapterId(nativeChapterId);
    if (!parts) {
      throw new SourceError(this.name, ErrorCodes.VALIDATION_ERROR, 'Malformed chapter id.', {
        nativeChapterId,
      });
    }

    // The chapter may only exist in a non-English reader language
    // (`/fr/chapter-…`, `/es/chapter-…`) which the English-first URL builder
    // can't know about — prefer the source URL stored with the chapter row,
    // and fall back to the English reader path if it rots.
    const stored = opts?.sourceUrl && isSameHost(opts.sourceUrl, this.baseUrl) ? opts.sourceUrl : null;
    const english = this.buildChapterUrl(nativeChapterId);
    let body: string;
    if (stored) {
      try {
        ({ body } = await this.http.fetchText(stored));
      } catch {
        ({ body } = await this.http.fetchText(english));
      }
    } else {
      ({ body } = await this.http.fetchText(english));
    }

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

    this.noteImageHosts([parsed.coverUrl, ...parsed.imageUrls]);

    // A fallback strategy firing means the markup drifted from the known
    // layout — the payload may still be fine, so surface it loudly in the
    // logs instead of failing silently (or pretending all is well).
    if (parsed.strategy && parsed.strategy !== 'container') {
      logger.warn('Reader markup fallback used — RoliaScan layout may have changed', {
        source: this.name,
        nativeChapterId,
        strategy: parsed.strategy,
        images: parsed.imageUrls.length,
      });
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
