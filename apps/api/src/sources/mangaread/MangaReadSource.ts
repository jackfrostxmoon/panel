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
  PageNotRecognizedError,
  panelNativeIdFromUrl,
  parseArchivePage,
  parseChapterList,
  parseChapterReaderPage,
  parseGenreCatalog,
  parseGenreLinks,
  parsePanelPage,
  parseSearchPage,
} from './parser.js';

/**
 * MangaRead source adapter (mangaread.org).
 *
 * WordPress site running the Madara theme. URL layout (verified 2026-08):
 *   archive:  GET {base}/manga/            (ordered by latest update)
 *             GET {base}/manga/page/<n>/   (12 items per page)
 *   search:   GET {base}/?s=<q>&post_type=wp-manga   (single page, no paging)
 *   panel:    GET {base}/manga/<slug>/
 *   chapter:  GET {base}/manga/<slug>/chapter-<num>/
 *
 * Native panel id: url slug (e.g. "one-piece").
 * Native chapter id: "<slug>~<chapter-token>" (e.g. "one-piece~chapter-1014";
 * decimals are dash-encoded on the site, e.g. "~chapter-4-5" = chapter 4.5).
 *
 * All HTML parsing lives in ./parser.ts — this class only deals with URLs,
 * ids, fetching and mapping raw data into the shared domain model.
 */
export class MangaReadSource implements PanelSource {
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
        allowedHosts: MangaReadSource.allowedHostsFor(config.baseUrl),
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
   * Covers are served directly from mangaread.org's own CDN (no hotlink
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
    return `${this.baseUrl}/manga/${encodeURIComponent(normalizeNativeSegment(nativePanelId))}/`;
  }

  buildChapterUrl(nativeChapterId: string): string {
    const parts = splitNativeChapterId(nativeChapterId);
    if (!parts) {
      throw new SourceError(this.name, ErrorCodes.VALIDATION_ERROR, 'Malformed chapter id.', {
        nativeChapterId,
      });
    }
    // e.g. .../one-piece/chapter-1014
    return `${this.baseUrl}/manga/${encodeURIComponent(normalizeNativeSegment(parts.panelId))}/${encodeURIComponent(normalizeNativeSegment(parts.chapterToken))}/`;
  }

  /** "one-piece" from a mangaread.org/manga/… url (own host only). */
  nativePanelIdFromUrl(url: string): string | null {
    if (!isSameHost(url, this.baseUrl)) return null;
    return panelNativeIdFromUrl(url);
  }

  async search(query: string, page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    // The site's search has no pagination (no page links rendered and
    // /page/N/?s=… returns 404), so only the first page exists.
    if (page > 1) {
      return { results: [], page, hasMore: false };
    }

    const params = new URLSearchParams({ s: query, post_type: 'wp-manga' });
    const url = `${this.baseUrl}/?${params.toString()}`;
    const { body, finalUrl } = await this.http.fetchText(url);
    const results = parseSearchPage(body, this.baseUrl).map((item) => this.toPanelSummary(item));
    if (results.length > 0) {
      return { results, page, hasMore: false };
    }

    // Madara redirects straight to the details page for a single exact hit.
    try {
      const detail = parsePanelPage(body, finalUrl, this.baseUrl);
      if (detail.nativeId) {
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
      }
    } catch (error) {
      if (!(error instanceof PageNotRecognizedError)) throw error;
    }

    return { results: [], page, hasMore: false };
  }

  async latest(page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    const pagePath = page <= 1 ? '/manga/' : `/manga/page/${page}/`;
    const { body } = await this.http.fetchText(`${this.baseUrl}${pagePath}`);
    const items = parseArchivePage(body, this.baseUrl);
    await this.enrichListGenres(items);

    return {
      results: items.map((item) => this.toPanelSummary(item)),
      page,
      // The archive renders no pagination markup; a full 12-item page implies
      // there may be more.
      hasMore: items.length >= 12,
    };
  }

  /**
   * Genre enrichment for archive results. The archive cards carry no genre
   * markup (unlike the search cards), so genres are filled from the panel
   * metadata cache only (panels the user has opened before).
   *
   * Deliberately cache-only: a live per-item detail fetch here costs 12
   * extra page fetches + full DOM parses per latest page, which is the
   * cold-start memory/CPU spike. Genre-less items are kept as-is — the
   * service's exclude filter is fail-open and the UI still narrows
   * client-side, so nothing is over-dropped.
   */
  private async enrichListGenres(items: Array<{ nativeId: string; genres: string[] }>): Promise<void> {
    await fillGenresFromCache(this.name, items, this.findGenres);
  }

  /**
   * Full genre catalog from the nav `Genres` sub-menu. Backs the filter
   * dropdowns so they offer every genre, not just the ones on the current
   * result page.
   */
  async getGenreList(): Promise<string[]> {
    this.assertEnabled();
    const { body } = await this.http.fetchText(`${this.baseUrl}/manga/`);
    return parseGenreCatalog(body);
  }

  /**
   * Server-side genre filtering via the site's genre archives
   * (`/genres/<slug>/`, Madara layout). Include semantics are OR: several
   * includes fetch one archive each and union (approximate paging). The
   * dropdown label resolves to the exact archive URL through the nav genre
   * index; an unresolvable label falls back to the unfiltered archive
   * (the UI still narrows client-side). Exclusion is applied centrally by
   * the service (cards are enriched to full genres first).
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
    const { body: indexHtml } = await this.http.fetchText(`${this.baseUrl}/manga/`);
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
      const archiveUrl = p <= 1 ? href : `${href.replace(/\/+$/, '')}/page/${p}/`;
      const { body } = await this.http.fetchText(archiveUrl);
      const items = parseArchivePage(body, this.baseUrl);
      await this.enrichListGenres(items);
      return {
        results: items.map((item) => this.toPanelSummary(item)),
        page: p,
        hasMore: items.length >= 12,
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

    try {
      const raw = parsePanelPage(body, sourceUrl, this.baseUrl);
      return {
        ...this.toPanelSummary({
          nativeId: raw.nativeId || nativePanelId,
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
      return [];
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
      source: this.name,
      width: null,
      height: null,
    }));

    // Prev/next come straight from the reader nav links (Prev = older).
    const prevChapterId = raw.prevRef
      ? toGlobalId(this.name, joinNativeChapterId(raw.prevRef.panelId, raw.prevRef.token))
      : null;
    const nextChapterId = raw.nextRef
      ? toGlobalId(this.name, joinNativeChapterId(raw.nextRef.panelId, raw.nextRef.token))
      : null;

    return {
      chapterId: toGlobalId(this.name, nativeChapterId),
      panelId: toGlobalId(this.name, parts.panelId),
      panelTitle: raw.panelTitle,
      chapterTitle: raw.chapterTitle,
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

/**
 * Backward compat for ids persisted before `chapterRefFromUrl` decoded
 * percent-encoding (e.g. "...-%ef%bd%9e-...~chapter-1-1"). Those native ids
 * still contain literal "%XX" — decode once so `encodeURIComponent` below
 * single-encodes instead of producing "%25XX" 404s. New (already-decoded)
 * ids pass through untouched; malformed "%" passes through as-is.
 */
function normalizeNativeSegment(value: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
