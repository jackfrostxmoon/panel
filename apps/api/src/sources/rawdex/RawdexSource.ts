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
import {
  hasNextPage,
  panelNativeIdFromUrl,
  PageNotRecognizedError,
  parseChapterList,
  parseChapterReaderPage,
  parseListPage,
  parsePanelPage,
  slugifyGenre,
} from './parser.js';

/**
 * RawDex source adapter (rawdex.net).
 *
 * WordPress (Madara) backend with a custom "rawdex-nova" theme (`rdx-*`
 * classes). URL layout (verified 2026-08):
 *   search:   GET {base}/?s=<query>&post_type=wp-manga
 *   latest:   GET {base}/            (page 1)
 *             GET {base}/page/<N>/   (page ≥ 2)
 *   panel:    GET {base}/manga/<slug>/
 *   chapter:  GET {base}/manga/<slug>/<chapter_number>/
 *
 * Native panel id: slug. Native chapter id: "<slug>~<number>" ("13", "14.5").
 *
 * Reader images are served from img.rawdex.net with hotlink protection —
 * they only load with a rawdex.net Referer, which browsers cannot send
 * cross-origin. All image URLs returned by this adapter are therefore
 * rewritten to the API's /api/source-image proxy, which adds the required
 * Referer server-side (see fetchImage). Covers live on the main host and
 * load directly.
 */
export class RawdexSource implements PanelSource {
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
        allowedHosts: RawdexSource.allowedHostsFor(config.baseUrl),
        // Chapter images live on img.rawdex.net (a subdomain of rawdex.net,
        // already allowed), but declaring it explicitly keeps the SSR guard
        // readable per-source.
        imageHosts: ['rawdex.net'],
        timeoutMs: config.requestTimeoutMs,
        retryCount: config.requestRetryCount,
        retryBaseDelayMs: config.requestRetryBaseDelayMs,
      });
  }

  /** Allowlist = the source host itself (img.rawdex.net via subdomain rule). */
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
    // e.g. .../manga/one-piece/13/
    return `${this.baseUrl}/manga/${encodeURIComponent(parts.panelId)}/${encodeURIComponent(
      parts.chapterToken,
    )}/`;
  }

  /** "<slug>" from a rawdex.net/manga/… url (own host only). */
  nativePanelIdFromUrl(url: string): string | null {
    if (!isSameHost(url, this.baseUrl)) return null;
    return panelNativeIdFromUrl(url);
  }

  async search(query: string, page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    const searchUrl =
      page > 1
        ? `${this.baseUrl}/page/${page}/?s=${encodeURIComponent(query)}&post_type=wp-manga`
        : `${this.baseUrl}/?s=${encodeURIComponent(query)}&post_type=wp-manga`;
    const { body } = await this.http.fetchText(searchUrl);

    const items = parseListPage(body, this.baseUrl);
    await this.enrichListGenres(items);
    return {
      results: items.map((item) => this.toPanelSummary(item)),
      page,
      hasMore: false, // WordPress search pagination is unreliable — single page.
    };
  }

  async latest(page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    const listUrl = page > 1 ? `${this.baseUrl}/page/${page}/` : `${this.baseUrl}/`;
    const { body } = await this.http.fetchText(listUrl);

    const items = parseListPage(body, this.baseUrl);
    await this.enrichListGenres(items);
    return {
      results: items.map((item) => this.toPanelSummary(item)),
      page,
      hasMore: hasNextPage(body, page),
    };
  }

  /**
   * Genre enrichment for listing results. The home/search cards carry no
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
          logger.debug('Could not enrich RawDex list-item genres', {
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
   * Server-side genre filtering via the site's genre archives
   * (`/manga-genre/<slug>/`). RawDex publishes no genre index, so the
   * archive slug is derived from the dropdown label; an unreachable
   * archive (or unresolvable label) falls back to the unfiltered listing
   * (the UI still narrows client-side). Exclusion is client-side only.
   */
  async latestByGenre(
    genre: string | null,
    _excludedGenre: string | null,
    page = 1,
  ): Promise<SourceSearchResult> {
    this.assertEnabled();
    const p = page >= 1 ? page : 1;
    if (!genre) return this.latest(p);
    const slug = slugifyGenre(genre);
    if (!slug) return this.latest(p);
    const archiveUrl =
      p <= 1
        ? `${this.baseUrl}/manga-genre/${slug}/`
        : `${this.baseUrl}/manga-genre/${slug}/page/${p}/`;
    try {
      const { body } = await this.http.fetchText(archiveUrl);
      const items = parseListPage(body, this.baseUrl);
      await this.enrichListGenres(items);
      return {
        results: items.map((item) => this.toPanelSummary(item)),
        page: p,
        hasMore: hasNextPage(body, p),
      };
    } catch (error) {
      // Unknown slug (or a source hiccup) — serve the unfiltered listing
      // instead of failing the page; the UI narrows client-side.
      logger.debug('RawDex genre archive unavailable — falling back to latest', {
        source: this.name,
        genre,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.latest(p);
    }
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

    // The detail page renders the chapter list server-side (newest-first).
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
      url: this.proxiedImageUrl(url) ?? url,
      width: null,
      height: null,
    }));

    // Only follow navigation links that point back into this same panel.
    const prevRef = raw.prevRef && raw.prevRef.panelId === parts.panelId ? raw.prevRef : null;
    const nextRef = raw.nextRef && raw.nextRef.panelId === parts.panelId ? raw.nextRef : null;

    let prevChapterId = prevRef
      ? toGlobalId(this.name, joinNativeChapterId(prevRef.panelId, prevRef.token))
      : null;
    let nextChapterId = nextRef
      ? toGlobalId(this.name, joinNativeChapterId(nextRef.panelId, nextRef.token))
      : null;

    // The reader only links one direction on edge chapters — infer missing
    // neighbours from the ordered chapter list.
    if (!prevChapterId || !nextChapterId) {
      const siblings = await this.getOrderedChapters(parts.panelId);
      const selfId = toGlobalId(this.name, nativeChapterId);
      const idx = siblings.findIndex((c) => c.id === selfId);
      if (idx !== -1) {
        const prevSibling = idx > 0 ? siblings[idx - 1] : undefined;
        const nextSibling = idx < siblings.length - 1 ? siblings[idx + 1] : undefined;
        if (!prevChapterId && prevSibling) prevChapterId = prevSibling.id;
        if (!nextChapterId && nextSibling) nextChapterId = nextSibling.id;
      }
    }

    return {
      chapterId: toGlobalId(this.name, nativeChapterId),
      panelId: toGlobalId(this.name, parts.panelId),
      panelTitle: raw.panelTitle,
      chapterTitle: raw.readerLabel ?? `Chapter ${parts.chapterToken}`,
      coverUrl: this.proxiedImageUrl(raw.coverUrl, 'cover'),
      pages,
      prevChapterId,
      nextChapterId,
    };
  }

  /**
   * Ascending chapter list for prev/next inference. Reuses the TTL cache /
   * in-flight dedup of the normal chapter flow; empty on failure (best-effort).
   */
  private async getOrderedChapters(nativePanelId: string): Promise<Chapter[]> {
    try {
      return await this.getChapters(nativePanelId);
    } catch (error) {
      logger.debug('Could not derive sibling chapters for navigation inference', {
        source: this.name,
        nativePanelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Reader images come from img.rawdex.net, which requires a rawdex.net
   * Referer (hotlink protection). Point clients at the API's image proxy,
   * which adds it server-side. The kind path selects the proxy cache bucket
   * (cover vs chapter).
   */
  private proxiedImageUrl(
    url: string | null,
    kind: 'cover' | 'chapter' = 'chapter',
  ): string | null {
    if (!url) return null;
    const params = new URLSearchParams({ source: this.name, u: url });
    return `/api/source-image/${kind}?${params.toString()}`;
  }

  /** Serve one CDN image with the Referer the source requires. */
  async fetchImage(url: string): Promise<SourceImage> {
    this.assertEnabled();
    const { bytes, contentType } = await this.http.fetchImage(url, {
      Referer: `${this.baseUrl}/`,
    });
    return { bytes, contentType };
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
