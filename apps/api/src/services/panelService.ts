import {
  ErrorCodes,
  parseGlobalId,
  toGlobalId,
  type Chapter,
  type ChapterPages,
  type Panel,
  type PanelPage,
  type PanelSource,
  type SourceSearchResult,
} from '@panel/shared';
import type { CacheConfig } from '../config.js';
import type { PanelCacheRepository } from '../repositories/panelCacheRepository.js';
import type { PanelRow, ChapterRow } from '../db/schema.js';
import { InFlight, TtlCache } from '../lib/cache.js';
import { AppError } from '../lib/errors.js';
import { recordSourceCacheHit, recordSourceCacheMiss } from '../lib/stats.js';
import { cleanGenreLabel, dedupeGenreLabels } from '../lib/text.js';
import type { SourceRegistry } from '../sources/registry.js';

/** Genre catalogs change rarely — one fetch per source per day is plenty. */
const GENRE_LIST_TTL_MS = 24 * 60 * 60_000;

/**
 * Central exclude enforcement for listing results. Adapters that cannot
 * exclude server-side ignore `excludedGenres` (see `PanelSource`), and
 * listing cards can truncate genres — so without this, `exclude=` is
 * advisory and excluded titles leak (e.g. a card showing 4 of 8 genres
 * with the excluded one cut off).
 *
 * Positive-evidence only: an item is dropped solely when one of its
 * (cleaned) genres case-insensitively equals ANY excluded label.
 * Truncation can hide a genre but never fabricate one, so this cannot
 * over-drop — unlike include enforcement, which stays with the adapters
 * plus client-side narrowing. Genre-less items are kept ("unknown" is
 * not "doesn't match"). Idempotent with the UI's own narrowing.
 */
function applyExcludedGenres<T extends { genres: string[] }>(
  results: T[],
  excludedGenres: readonly string[] | null,
): T[] {
  const lowered = (excludedGenres ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (lowered.length === 0) return results;
  const blocked = new Set(lowered);
  return results.filter(
    (item) => !item.genres.some((genre) => blocked.has(genre.toLowerCase())),
  );
}

/**
 * Normalize a genre label list from the HTTP layer: trim, drop empties,
 * dedupe case-insensitively (first display form wins). Null when nothing
 * remains so callers can branch on "no constraint".
 */
function normalizeGenreLabels(labels: readonly string[] | null | undefined): string[] | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels ?? []) {
    const label = raw.trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out.length > 0 ? out : null;
}

/** Stable cache-key fragment for a normalized genre list (sorted, lowercase). */
function genreKeyFragment(labels: string[] | null): string {
  if (!labels) return '';
  return labels.map((l) => l.toLowerCase()).sort().join(',');
}

/**
 * PanelService — the only door between HTTP routes and panel sources.
 *
 * Adds three cross-cutting concerns on top of the raw source adapters:
 *  1. TTL caching (per endpoint type, configured via env).
 *  2. In-flight request deduplication (a slow source is only hit once for
 *     concurrent identical requests).
 *  3. Source-outage resilience: every successful fetch is upserted into the
 *     metadata cache, and a failing source falls back to that cache so a
 *     panel's details + chapter list still load when the source is down
 *     (offline after a prior visit, or a source 5xx).
 */
export class PanelService {
  private readonly cache: TtlCache<unknown>;
  private readonly inFlight = new InFlight<unknown>();

  constructor(
    private readonly registry: SourceRegistry,
    private readonly cacheConfig: CacheConfig,
    private readonly panelCache: PanelCacheRepository,
  ) {
    // Bounded so a long browse can't pin hundreds of MB of listing/page
    // payloads in heap (see CACHE_MAX_ENTRIES).
    this.cache = new TtlCache<unknown>(Math.max(16, Math.floor(cacheConfig.maxEntries)));
  }

  private async cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      recordSourceCacheHit();
      return hit as T;
    }
    recordSourceCacheMiss();
    return (await this.inFlight.dedupe(key, async () => {
      const value = await loader();
      this.cache.set(key, value, ttlMs);
      return value;
    })) as T;
  }

  /**
   * Try the live source; on failure fall back to the metadata cache. The
   * cache is written on every success, so it only has data for panel the
   * user has already visited — a first-time visit with the source down
   * still errors, which is correct (nothing to show).
   */
  private async withOfflineFallback<T>(
    missCache: () => Promise<T | undefined>,
    live: () => Promise<T>,
    cacheMissError: (cause: unknown) => AppError,
  ): Promise<T> {
    try {
      return await live();
    } catch (cause) {
      const cached = await missCache();
      if (cached !== undefined) return cached;
      throw cacheMissError(cause);
    }
  }

  /**
   * Resolve the sources to query. When `sources` is given, only those
   * (among the enabled ones) are used — unknown prefixes are silently
   * dropped here; the HTTP route validates them before reaching the service.
   * With NO filter only the FIRST enabled source is queried: fanning a
   * single request out to every site at once looks like bot traffic and
   * gets the user rate-limited or blocked.
   */
  private resolveSources(sources?: string[]): PanelSource[] {
    const enabled = this.registry.list().filter((s) => s.enabled);
    if (!sources || sources.length === 0) return enabled.slice(0, 1);
    const byName = new Map(enabled.map((s) => [s.name, s]));
    return sources.map((name) => byName.get(name)).filter((s): s is PanelSource => s !== undefined);
  }

  private mergeSourceResults(
    settled: PromiseSettledResult<SourceSearchResult>[],
    page: number,
  ): SourceSearchResult {
    const merged: SourceSearchResult = { results: [], page, hasMore: false };
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        merged.results.push(...result.value.results);
        merged.hasMore = merged.hasMore || result.value.hasMore;
      }
      // A failing source must not break search while others succeed —
      // the error is logged inside the adapter's HTTP client.
    }
    if (merged.results.length === 0 && settled.every((r) => r.status === 'rejected')) {
      // Every queried source failed → surface the first error.
      throw (settled[0] as PromiseRejectedResult).reason;
    }
    return merged;
  }

  search(
    query: string,
    page: number,
    sources?: string[],
    genres?: string[] | null,
    excludedGenres?: string[] | null,
  ): Promise<SourceSearchResult> {
    const toQuery = this.resolveSources(sources);
    const filter = sources && sources.length > 0 ? sources.join(',') : '*';
    const baseKey = query.trim().toLowerCase();
    // Genre constraints get their own cache + persistence keys so a
    // filtered search can never be served as (or overwrite) the unfiltered
    // one. Unfiltered calls keep the historic key (existing caches stay).
    const g = normalizeGenreLabels(genres);
    const x = normalizeGenreLabels(excludedGenres);
    const key = g || x ? `${baseKey}:genre:${genreKeyFragment(g)}:excluded:${genreKeyFragment(x)}` : baseKey;
    return this.cached(
      `search:${key}:${page}:${filter}`,
      this.cacheConfig.searchMs,
      async () => {
        const live = async () => {
          // Single source with a combo-capable adapter → filter at the
          // source. Anything else falls through to the plain search; the
          // UI still narrows client-side.
          const only = toQuery.length === 1 ? toQuery[0] : undefined;
          if ((g || x) && only && typeof only.searchByGenre === 'function') {
            return only.searchByGenre(query, g, x, page);
          }
          const settled = await Promise.allSettled(toQuery.map((s) => s.search(query, page)));
          return this.mergeSourceResults(settled, page);
        };
        const result = await this.withOfflineFallback(
          async () => {
            const row = await this.panelCache.findList('search', key, filter, page);
            return row ? { results: row.results, page: row.page, hasMore: row.hasMore } : undefined;
          },
          live,
          (cause) =>
            new AppError(
              ErrorCodes.SOURCE_UNAVAILABLE,
              `Could not reach sources to search for "${query}".`,
              { cause: cause instanceof Error ? cause.message : String(cause) },
            ),
        );
        const cleanedResult: SourceSearchResult = {
          ...result,
          results: applyExcludedGenres(
            result.results.map((r) => ({
              ...r,
              genres: (r.genres ?? []).map((g) => cleanGenreLabel(g)).filter(Boolean),
            })),
            x,
          ),
        };
        // Persist so a later offline visit shows the same list.
        await this.panelCache
          .upsertList('search', key, filter, page, cleanedResult.results, cleanedResult.hasMore)
          .catch(() => {
            /* persistence is best-effort */
          });
        return cleanedResult;
      },
    );
  }

  latest(
    page: number,
    sources?: string[],
    genres?: string[] | null,
    excludedGenres?: string[] | null,
  ): Promise<SourceSearchResult> {
    const toQuery = this.resolveSources(sources);
    const filter = sources && sources.length > 0 ? sources.join(',') : '*';
    // Genre constraints get their own cache + persistence keys so a
    // filtered list can never be served as (or overwrite) the unfiltered
    // one. Unfiltered calls keep the historic key (existing caches stay).
    const g = normalizeGenreLabels(genres);
    const x = normalizeGenreLabels(excludedGenres);
    const key = g || x ? `page:${page}:genre:${genreKeyFragment(g)}:excluded:${genreKeyFragment(x)}` : `page:${page}`;
    return this.cached(
      `latest:${page}:${filter}:${genreKeyFragment(g)}:${genreKeyFragment(x)}`,
      this.cacheConfig.searchMs,
      async () => {
        const live = async () => {
          // Single source with a genre-capable adapter → filter at the
          // source (whole catalog, not just the loaded page). Anything
          // else falls through to the plain listing; the UI still narrows
          // client-side.
          const only = toQuery.length === 1 ? toQuery[0] : undefined;
          if ((g || x) && only && typeof only.latestByGenre === 'function') {
            return only.latestByGenre(g, x, page);
          }
          const settled = await Promise.allSettled(toQuery.map((s) => s.latest(page)));
          return this.mergeSourceResults(settled, page);
        };
        const result = await this.withOfflineFallback(
          async () => {
            const row = await this.panelCache.findList('latest', key, filter, page);
            return row ? { results: row.results, page: row.page, hasMore: row.hasMore } : undefined;
          },
          live,
          (cause) =>
            new AppError(
              ErrorCodes.SOURCE_UNAVAILABLE,
              `Could not reach sources to fetch the latest chapter list.`,
              { cause: cause instanceof Error ? cause.message : String(cause) },
            ),
        );
        const cleanedResult: SourceSearchResult = {
          ...result,
          results: applyExcludedGenres(
            result.results.map((r) => ({
              ...r,
              genres: (r.genres ?? []).map((g) => cleanGenreLabel(g)).filter(Boolean),
            })),
            x,
          ),
        };
        // Persist so a later offline visit shows the same list.
        await this.panelCache
          .upsertList('latest', key, filter, page, cleanedResult.results, cleanedResult.hasMore)
          .catch(() => {
            /* persistence is best-effort */
          });
        return cleanedResult;
      },
    );
  }

  getPanel(globalId: string): Promise<Panel> {
    return this.cached(`panel:${globalId}`, this.cacheConfig.panelMs, async () => {
      const { source, nativeId } = this.registry.forGlobalId(globalId);
      const panel = await this.withOfflineFallback(
        async () => toApiPanel(await this.panelCache.findPanelByGlobalId(globalId)),
        () => source.getPanel(nativeId),
        (cause) =>
          new AppError(
            ErrorCodes.SOURCE_UNAVAILABLE,
            `Could not reach source "${source.name}" to fetch panel details.`,
            { cause: cause instanceof Error ? cause.message : String(cause) },
          ),
      );
      const cleanedPanel = {
        ...panel,
        genres: panel.genres.map((g) => cleanGenreLabel(g)).filter(Boolean),
      };
      // Persist so a later offline visit can still load it.
      await this.panelCache
        .upsertPanel({
          source: cleanedPanel.source,
          sourceId: nativeId,
          globalId,
          title: cleanedPanel.title,
          altTitles: cleanedPanel.altTitles,
          description: cleanedPanel.description,
          authors: cleanedPanel.authors,
          artists: cleanedPanel.artists,
          genres: cleanedPanel.genres,
          status: cleanedPanel.status,
          coverUrl: cleanedPanel.coverUrl,
          sourceUrl: cleanedPanel.sourceUrl,
        })
        .catch(() => {
          /* persistence is best-effort */
        });
      return cleanedPanel;
    });
  }

  getChapters(globalId: string): Promise<Chapter[]> {
    return this.cached(`chapters:${globalId}`, this.cacheConfig.chaptersMs, async () => {
      const { source, nativeId } = this.registry.forGlobalId(globalId);
      const panelRow = await this.panelCache.findPanelByGlobalId(globalId);
      const chapters = await this.withOfflineFallback(
        async () => {
          const cached = await this.panelCache.findChaptersByPanel(globalId);
          // An empty row set is NOT a usable offline copy — it just means
          // the panel was bookmarked but its chapter list was never fetched.
          // Return undefined so the live error surfaces (with retry) instead
          // of misleading the UI into "No chapters found."
          if (!cached || cached.rows.length === 0) return undefined;
          return toApiChapters(cached.rows);
        },
        () => source.getChapters(nativeId),
        (cause) =>
          new AppError(
            ErrorCodes.SOURCE_UNAVAILABLE,
            `Could not reach source "${source.name}" to fetch the chapter list.`,
            { cause: cause instanceof Error ? cause.message : String(cause) },
          ),
      );
      // Persist so a later offline visit can still load them.
      if (panelRow) {
        for (const c of chapters) {
          // The chapters table is unique on (source, source_id) — the id
          // must be the CHAPTER's native id ("slug~token"), not the panel's.
          // Using the panel id collapsed every chapter onto one row.
          const parsed = parseGlobalId(c.id);
          await this.panelCache
            .upsertChapter(panelRow.id, {
              source: c.source,
              sourceId: parsed?.nativeId ?? nativeId,
              globalId: c.id,
              title: c.title,
              chapterNumber: c.chapterNumber,
              sourceUrl: c.sourceUrl,
              publishedAt: c.publishedAt ? new Date(c.publishedAt) : null,
            })
            .catch(() => {
              /* persistence is best-effort */
            });
        }
      }
      return chapters;
    });
  }

  getChapterPages(globalChapterId: string): Promise<ChapterPages> {
    return this.cached(`pages:${globalChapterId}`, this.cacheConfig.pagesMs, async () => {
      const { source, nativeId } = this.registry.forGlobalId(globalChapterId);
      const panelGlobalId = globalChapterId.slice(0, globalChapterId.lastIndexOf('~'));
      const panelRow = panelGlobalId
        ? await this.panelCache.findPanelByGlobalId(panelGlobalId)
        : undefined;
      const pages = await this.withOfflineFallback(
        async () => {
          const cached = await this.panelCache.findChapterPagesByChapterGlobalId(
            globalChapterId,
          );
          return cached ? toApiChapterPages(cached, globalChapterId) : undefined;
        },
        () => source.getChapterPages(nativeId),
        (cause) =>
          new AppError(
            ErrorCodes.SOURCE_UNAVAILABLE,
            `Could not reach source "${source.name}" to fetch chapter pages.`,
            { cause: cause instanceof Error ? cause.message : String(cause) },
          ),
      );
      // Persist so a later offline visit renders the same pages. The
      // chapter row must exist first — chapter_pages FKs to it.
      if (panelRow) {
        await this.panelCache
          .upsertChapter(panelRow.id, {
            source: source.name,
            sourceId: nativeId,
            globalId: globalChapterId,
            title: pages.chapterTitle ?? '',
            sourceUrl: '',
          })
          .catch(() => {
            /* persistence is best-effort */
          });
        const chapterRow = await this.panelCache.findChapterByGlobalId(globalChapterId);
        if (chapterRow) {
          await this.panelCache
            .upsertChapterPages(
              chapterRow.id,
              panelRow.id,
              pages.pages,
              pages.coverUrl,
              pages.panelTitle,
              pages.chapterTitle,
              pages.prevChapterId,
              pages.nextChapterId,
            )
            .catch(() => {
              /* persistence is best-effort */
            });
        }
      }
      return pages;
    });
  }

  /**
   * Full genre catalog for one source's filter dropdowns. Sources without a
   * genre index (no `getGenreList`) resolve to [] and the UI falls back to
   * the genres seen on the current result page. Catalogs change rarely, so
   * they are cached for a day; a failing source yields [] instead of an
   * error so the filters keep working with page-derived genres.
   */
  getGenreList(sourceName: string): Promise<string[]> {
    return this.cached(`genres:${sourceName}`, GENRE_LIST_TTL_MS, async () => {
      const source = this.registry.get(sourceName);
      if (!source.getGenreList) return [];
      try {
        // Catalogs inherit the sites' mess (case variants, trailing
        // commas) — normalize centrally so every source's dropdown is
        // clean regardless of how careful its parser is.
        return dedupeGenreLabels(await source.getGenreList());
      } catch {
        return [];
      }
    });
  }

  /**
   * Resolve a pasted source url (e.g. "https://hiperdex.com/manga/<slug>")
   * to a global panel id by asking each enabled adapter whether the url
   * belongs to it. Pure computation — nothing to cache.
   */
  resolveUrl(rawUrl: string): { panelId: string; source: string } {
    for (const source of this.registry.list()) {
      if (!source.enabled || !source.nativePanelIdFromUrl) continue;
      const nativeId = source.nativePanelIdFromUrl(rawUrl);
      if (nativeId) {
        return { panelId: toGlobalId(source.name, nativeId), source: source.name };
      }
    }
    throw new AppError(
      ErrorCodes.PANEL_NOT_FOUND,
      'That link does not belong to any supported panel source.',
    );
  }

  /** Chapter metadata resolved via the (cached) chapter list of its panel. */
  async getChapter(globalChapterId: string): Promise<Chapter> {
    const panelGlobalId = globalChapterId.slice(0, globalChapterId.lastIndexOf('~'));
    if (!panelGlobalId || panelGlobalId === globalChapterId) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed chapter id.', {
        id: globalChapterId,
      });
    }
    const chapters = await this.getChapters(panelGlobalId);
    const chapter = chapters.find((c) => c.id === globalChapterId);
    if (!chapter) {
      throw new AppError(ErrorCodes.CHAPTER_NOT_FOUND, 'The requested chapter could not be found.');
    }
    return chapter;
  }
}

/** Map a cached `panel` row back to the API's `Panel` shape. */
function toApiPanel(row: PanelRow | undefined): Panel | undefined {
  if (!row) return undefined;
  return {
    id: row.globalId,
    source: row.source,
    title: row.title,
    coverUrl: row.coverUrl,
    sourceUrl: row.sourceUrl,
    status: (row.status as Panel['status']) ?? 'unknown',
    genres: (row.genres ?? []).map((g) => cleanGenreLabel(g)).filter(Boolean),
    summary: row.description ?? null,
    latestChapter: null,
    updatedAt: null,
    altTitles: row.altTitles,
    authors: row.authors,
    artists: row.artists,
    description: row.description,
  };
}

/** Map cached `chapters` rows back to the API's `Chapter` shape. */
function toApiChapters(rows: ChapterRow[]): Chapter[] {
  return rows.map((c) => ({
    id: c.globalId,
    panelId: c.panelId,
    source: c.source,
    title: c.title,
    chapterNumber: c.chapterNumber,
    sourceUrl: c.sourceUrl,
    publishedAt: c.publishedAt ? c.publishedAt.toISOString() : null,
  }));
}

/** Map a persisted `chapter_pages` row back to the API's `ChapterPages` shape. */
function toApiChapterPages(
  row: {
    chapterId: string;
    panelId: string;
    pages: PanelPage[];
    coverUrl: string | null;
    panelTitle: string | null;
    chapterTitle: string | null;
    prevChapterId: string | null;
    nextChapterId: string | null;
  },
  globalChapterId: string,
): ChapterPages {
  // Rows persisted before adapters tagged their pages with a source prefix
  // would lose the image-proxy rewrite client-side — backfill from the
  // global chapter id ("<source>:<nativeId>~<token>").
  const sourcePrefix = globalChapterId.includes(':') ? globalChapterId.split(':')[0] : null;
  // The DB row stores INTERNAL uuids — never leak those. Every consumer
  // (reader exit-navigation, useChapters/useProgress, progress + bookmark
  // writes, and the prefetch/reader image-cache tags) expects GLOBAL ids.
  // Returning uuids here used to break "back to details" offline (the
  // reader navigated to /panel/<uuid>, which fails global-id validation)
  // and split the image-cache tag between worker and reader.
  const tilde = globalChapterId.lastIndexOf('~');
  const panelGlobalId = tilde > 0 ? globalChapterId.slice(0, tilde) : null;
  return {
    chapterId: globalChapterId,
    panelId: panelGlobalId ?? row.panelId,
    panelTitle: row.panelTitle,
    chapterTitle: row.chapterTitle,
    coverUrl: row.coverUrl,
    pages: row.pages.map((page) =>
      page.source || !sourcePrefix ? page : { ...page, source: sourcePrefix },
    ),
    prevChapterId: row.prevChapterId,
    nextChapterId: row.nextChapterId,
  };
}
