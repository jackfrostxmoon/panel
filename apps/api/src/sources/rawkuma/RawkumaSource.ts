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
  decodeNonce,
  hasNextPage,
  panelNativeIdFromUrl,
  PageNotRecognizedError,
  parseChapterList,
  parseChapterReaderPage,
  parseGenreCatalog,
  parseGenreTerms,
  parseListPage,
  parsePanelPage,
  parseSearchPage,
} from './parser.js';

/**
 * Rawkuma source adapter (rawkuma.net).
 *
 * WordPress + custom Tailwind/HTMX theme (not Madara). URL layout (verified
 * 2026-08):
 *   search:   GET  {base}/wp-admin/admin-ajax.php?type=search_form&action=get_nonce
 *             POST {base}/wp-admin/admin-ajax.php  (action=advanced_search)
 *   latest:   GET  {base}/latest-update/[?the_page=N]
 *   panel:    GET  {base}/manga/<slug>/
 *   chapter:  GET  {base}/manga/<slug>/chapter-<label>.<postId>/
 *
 * The chapter postId is REQUIRED and semantically meaningful — a wrong postId
 * serves a different series — so native chapter ids embed it:
 * "<slug>~chapter-<label>.<postId>".
 *
 * All HTML parsing lives in ./parser.ts — this class only deals with URLs,
 * ids, fetching and mapping raw data into the shared domain model.
 */
export class RawkumaSource implements PanelSource {
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
        allowedHosts: RawkumaSource.allowedHostsFor(config.baseUrl),
        // Chapter images are served from dedicated CDN hosts, NOT the
        // rawkuma.net domain: the kyut.dev pool (observed: kuma.kyut.dev,
        // rcdn.kyut.dev, …) and — since ~2026-09 — cdn.rawkuma.com (note
        // the .com: a different registrable domain from the source host).
        // Declaring the roots covers every subdomain (the allowlist
        // matches subdomains) while keeping the SSRF guard in place for
        // the image proxy.
        imageHosts: [...RawkumaSource.allowedHostsFor(config.baseUrl), 'kyut.dev', 'rawkuma.com'],
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
    // e.g. .../manga/one-piece/chapter-1190.12345/ (dots survive encoding).
    return `${this.baseUrl}/manga/${encodeURIComponent(parts.panelId)}/${encodeURIComponent(
      parts.chapterToken,
    )}/`;
  }

  /** "<slug>" from a rawkuma.net/manga/… url (own host only). */
  nativePanelIdFromUrl(url: string): string | null {
    if (!isSameHost(url, this.baseUrl)) return null;
    return panelNativeIdFromUrl(url);
  }

  private async fetchSearchNonce(): Promise<string> {
    const { body } = await this.http.fetchText(
      `${this.baseUrl}/wp-admin/admin-ajax.php?type=search_form&action=get_nonce`,
    );
    const nonce = decodeNonce(body);
    if (!nonce) {
      throw SourceError.parse(this.name, 'search nonce');
    }
    return nonce;
  }

  async search(query: string, page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    const nonce = await this.fetchSearchNonce();
    const { body } = await this.http.postForm(`${this.baseUrl}/wp-admin/admin-ajax.php`, {
      action: 'advanced_search',
      nonce,
      query,
      page: String(page),
    });

    // Search caps at ~24 results with no pagination UI.
    const items = parseSearchPage(body, this.baseUrl);
    await this.enrichListGenres(items);
    return {
      results: items.map((item) => this.toPanelSummary(item)),
      page,
      hasMore: false,
    };
  }

  async latest(page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    const url =
      page > 1
        ? `${this.baseUrl}/latest-update/?the_page=${page}`
        : `${this.baseUrl}/latest-update/`;
    const { body } = await this.http.fetchText(url);

    const items = parseListPage(body, this.baseUrl);
    if (items.length === 0) {
      // An empty latest feed is almost always an outage (Cloudflare
      // challenge, origin 5xx served as 200, changed markup) — never a
      // source with no updates. Warn so it shows in logs instead of a
      // silent empty 200; PanelService serves the last good cached row.
      logger.warn('Rawkuma latest page parsed to 0 items', { page, url });
    }
    await this.enrichListGenres(items);
    return {
      results: items.map((item) => this.toPanelSummary(item)),
      page,
      hasMore: hasNextPage(body, page),
    };
  }

  /**
   * Genre enrichment for listing results. The latest/search cards carry no
   * genre markup, so genres are filled from the panel metadata cache only
   * (panels the user has opened before).
   *
   * Deliberately cache-only: a live per-item detail fetch here costs an
   * extra page fetch + full DOM parse per card, which is the cold-start
   * memory/CPU spike. Genre-less items are kept as-is — the service's
   * exclude filter is fail-open and the UI still narrows client-side, so
   * nothing is over-dropped.
   */
  private async enrichListGenres(items: Array<{ nativeId: string; genres: string[] }>): Promise<void> {
    await fillGenresFromCache(this.name, items, this.findGenres);
  }

  /**
   * Full genre catalog from the library page's embedded genre index. Backs
   * the filter dropdowns so they offer every genre, not just the ones on
   * the current result page.
   */
  async getGenreList(): Promise<string[]> {
    this.assertEnabled();
    const { body } = await this.http.fetchText(`${this.baseUrl}/library/`);
    return parseGenreCatalog(body);
  }

  /**
   * Dropdown labels → library filter slugs through the library page's
   * genre index. Null when any provided label cannot be resolved (caller
   * falls back to the unfiltered endpoint).
   */
  private async resolveGenreSlugs(
    genres: readonly string[],
    excludedGenres: readonly string[],
  ): Promise<{ includes: string[]; excludes: string[] } | null> {
    const { body: indexHtml } = await this.http.fetchText(`${this.baseUrl}/library/`);
    const terms = parseGenreTerms(indexHtml);
    const slugOf = (label: string): string | null =>
      terms.find((term) => term.name.toLowerCase() === label.toLowerCase())?.slug ?? null;
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
   * Server-side genre filtering through the library search endpoint
   * (`advanced_search` with `genre` / `genre_exclude` slug lists — include
   * AND exclude both work server-side; multi-include is OR, verified
   * live). Dropdown labels resolve to slugs through the library page's
   * genre index; unresolvable labels fall back to the unfiltered listing
   * (the UI still narrows client-side).
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
    const slugs = await this.resolveGenreSlugs(includes, excludes);
    if (!slugs) return this.latest(p);
    const nonce = await this.fetchSearchNonce();
    const { body } = await this.http.postForm(`${this.baseUrl}/wp-admin/admin-ajax.php`, {
      action: 'advanced_search',
      nonce,
      query: '',
      page: String(p),
      genre: JSON.stringify(slugs.includes),
      genre_exclude: JSON.stringify(slugs.excludes),
    });
    const items = parseSearchPage(body, this.baseUrl);
    await this.enrichListGenres(items);
    // The endpoint returns a bare HTML fragment with no pagination
    // markup — a full page implies there may be more.
    return {
      results: items.map((item) => this.toPanelSummary(item)),
      page: p,
      hasMore: items.length >= 24,
    };
  }

  /**
   * Server-side text search combined with genre filters (same endpoint
   * and slug resolution as `latestByGenre`). Items are enriched so the
   * UI's client-side narrowing and badges keep working.
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
    const nonce = await this.fetchSearchNonce();
    const { body } = await this.http.postForm(`${this.baseUrl}/wp-admin/admin-ajax.php`, {
      action: 'advanced_search',
      nonce,
      query,
      page: String(p),
      genre: JSON.stringify(slugs.includes),
      genre_exclude: JSON.stringify(slugs.excludes),
    });
    // Search caps at ~24 results with no pagination UI.
    const items = parseSearchPage(body, this.baseUrl);
    await this.enrichListGenres(items);
    return {
      results: items.map((item) => this.toPanelSummary(item)),
      page: p,
      hasMore: false,
    };
  }

  async getPanel(nativePanelId: string): Promise<Panel> {
    this.assertEnabled();
    const sourceUrl = this.buildPanelUrl(nativePanelId);
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
    const { body } = await this.http.fetchText(sourceUrl);

    // The detail page renders the FULL chapter list server-side (newest-first).
    const rawChapters = parseChapterList(body, this.baseUrl);

    if (rawChapters.length === 0) {
      // Distinguish "panel does not exist" from "no chapters listed".
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
      logger.error('Chapter page had no extractable images', {
        source: this.name,
        nativeChapterId,
      });
      throw SourceError.parse(this.name, 'chapter image list');
    }

    const pages: PanelPage[] = raw.imageUrls.map((url, index) => ({
      index,
      url,
      // Tag with the source prefix so the client routes these through the
      // API's image proxy — the CDN hotlink-protects chapter images and
      // browsers cannot send a rawkuma.net Referer cross-origin.
      source: this.name,
      width: null,
      height: null,
    }));

    // Only follow navigation links that point back into this same panel.
    const prevRef = raw.prevRef && raw.prevRef.panelId === parts.panelId ? raw.prevRef : null;
    const nextRef = raw.nextRef && raw.nextRef.panelId === parts.panelId ? raw.nextRef : null;

    return {
      chapterId: toGlobalId(this.name, nativeChapterId),
      panelId: toGlobalId(this.name, parts.panelId),
      panelTitle: raw.panelTitle,
      chapterTitle: raw.readerLabel,
      coverUrl: raw.coverUrl,
      pages,
      prevChapterId: prevRef
        ? toGlobalId(this.name, joinNativeChapterId(prevRef.panelId, prevRef.token))
        : null,
      nextChapterId: nextRef
        ? toGlobalId(this.name, joinNativeChapterId(nextRef.panelId, nextRef.token))
        : null,
    };
  }

  /**
   * Serve one CDN image with the Referer the source requires. Reader pages
   * are tagged with this source's prefix (see getChapterPages), so the
   * client routes them through the API's image proxy; proxying also warms +
    * persists images in the on-disk image cache.
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
