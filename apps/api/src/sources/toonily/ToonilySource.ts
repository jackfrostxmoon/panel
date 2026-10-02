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
  PageNotRecognizedError,
  hasNextNumberedPage,
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
 * Toonily source adapter (toonily.com).
 *
 * WordPress site running the Madara theme. URL layout (verified 2026-08):
 *   archive:  GET {base}/            (home = "Latest Releases" archive)
 *             GET {base}/page/<n>/
 *   search:   GET {base}/?s=<q>&post_type=wp-manga
 *             GET {base}/page/<n>/?s=<q>&post_type=wp-manga
 *   panel:    GET {base}/serie/<slug>/
 *   chapter:  GET {base}/serie/<slug>/<chapter-token>/
 *
 * Native panel id: url slug (e.g. "the-beginning-after-the-end-ea2130e6").
 * Native chapter id: "<slug>~<chapter-token>"; decimals are dash-encoded on
 * the site ("chapter-381-5" = chapter 381.5) and special chapters may be
 * bare slugs ("epilogue") with no numeric value.
 *
 * All HTML parsing lives in ./parser.ts — this class only deals with URLs,
 * ids, fetching and mapping raw data into the shared domain model.
 */
export class ToonilySource implements PanelSource {
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
   * Parallel detail fetches when enriching a listing page. A failed item
   * only loses its genres — never the page — so this can be generous.
   */
  private readonly enrichConcurrency = 6;

  constructor(config: SourceConfig, http?: SourceHttpClient, findGenres?: GenreLookup) {
    this.name = config.name;
    this.label = config.label;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.enabled = config.enabled;
    this.findGenres = findGenres;
    this.http =
      http ??
      new SourceHttpClient(config.name, {
        allowedHosts: ToonilySource.allowedHostsFor(config.baseUrl),
        // Chapter images live on data.tnlycdn.com (covers on static.tnlycdn.com).
        imageHosts: ['tnlycdn.com'],
        timeoutMs: config.requestTimeoutMs,
        retryCount: config.requestRetryCount,
        retryBaseDelayMs: config.requestRetryBaseDelayMs,
        maxTextBytes: config.maxTextBytes,
        maxImageBytes: config.maxImageBytes,
        // Two Cloudflare/content quirks (verified 2026-08):
        //  - Requests whose User-Agent claims to be a browser get challenged
        //    (TLS fingerprint mismatch), so NO UA override is sent.
        //  - Without cookies the site serves the family-mode-filtered feed;
        //    `toonily-mature=1` (the site's own "Family Mode" toggle cookie)
        //    unlocks the full catalog including adult series.
        headers: { Cookie: 'toonily-mature=1' },
      });
  }

  /** Allowlist = source host + image CDNs (subdomains allowed by client). */
  static allowedHostsFor(baseUrl: string): string[] {
    try {
      return [
        new URL(baseUrl).hostname.toLowerCase(),
        'static.tnlycdn.com',
        'data.tnlycdn.com',
      ];
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
    return `${this.baseUrl}/serie/${encodeURIComponent(nativePanelId)}/`;
  }

  buildChapterUrl(nativeChapterId: string): string {
    const parts = splitNativeChapterId(nativeChapterId);
    if (!parts) {
      throw new SourceError(this.name, ErrorCodes.VALIDATION_ERROR, 'Malformed chapter id.', {
        nativeChapterId,
      });
    }
    // e.g. .../the-beginning-after-the-end-ea2130e6/chapter-249/
    return `${this.baseUrl}/serie/${encodeURIComponent(parts.panelId)}/${encodeURIComponent(
      parts.chapterToken,
    )}/`;
  }

  /** "tbate…" slug from a toonily.com/serie/… url (own host only). */
  nativePanelIdFromUrl(url: string): string | null {
    if (!isSameHost(url, this.baseUrl)) return null;
    return panelNativeIdFromUrl(url);
  }

  async search(query: string, page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    const params = new URLSearchParams({ s: query, post_type: 'wp-manga' });
    const pagePath = page <= 1 ? '/' : `/page/${page}/`;
    const url = `${this.baseUrl}${pagePath}?${params.toString()}`;
    const { body, finalUrl } = await this.http.fetchText(url);

    const items = parseSearchPage(body, this.baseUrl);
    if (items.length > 0) {
      await this.enrichListGenres(items);
      return {
        results: items.map((item) => this.toPanelSummary(item)),
        page,
        hasMore: hasNextNumberedPage(body, page),
      };
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
    // Canonical "Latest" ordering (most recent chapter updates first) — the
    // home page renders the same archive but through a widget that may drift.
    const pagePath = page <= 1 ? '/webtoons/' : `/webtoons/page/${page}/`;
    const { body } = await this.http.fetchText(`${this.baseUrl}${pagePath}?m_orderby=latest`);
    const items = parseArchivePage(body, this.baseUrl);
    await this.enrichListGenres(items);

    return {
      results: items.map((item) => this.toPanelSummary(item)),
      page,
      // Madara renders numbered pagination; a full page also implies more.
      hasMore: items.length >= 12 || hasNextNumberedPage(body, page),
    };
  }

  /**
   * Genre enrichment for listing results. The archive/search cards carry no
   * genre markup, so each item's genres are filled from its detail page
   * (the same parser `getPanel` uses). Bounded concurrency + per-item
   * tolerance: one slow or broken detail page never fails the listing.
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
          logger.debug('Could not enrich Toonily list-item genres', {
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
   * Full genre catalog from the archive page's `GENRES` block. Backs the
   * filter dropdowns so they offer every genre, not just the ones on the
   * current result page.
   */
  async getGenreList(): Promise<string[]> {
    this.assertEnabled();
    const { body } = await this.http.fetchText(`${this.baseUrl}/webtoons/`);
    return parseGenreCatalog(body);
  }

  /**
   * Server-side genre filtering via the site's genre archives
   * (`/genre/<slug>/`, Madara layout). Include semantics are OR: several
   * includes fetch one archive each and union (approximate paging). The
   * dropdown label resolves to the exact archive URL through the archive
   * page's `GENRES` block; an unresolvable label falls back to the
   * unfiltered archive (the UI still narrows client-side). Exclusion is
   * applied centrally by the service (cards are enriched to full genres
   * first).
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
    const { body: indexHtml } = await this.http.fetchText(`${this.baseUrl}/webtoons/`);
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
        hasMore: items.length >= 12 || hasNextNumberedPage(body, p),
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
    // Non-numeric tokens ("epilogue") sort last, keeping relative order.
    chapters.sort((a, b) => {
      if (a.chapterNumber === null && b.chapterNumber === null) return 0;
      if (a.chapterNumber === null) return 1;
      if (b.chapterNumber === null) return -1;
      return a.chapterNumber - b.chapterNumber;
    });
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
      url: this.proxiedImageUrl(url) ?? url,
      width: null,
      height: null,
    }));

    // Prev/next come straight from the reader nav links (Prev = older).
    const prevRef = raw.prevRef && raw.prevRef.panelId === parts.panelId ? raw.prevRef : null;
    const nextRef = raw.nextRef && raw.nextRef.panelId === parts.panelId ? raw.nextRef : null;

    return {
      chapterId: toGlobalId(this.name, nativeChapterId),
      panelId: toGlobalId(this.name, parts.panelId),
      panelTitle: raw.panelTitle,
      chapterTitle: raw.readerLabel,
      coverUrl: this.proxiedImageUrl(raw.coverUrl, 'cover'),
      pages,
      prevChapterId: prevRef
        ? toGlobalId(this.name, joinNativeChapterId(prevRef.panelId, prevRef.token))
        : null,
      nextChapterId: nextRef
        ? toGlobalId(this.name, joinNativeChapterId(nextRef.panelId, nextRef.token))
        : null,
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
      // Covers (static.tnlycdn.com) are open — browsers load them directly.
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
   * The data.tnlycdn.com chapter CDN only serves images carrying a
   * toonily.com Referer (hotlink protection) — browsers cannot send that
   * cross-origin. Point clients at the API's image proxy for those; other
   * hosts (e.g. static covers) stay direct. The kind path selects the proxy
   * cache bucket (cover vs chapter).
   */
  private proxiedImageUrl(
    url: string | null,
    kind: 'cover' | 'chapter' = 'chapter',
  ): string | null {
    if (!url) return null;
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return url;
    }
    if (!host.endsWith('.tnlycdn.com') || host.startsWith('static.')) return url;
    const params = new URLSearchParams({ source: this.name, u: url });
    return `/api/source-image/${kind}?${params.toString()}`;
  }

  /** Serve one CDN image with the Referer the source requires. */
  async fetchImage(url: string, opts?: { signal?: AbortSignal }): Promise<SourceImage> {
    this.assertEnabled();
    const { bytes, contentType } = await this.http.fetchImage(url, {
      Referer: `${this.baseUrl}/`,
    }, opts?.signal);
    return { bytes, contentType };
  }
}
