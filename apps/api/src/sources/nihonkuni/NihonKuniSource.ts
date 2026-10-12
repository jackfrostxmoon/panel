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
import { fillGenresFromCache } from '../../lib/cachedGenres.js';
import { unionSearchResults } from '../../lib/searchUnion.js';
import {
  chapterNumberFromToken,
  hasNextPage,
  panelNativeIdFromUrl,
  PageNotRecognizedError,
  parseChapterList,
  parseChapterReaderPage,
  parseGenreCatalog,
  parseGenreLinks,
  parseListPage,
  parsePanelPage,
  type RawChapterItem,
} from './parser.js';

/**
 * NihonKuni source adapter (nihonkuni.com).
 *
 * Custom-built (non-WordPress) raw panel site. URL layout (verified 2026-08):
 *   search:   GET {base}/manga-list.html?name=<q>[&page=N]
 *   latest:   GET {base}/manga-list.html?sort=last_update&sort_type=DESC[&page=N]
 *   panel:    GET {base}/manga-<slug>.html   (redirects to /manga/<slug>-<id>.html)
 *   chapter:  GET {base}/read-<slug>-chapter-<n>.html  (redirects to canonical)
 *
 * All HTML parsing lives in ./parser.ts — this class only deals with URLs,
 * ids, fetching and mapping raw data into the shared domain model.
 */
export class NihonKuniSource implements PanelSource {
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
        allowedHosts: NihonKuniSource.allowedHostsFor(config.baseUrl),
        timeoutMs: config.requestTimeoutMs,
        retryCount: config.requestRetryCount,
        retryBaseDelayMs: config.requestRetryBaseDelayMs,
        maxTextBytes: config.maxTextBytes,
        maxImageBytes: config.maxImageBytes,
      });
  }

  /** Allowlist = the source host itself plus its image CDN (subdomains allowed). */
  static allowedHostsFor(baseUrl: string): string[] {
    try {
      return [new URL(baseUrl).hostname.toLowerCase(), 'ihlv1.xyz'];
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
   * Covers are served directly from nihonkuni.com's own CDN (no hotlink
   * protection), but routing them through the API's image proxy lets the
    * client-side cache warm + persist them in the on-disk image cache.
   */
  async fetchImage(url: string, opts?: { signal?: AbortSignal }): Promise<SourceImage> {
    this.assertEnabled();
    return this.http.fetchImage(url, undefined, opts?.signal);
  }

  buildPanelUrl(nativePanelId: string): string {
    // Use the redirect-style URL (manga-<slug>.html), NOT /manga/<slug>.html —
    // the latter 404s on slugs that legitimately end in "-manga" because the
    // site only resolves them via the manga- form (301 → /manga/<slug>-<id>.html).
    return `${this.baseUrl}/manga-${encodeURIComponent(nativePanelId)}.html`;
  }

  buildChapterUrl(nativeChapterId: string): string {
    const parts = splitNativeChapterId(nativeChapterId);
    if (!parts) {
      throw new SourceError(this.name, ErrorCodes.VALIDATION_ERROR, 'Malformed chapter id.', {
        nativeChapterId,
      });
    }
    // e.g. read-one-piece-raw-chapter-1190.html (hyphens/dots survive encoding).
    return `${this.baseUrl}/read-${encodeURIComponent(parts.panelId)}-${encodeURIComponent(parts.chapterToken)}.html`;
  }

  /** "<slug>" from a nihonkuni.com/manga/<slug>.html url (own host only). */
  nativePanelIdFromUrl(url: string): string | null {
    if (!isSameHost(url, this.baseUrl)) return null;
    return panelNativeIdFromUrl(url);
  }

  async search(query: string, page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    // URLSearchParams encodes spaces as "+" — the form the site's own
    // /manga-list.html?name= links use.
    const params = new URLSearchParams({ name: query });
    if (page > 1) params.set('page', String(page));
    const url = `${this.baseUrl}/manga-list.html?${params.toString()}`;
    const { body, finalUrl } = await this.http.fetchText(url);

    const items = parseListPage(body, this.baseUrl);
    if (items.length === 0) {
      // A single exact match can redirect straight to the panel page.
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
                summary: null,
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
    }

    await this.enrichListGenres(items);
    return {
      results: items.map((item) => this.toPanelSummary(item)),
      page,
      hasMore: hasNextPage(body),
    };
  }

  async latest(page = 1): Promise<SourceSearchResult> {
    this.assertEnabled();
    const params = new URLSearchParams({ sort: 'last_update', sort_type: 'DESC' });
    if (page > 1) params.set('page', String(page));
    const url = `${this.baseUrl}/manga-list.html?${params.toString()}`;
    const { body } = await this.http.fetchText(url);

    const items = parseListPage(body, this.baseUrl);
    await this.enrichListGenres(items);
    return {
      results: items.map((item) => this.toPanelSummary(item)),
      page,
      hasMore: hasNextPage(body),
    };
  }

  /**
   * Genre enrichment for listing results. The manga-list cards carry no
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
   * Full genre catalog from the navbar genre grid (present on the manga
   * list page). Backs the filter dropdowns so they offer every genre, not
   * just the ones on the current result page.
   */
  async getGenreList(): Promise<string[]> {
    this.assertEnabled();
    const { body } = await this.http.fetchText(`${this.baseUrl}/manga-list.html`);
    return parseGenreCatalog(body);
  }

  /**
   * Dropdown label → genre archive slug through the navbar genre index
   * (exact match, case-insensitive). Null when the label isn't indexed —
   * callers fall back to the unfiltered endpoint.
   */
  private async genreSlug(label: string): Promise<string | null> {
    const { body: indexHtml } = await this.http.fetchText(`${this.baseUrl}/manga-list.html`);
    const href = parseGenreLinks(indexHtml, this.baseUrl).find(
      (entry) => entry.label.toLowerCase() === label.toLowerCase(),
    )?.href;
    return href ? (/manga-list-genre-(.+)\.html$/i.exec(href)?.[1] ?? null) : null;
  }

  /**
   * Server-side genre filtering via the site's genre listing pages
   * (`/manga-list-genre-<slug>.html`, paged as `manga-list.html?page=N&…
   * &genre=<slug>`). Include semantics are OR: several includes fetch one
   * archive each and union (approximate paging). The dropdown label is
   * resolved to the exact indexed URL; an unresolvable label falls back
   * to the unfiltered listing (the UI still narrows client-side).
   * Exclusion is applied centrally by the service (cards are enriched to
   * full genres first).
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
    const slugs: string[] = [];
    for (const label of includes) {
      const slug = await this.genreSlug(label);
      if (!slug) return this.latest(p);
      slugs.push(slug);
    }
    const fetchArchive = async (slug: string): Promise<SourceSearchResult> => {
      const url =
        p <= 1
          ? `${this.baseUrl}/manga-list-genre-${slug}.html`
          : `${this.baseUrl}/manga-list.html?page=${p}&sort=last_update&sort_type=DESC&genre=${slug}`;
      const { body } = await this.http.fetchText(url);
      const items = parseListPage(body, this.baseUrl);
      await this.enrichListGenres(items);
      return {
        results: items.map((item) => this.toPanelSummary(item)),
        page: p,
        hasMore: hasNextPage(body),
      };
    };
    if (slugs.length === 1) return fetchArchive(slugs[0] as string);
    const settled = await Promise.allSettled(slugs.map((slug) => fetchArchive(slug)));
    return unionSearchResults(settled, p);
  }

  /**
   * Server-side text search combined with genre constraints
   * (`manga-list.html?name=<q>&genre=<slug>`, one fetch per include,
   * unioned for OR). Same slug resolution and fallback semantics as
   * `latestByGenre`; the exact-match redirect fallback is kept (the UI
   * hides it client-side when the genre doesn't match). Exclusion is
   * applied centrally by the service.
   */
  async searchByGenre(
    query: string,
    genres: string[] | null,
    _excludedGenres: string[] | null,
    page = 1,
  ): Promise<SourceSearchResult> {
    this.assertEnabled();
    const p = page >= 1 ? page : 1;
    const includes = genres ?? [];
    if (includes.length === 0) return this.search(query, p);
    const slugs: string[] = [];
    for (const label of includes) {
      const slug = await this.genreSlug(label);
      if (!slug) return this.search(query, p);
      slugs.push(slug);
    }
    const fetchGenreSearch = async (slug: string): Promise<SourceSearchResult> => {
      // URLSearchParams encodes spaces as "+" — the form the site's own
      // /manga-list.html?name= links use.
      const params = new URLSearchParams({ name: query, genre: slug });
      if (p > 1) params.set('page', String(p));
      const url = `${this.baseUrl}/manga-list.html?${params.toString()}`;
      const { body, finalUrl } = await this.http.fetchText(url);
      const items = parseListPage(body, this.baseUrl);
      if (items.length === 0) {
        // A single exact match can redirect straight to the panel page.
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
                  summary: null,
                  latestChapterLabel: detail.latestChapterLabel,
                  updatedAt: null,
                }),
              ],
              page: p,
              hasMore: false,
            };
          }
        } catch (error) {
          if (!(error instanceof PageNotRecognizedError)) throw error;
        }
      }
      await this.enrichListGenres(items);
      return {
        results: items.map((item) => this.toPanelSummary(item)),
        page: p,
        hasMore: hasNextPage(body),
      };
    };
    if (slugs.length === 1) return fetchGenreSearch(slugs[0] as string);
    const settled = await Promise.allSettled(slugs.map((slug) => fetchGenreSearch(slug)));
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
    const { body, finalUrl } = await this.http.fetchText(sourceUrl);

    // 1) The detail page embeds only the latest ~192 chapters.
    let rawChapters = parseChapterList(body, this.baseUrl);

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
        finalUrl,
      });
    }

    // 2) The latest chapter's reader page lists every chapter in a sidebar.
    //    Prefer that full list; fall back to the embedded slice on any failure.
    const latest = rawChapters[0];
    if (latest) {
      try {
        const readerBody = (await this.http.fetchText(latest.sourceUrl)).body;
        const reader = parseChapterReaderPage(readerBody, this.baseUrl);
        if (reader.chapterOptions.length > 0) {
          rawChapters = reader.chapterOptions.map((option): RawChapterItem => ({
            nativeId: `${nativePanelId}~${option.token}`,
            panelNativeId: nativePanelId,
            chapterToken: option.token,
            title: option.title,
            chapterNumber: chapterNumberFromToken(option.token),
            sourceUrl: this.buildChapterUrl(`${nativePanelId}~${option.token}`),
            publishedAt: null,
          }));
        }
      } catch (error) {
        logger.warn('Reader page did not provide a chapter list; using embedded list', {
          source: this.name,
          nativePanelId,
          error,
        });
      }
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

    // The reader sidebar is ordered newest-first, so the previous (older)
    // chapter sits at index + 1.
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
      panelTitle: raw.panelTitle,
      chapterTitle: raw.chapterOptions[currentIdx]?.title ?? raw.readerLabel,
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
