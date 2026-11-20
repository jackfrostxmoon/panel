import {
  ErrorCodes,
  parseGlobalId,
  toGlobalId,
  type Chapter,
  type ChapterPages,
  type CreditKind,
  type Panel,
  type PanelPage,
  type PanelSource,
  type PanelSummary,
  type SourceSearchResult,
} from '@panel/shared';
import type { CacheConfig } from '../config.js';
import type { PanelCacheRepository } from '../repositories/panelCacheRepository.js';
import type { PanelRow, ChapterRow } from '../db/schema.js';
import { InFlight, TtlCache } from '../lib/cache.js';
import { AppError } from '../lib/errors.js';
import { recordSourceCacheHit, recordSourceCacheMiss } from '../lib/stats.js';
import { isChapterImageLikeCover, safeCoverUrl } from '../lib/coverGuard.js';
import { cleanGenreLabel, dedupeGenreLabels } from '../lib/text.js';
import type { SourceRegistry } from '../sources/registry.js';

/** Genre catalogs change rarely — one fetch per source per day is plenty. */
const GENRE_LIST_TTL_MS = 24 * 60 * 60_000;
/**
 * Empty genre catalogs are almost always an outage (origin 5xx, challenge
 * page, changed markup) — not a source with no genres. Caching [] for a
 * full day poisons the filter dropdown long after the source recovers, so
 * empties get a short TTL and the next request revalidates live.
 */
const GENRE_LIST_EMPTY_TTL_MS = 60_000;

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
 * AND include enforcement for listings whose cards carry genre labels.
 * Positive-evidence only, mirroring the exclude filter: an item is dropped
 * only when its (cleaned) genres are known and do NOT contain every
 * requested label. Genre-less items are kept — "unknown" is not "doesn't
 * match" — so adapters that already verified membership server-side
 * (native AND or archive intersection) keep their results even when the
 * metadata cache has no enrichment entry.
 */
function applyIncludedGenres<T extends { genres: string[] }>(
  results: T[],
  includedGenres: readonly string[] | null,
  matchAll: boolean,
): T[] {
  const lowered = (includedGenres ?? [])
    .map((genre) => genre.trim().toLowerCase())
    .filter(Boolean);
  if (lowered.length === 0 || !matchAll) return results;
  return results.filter((item) => {
    if (item.genres.length === 0) return true;
    const have = new Set(item.genres.map((genre) => genre.toLowerCase()));
    return lowered.every((genre) => have.has(genre));
  });
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
 * Performance-mode profile for the in-memory source-response cache.
 * Widens the budgets the low-memory defaults (`CACHE_MAX_ENTRIES=100`,
 * `CACHE_MAX_BYTES=32MiB`) deliberately constrain, and stretches TTLs so
 * hot listings survive longer without an upstream re-fetch — maximum
 * throughput at the cost of higher heap. Applied at runtime via
 * `setPerformanceMode` (no restart); reverted the same way.
 */
export const PERF_CACHE_MAX_ENTRIES = 1000;
export const PERF_CACHE_MAX_BYTES = 256 * 1024 * 1024;
/** Multiplier applied to every cache TTL while performance mode is on. */
export const PERF_TTL_MULTIPLIER = 4;

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
  /**
   * Performance-mode flag (toggled at runtime from the cache-settings
   * page). While on, the cache budgets widen to the PERF_* constants and
   * every TTL is stretched by PERF_TTL_MULTIPLIER — maximum throughput at
   * the cost of higher heap. The manual flush (`clearCache`, memory-flush
   * button) still works while on; only the automatic relief timer stands
   * down (see index.ts).
   */
  private performanceMode = false;

  constructor(
    private readonly registry: SourceRegistry,
    private readonly cacheConfig: CacheConfig,
    private readonly panelCache: PanelCacheRepository,
  ) {
    // Bounded by count AND bytes so a long browse can't pin hundreds of MB
    // of listing/page payloads in heap (see CACHE_MAX_ENTRIES/BYTES).
    this.cache = new TtlCache<unknown>(
      Math.max(16, Math.floor(cacheConfig.maxEntries)),
      Math.max(1024 * 1024, Math.floor(cacheConfig.maxBytes)),
    );
  }

  /** Runtime performance-mode switch — no restart needed. */
  setPerformanceMode(on: boolean): void {
    this.performanceMode = on;
    if (on) {
      this.cache.resize(PERF_CACHE_MAX_ENTRIES, PERF_CACHE_MAX_BYTES);
    } else {
      this.cache.resize(
        Math.max(16, Math.floor(this.cacheConfig.maxEntries)),
        Math.max(1024 * 1024, Math.floor(this.cacheConfig.maxBytes)),
      );
    }
  }

  /** Whether the max-throughput profile is currently applied. */
  isPerformanceMode(): boolean {
    return this.performanceMode;
  }

  /** TTL for a fresh cache write — stretched while performance mode is on. */
  private ttlFor(baseMs: number): number {
    return this.performanceMode ? baseMs * PERF_TTL_MULTIPLIER : baseMs;
  }

  /** Flush the in-memory TTL cache, drop in-flight dedup state, and trigger GC. */
  clearCache(): void {
    this.cache.clear();
    this.inFlight.clear();
    if (typeof (globalThis as { Bun?: { gc?: () => void } }).Bun?.gc === 'function') {
      (globalThis as { Bun: { gc: () => void } }).Bun.gc();
    }
  }

  /** Rough heap size of a cache value (JSON length — cheap, miss path only). */
  private static sizeOf(value: unknown): number {
    try {
      const text = JSON.stringify(value);
      return text ? text.length : 0;
    } catch {
      return 0;
    }
  }

  private async cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      recordSourceCacheHit();
      return hit as T;
    }
    recordSourceCacheMiss();
    // Performance mode stretches every TTL so hot entries survive longer
    // without an upstream re-fetch (fewer source hits = faster revisits).
    const effectiveTtlMs = this.ttlFor(ttlMs);
    return (await this.inFlight.dedupe(key, async () => {
      const value = await loader();
      this.cache.set(key, value, effectiveTtlMs, PanelService.sizeOf(value));
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
    mode?: 'title' | CreditKind,
  ): Promise<SourceSearchResult> {
    const toQuery = this.resolveSources(sources);
    const filter = sources && sources.length > 0 ? sources.join(',') : '*';
    const baseKey = query.trim().toLowerCase();
    // Genre constraints get their own cache + persistence keys so a
    // filtered search can never be served as (or overwrite) the unfiltered
    // one. Unfiltered calls keep the historic key (existing caches stay).
    const g = normalizeGenreLabels(genres);
    const x = normalizeGenreLabels(excludedGenres);
    if (mode === 'author' || mode === 'artist') {
      // Credit search: mode-scoped key so it can never be served as (or
      // overwrite) a title search or the other credit mode.
      const key = g || x ? `${baseKey}:genre:${genreKeyFragment(g)}:excluded:${genreKeyFragment(x)}` : baseKey;
      return this.searchByCredit(mode, query, page, toQuery, filter, key, x);
    }
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
              coverUrl: safeCoverUrl(r.coverUrl),
              genres: (r.genres ?? []).map((g) => cleanGenreLabel(g)).filter(Boolean),
            })),
            x,
          ),
          // An empty upstream page must never claim more pages (paginator
          // chrome on empty pages kept infinite scroll fetching forever).
          // Clamped on the pre-filter count so exclude-filtered empties
          // still advance to later pages. General guard for all sources.
          hasMore: result.hasMore && result.results.length > 0,
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

  /**
   * Server-side author/artist search. Sources whose sites can filter by
   * credit do so natively; the local metadata cache is merged in for
   * every source (live results first, deduped by id) so cached matches
   * show even from sites with no credit filter — and everything known
   * anywhere is reachable offline. Page 2+ carries live results only
   * (cached hits live on page 1, so they never repeat while paging).
   *
   * Persisted under a `search:<kind>:`-scoped key, like title search.
   */
  private searchByCredit(
    kind: CreditKind,
    query: string,
    page: number,
    toQuery: PanelSource[],
    filter: string,
    key: string,
    excludedGenres: string[] | null,
  ): Promise<SourceSearchResult> {
    const persistKey = `${kind}:${key}`;
    return this.cached(
      `search:${persistKey}:${page}:${filter}`,
      this.cacheConfig.searchMs,
      async () => {
        // Local matches are collected up front so they are included even
        // when every source fails (the failure path below still surfaces
        // an error when neither live, persisted nor cached data exists).
        const localPromise = this.panelCache
          .searchByCredit(
            kind,
            query,
            toQuery.map((s) => s.name),
          )
          .catch(() => [] as PanelSummary[]);

        const live = async (): Promise<SourceSearchResult> => {
          const capable = toQuery.filter((s) => typeof s.searchByCredit === 'function');
          if (capable.length === 0) return { results: [], page, hasMore: false };
          const settled = await Promise.allSettled(
            capable.map((s) => s.searchByCredit!(kind, query, page)),
          );
          return this.mergeSourceResults(settled, page);
        };

        let liveResult: SourceSearchResult | undefined;
        let liveError: unknown;
        try {
          liveResult = await live();
        } catch (error) {
          liveError = error;
        }

        let base: SourceSearchResult | undefined = liveResult;
        if (base === undefined) {
          const persisted = await this.panelCache
            .findList('search', persistKey, filter, page)
            .catch(() => undefined);
          if (persisted) {
            base = { results: persisted.results, page: persisted.page, hasMore: persisted.hasMore };
          }
        }

        const local = await localPromise;
        // Cached hits only merge into page 1 — later pages would otherwise
        // repeat the same block of cached matches on every page.
        const merged =
          page === 1
            ? mergeCreditResults(base?.results ?? [], local)
            : (base?.results ?? []);

        if (base === undefined && merged.length === 0 && liveError !== undefined) {
          const cause = liveError;
          throw new AppError(
            ErrorCodes.SOURCE_UNAVAILABLE,
            `Could not reach sources to search for "${query}".`,
            { cause: cause instanceof Error ? cause.message : String(cause) },
          );
        }
        if (base === undefined) {
          base = { results: [], page, hasMore: false };
        }

        const cleanedResult: SourceSearchResult = {
          ...base,
          results: applyExcludedGenres(
            merged.map((r) => ({
              ...r,
              coverUrl: safeCoverUrl(r.coverUrl),
              genres: (r.genres ?? []).map((genre) => cleanGenreLabel(genre)).filter(Boolean),
            })),
            excludedGenres,
          ),
          // An empty upstream page must never claim more pages (paginator
          // chrome on empty pages kept infinite scroll fetching forever).
          hasMore: base.hasMore && base.results.length > 0,
        };
        // Persist so a later offline visit shows the same list.
        await this.panelCache
          .upsertList('search', persistKey, filter, page, cleanedResult.results, cleanedResult.hasMore)
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
    matchAllGenres = false,
  ): Promise<SourceSearchResult> {
    const toQuery = this.resolveSources(sources);
    const filter = sources && sources.length > 0 ? sources.join(',') : '*';
    // Genre constraints get their own cache + persistence keys so a
    // filtered list can never be served as (or overwrite) the unfiltered
    // one. The include match mode (AND vs OR) is part of the identity too —
    // the same labels produce different result sets. Unfiltered calls keep
    // the historic key (existing caches stay).
    const g = normalizeGenreLabels(genres);
    const x = normalizeGenreLabels(excludedGenres);
    const modeFragment = g ? `:mode:${matchAllGenres ? 'all' : 'any'}` : '';
    const key = g || x
      ? `page:${page}:genre:${genreKeyFragment(g)}:excluded:${genreKeyFragment(x)}${modeFragment}`
      : `page:${page}`;
    return this.cached(
      `latest:${page}:${filter}:${genreKeyFragment(g)}:${genreKeyFragment(x)}${modeFragment}`,
      this.cacheConfig.searchMs,
      async () => {
        const live = async () => {
          // Genre-capable adapters filter at the source (whole catalog,
          // not just the loaded page); the rest fall back to their plain
          // listing and the UI narrows what it can client-side. Works for
          // one source or many — each source filters its own feed and the
          // pages merge exactly like the unfiltered path.
          const settled = await Promise.allSettled(
            toQuery.map((s) =>
              (g || x) && typeof s.latestByGenre === 'function'
                ? s.latestByGenre(g, x, page, matchAllGenres)
                : s.latest(page),
            ),
          );
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
          results: applyIncludedGenres(
            applyExcludedGenres(
              result.results.map((r) => ({
                ...r,
                coverUrl: safeCoverUrl(r.coverUrl),
                genres: (r.genres ?? []).map((g) => cleanGenreLabel(g)).filter(Boolean),
              })),
              x,
            ),
            g,
            matchAllGenres,
          ),
          // Same empty-page guard as search: no source may claim more
          // pages from zero results.
          hasMore: result.hasMore && result.results.length > 0,
        };
        // An empty live parse on a latest feed is almost always an outage
        // (challenge page, origin 5xx served as 200, changed markup) — never
        // overwrite a good cached row with it. Serve the last good row
        // instead; when nothing good exists return the empty without
        // persisting it so the next request revalidates live.
        if (cleanedResult.results.length === 0) {
          const fallback = await this.panelCache
            .findList('latest', key, filter, page)
            .catch(() => undefined);
          if (fallback && fallback.results.length > 0) {
            return { results: fallback.results, page: fallback.page, hasMore: fallback.hasMore };
          }
          return cleanedResult;
        }
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
      // Fast path: serve the DB row immediately (no source round-trip on
      // the critical path), then refresh from live in the background so
      // the next visit sees fresh metadata.
      const stored = await this.panelCache.findPanelByGlobalId(globalId).catch(() => undefined);
      // Fast path: serve the DB row immediately (no source round-trip on
      // the critical path), then refresh from live in the background so
      // the next visit sees fresh metadata. A stored row whose cover is a
      // chapter page is legacy import damage — it is never served; the
      // live fetch below repairs the row (coverGuard.ts).
      const storedCoverBroken = isChapterImageLikeCover(stored?.coverUrl);
      const fast = toApiPanel(stored);
      if (fast && !storedCoverBroken) {
        void this.refreshPanel(globalId).catch(() => {});
        return fast;
      }
      const panel = await this.withOfflineFallback(
        // Offline resilience is preserved, but a chapter-like cover is
        // withheld (initials fallback) rather than served — see the
        // toApiPanel cover sanitizer.
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
      // Persist so a later offline visit can still load it — best-effort/offline,
      // fire-and-forget so the HTTP response does not wait for the DB write.
      void this.panelCache
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
        .catch(() => {});
      return cleanedPanel;
    });
  }

  /** Live revalidation for the panel fast path — never awaited by requests. */
  private async refreshPanel(globalId: string): Promise<void> {
    const { source, nativeId } = this.registry.forGlobalId(globalId);
    const panel = await source.getPanel(nativeId);
    const cleanedPanel = {
      ...panel,
      genres: panel.genres.map((g) => cleanGenreLabel(g)).filter(Boolean),
    };
    this.cache.set(`panel:${globalId}`, cleanedPanel, this.ttlFor(this.cacheConfig.panelMs), PanelService.sizeOf(cleanedPanel));
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
      .catch(() => {});
  }

  getChapters(globalId: string): Promise<Chapter[]> {
    return this.cached(`chapters:${globalId}`, this.cacheConfig.chaptersMs, async () => {
      const { source, nativeId } = this.registry.forGlobalId(globalId);
      // Fast path: serve cached chapter rows immediately, refresh live behind.
      const stored = await this.panelCache.findChaptersByPanel(globalId).catch(() => undefined);
      if (stored && stored.rows.length > 0) {
        void this.refreshChapters(globalId).catch(() => {});
        return toApiChapters(stored.rows);
      }
      const panelRow = stored?.panelRow ?? (await this.panelCache.findPanelByGlobalId(globalId).catch(() => undefined));
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
      // Persist in background in ONE transaction so detail loads stay fast
      // even while cache clears run — writes do not block the response.
      if (panelRow) {
        void this.panelCache
          .upsertChapters(
            panelRow.id,
            chapters.map((c) => {
              // The chapters table is unique on (source, source_id) — the id
              // must be the CHAPTER's native id ("slug~token"), not the panel's.
              // Using the panel id collapsed every chapter onto one row.
              const parsed = parseGlobalId(c.id);
              return {
                source: c.source,
                sourceId: parsed?.nativeId ?? nativeId,
                globalId: c.id,
                title: c.title,
                chapterNumber: c.chapterNumber,
                sourceUrl: c.sourceUrl,
                publishedAt: c.publishedAt ? new Date(c.publishedAt) : null,
              };
            }),
          )
          .catch(() => {});
      }
      return chapters;
    });
  }

  /** Live revalidation for the chapters fast path — never awaited by requests. */
  private async refreshChapters(globalId: string): Promise<void> {
    const { source, nativeId } = this.registry.forGlobalId(globalId);
    const chapters = await source.getChapters(nativeId);
    this.cache.set(`chapters:${globalId}`, chapters, this.ttlFor(this.cacheConfig.chaptersMs), PanelService.sizeOf(chapters));
    const panelRow = await this.panelCache.findPanelByGlobalId(globalId).catch(() => undefined);
    if (!panelRow) return;
    await this.panelCache
      .upsertChapters(
        panelRow.id,
        chapters.map((c) => {
          const parsed = parseGlobalId(c.id);
          return {
            source: c.source,
            sourceId: parsed?.nativeId ?? nativeId,
            globalId: c.id,
            title: c.title,
            chapterNumber: c.chapterNumber,
            sourceUrl: c.sourceUrl,
            publishedAt: c.publishedAt ? new Date(c.publishedAt) : null,
          };
        }),
      )
      .catch(() => {});
  }

  getChapterPages(globalChapterId: string, opts?: { serverPreference?: string }): Promise<ChapterPages> {
    return this.cached(`pages:${globalChapterId}:${opts?.serverPreference ?? ''}`, this.cacheConfig.pagesMs, async () => {
      const { source, nativeId } = this.registry.forGlobalId(globalChapterId);
      // Fast path: previously-read chapter pages render instantly from DB,
      // with live revalidation behind for URL rotations.
      const storedPages = await this.panelCache
        .findChapterPagesByChapterGlobalId(globalChapterId)
        .catch(() => undefined);
      if (storedPages) {
        void this.refreshChapterPages(globalChapterId).catch(() => {});
        return toApiChapterPages(storedPages, globalChapterId);
      }
      const panelGlobalId = globalChapterId.slice(0, globalChapterId.lastIndexOf('~'));
      const panelRow = panelGlobalId
        ? await this.panelCache.findPanelByGlobalId(panelGlobalId).catch(() => undefined)
        : undefined;
      // The chapter row stores the concrete reader URL — pass it through so
      // sources whose chapters aren't always on the English reader path
      // (e.g. RoliaScan's /fr/ chapters) can fetch the right one.
      const chapterRow = await this.panelCache
        .findChapterByGlobalId(globalChapterId)
        .catch(() => undefined);
      const pages = await this.withOfflineFallback(
        async () => {
          const cached = await this.panelCache.findChapterPagesByChapterGlobalId(
            globalChapterId,
          );
          return cached ? toApiChapterPages(cached, globalChapterId) : undefined;
        },
        () => source.getChapterPages(nativeId, { ...opts, sourceUrl: chapterRow?.sourceUrl }),
        (cause) =>
          new AppError(
            ErrorCodes.SOURCE_UNAVAILABLE,
            `Could not reach source "${source.name}" to fetch chapter pages.`,
            { cause: cause instanceof Error ? cause.message : String(cause) },
          ),
      );
      // Persist so a later offline visit renders the same pages. The
      // chapter row must exist first — chapter_pages FKs to it.
      // Background: the reader must not wait on DB writes.
      if (panelRow) {
        void this.persistChapterPages(panelRow.id, source.name, nativeId, globalChapterId, pages).catch(
          () => {},
        );
      }
      return pages;
    });
  }

  /** Live revalidation for the pages fast path — never awaited by requests. */
  private async refreshChapterPages(globalChapterId: string): Promise<void> {
    const { source, nativeId } = this.registry.forGlobalId(globalChapterId);
    const chapterRow = await this.panelCache
      .findChapterByGlobalId(globalChapterId)
      .catch(() => undefined);
    const pages = await source.getChapterPages(nativeId, { sourceUrl: chapterRow?.sourceUrl });
    this.cache.set(`pages:${globalChapterId}`, pages, this.ttlFor(this.cacheConfig.pagesMs), PanelService.sizeOf(pages));
    const panelGlobalId = globalChapterId.slice(0, globalChapterId.lastIndexOf('~'));
    const panelRow = panelGlobalId
      ? await this.panelCache.findPanelByGlobalId(panelGlobalId).catch(() => undefined)
      : undefined;
    if (!panelRow) return;
    await this.persistChapterPages(panelRow.id, source.name, nativeId, globalChapterId, pages);
  }

  private async persistChapterPages(
    panelRowId: string,
    sourceName: string,
    nativeId: string,
    globalChapterId: string,
    pages: ChapterPages,
  ): Promise<void> {
    await this.panelCache
      .upsertChapter(panelRowId, {
        source: sourceName,
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
          panelRowId,
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

  /**
   * Full genre catalog for one source's filter dropdowns. Sources without a
   * genre index (no `getGenreList`) resolve to [] and the UI falls back to
   * the genres seen on the current result page. Catalogs change rarely, so
   * they are cached for a day; a failing source yields [] instead of an
   * error so the filters keep working with page-derived genres.
   */
  getGenreList(sourceName: string): Promise<string[]> {
    const key = `genres:${sourceName}`;
    return this.cached(key, GENRE_LIST_TTL_MS, async () => {
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
    }).then((result) => {
      // See GENRE_LIST_EMPTY_TTL_MS: revalidate empties quickly so a
      // transient outage doesn't blank the dropdown for a full day.
      if (result.length === 0) this.cache.set(key, result, GENRE_LIST_EMPTY_TTL_MS, PanelService.sizeOf(result));
      return result;
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

/** Union of live and cached credit matches, deduped by global id (live wins). */
function mergeCreditResults(
  live: readonly PanelSummary[],
  cached: readonly PanelSummary[],
): PanelSummary[] {
  const seen = new Set<string>(live.map((r) => r.id));
  const out = [...live];
  for (const item of cached) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** Map a cached `panel` row back to the API's `Panel` shape. */
function toApiPanel(row: PanelRow | undefined): Panel | undefined {
  if (!row) return undefined;
  return {
    id: row.globalId,
    source: row.source,
    title: row.title,
    coverUrl: safeCoverUrl(row.coverUrl),
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
