import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { PanelPage, SourceSearchResult } from '@panel/shared';
import { parseGlobalId, splitNativeChapterId } from '@panel/shared';
import { chapters, chapterPages, listCache, panel, type ChapterRow, type PanelRow, type ListCacheRow } from '../db/schema.js';

/**
 * Repository for the panel/chapter metadata cache. Source payloads are
 * upserted here so bookmarks and reading progress keep working even when
 * the external source is unreachable.
 */

export interface UpsertPanelData {
  source: string;
  sourceId: string;
  globalId: string;
  title: string;
  altTitles?: string[];
  description?: string | null;
  authors?: string[];
  artists?: string[];
  genres?: string[];
  status?: string;
  coverUrl?: string | null;
  sourceUrl: string;
}

export interface UpsertChapterData {
  source: string;
  sourceId: string;
  globalId: string;
  title: string;
  chapterNumber?: number | null;
  sourceUrl: string;
  publishedAt?: Date | null;
}

/**
 * Where an image-cache provenance tag belongs on disk: its panel, plus the
 * chapter display label for chapter tags. Produced read-only from existing
 * metadata rows — never written by the cache.
 */
export interface CacheFolderTarget {
  panelGlobalId: string;
  title: string;
  source: string;
  chapterNumber: number | null;
  chapterTitle: string | null;
  isChapter: boolean;
}

export class PanelCacheRepository {
  constructor(private readonly db: Database) {}

  async upsertPanel(data: UpsertPanelData): Promise<PanelRow> {
    // Null-cover guard: a refresh payload with a missing/empty cover must not
    // wipe the stored cover. Read the existing row first so falsy incoming
    // fields fall back to stored values; inserts (no existing row) keep the
    // previous defaults.
    const existing = await this.findPanelByGlobalId(data.globalId);
    const coverUrl = data.coverUrl?.trim() ? data.coverUrl : (existing?.coverUrl ?? null);
    const title = data.title?.trim() ? data.title : (existing?.title ?? data.title);
    const sourceUrl = data.sourceUrl?.trim() ? data.sourceUrl : (existing?.sourceUrl ?? data.sourceUrl);
    const status = data.status?.trim() ? data.status : (existing?.status ?? 'unknown');
    const genres = data.genres?.length ? data.genres : (existing?.genres ?? []);
    const description = data.description !== undefined ? data.description : (existing?.description ?? null);
    const [row] = await this.db
      .insert(panel)
      .values({
        source: data.source,
        sourceId: data.sourceId,
        globalId: data.globalId,
        title,
        altTitles: data.altTitles ?? [],
        description,
        authors: data.authors ?? [],
        artists: data.artists ?? [],
        genres,
        status,
        coverUrl,
        sourceUrl,
        cachedAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [panel.source, panel.sourceId],
        set: {
          title,
          description,
          coverUrl,
          sourceUrl,
          status,
          genres,
          cachedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error('Failed to upsert panel row.');
    return row;
  }

  async upsertChapter(panelRowId: string, data: UpsertChapterData): Promise<ChapterRow> {
    return this.upsertChapterWith(this.db, panelRowId, data);
  }

  /**
   * Bulk chapter persist in ONE transaction (one commit instead of N).
   * Used by the detail background writer so a 500-chapter list doesn't pay
   * 1000 sequential round-trips + commits on (or behind) the request path.
   * Best-effort like the single-row form — callers swallow errors.
   */
  async upsertChapters(panelRowId: string, items: readonly UpsertChapterData[]): Promise<void> {
    if (items.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const data of items) {
        await this.upsertChapterWith(tx, panelRowId, data);
      }
    });
  }

  private async upsertChapterWith(
    db: Database | Parameters<Parameters<Database['transaction']>[0]>[0],
    panelRowId: string,
    data: UpsertChapterData,
  ): Promise<ChapterRow> {
    // Resolve by globalId first. Rows written by an older bug may carry a
    // stale sourceId under this globalId; updating them here corrects that
    // and avoids tripping the unique index on insert.
    const [byGlobalId] = await db
      .select()
      .from(chapters)
      .where(eq(chapters.globalId, data.globalId))
      .limit(1);
    if (byGlobalId) {
      // Never clobber a good cached URL with an empty bookmark fallback —
      // the reader bookmarks before the chapter list loads and sends ''.
      const sourceUrl = data.sourceUrl || byGlobalId.sourceUrl;
      const [row] = await db
        .update(chapters)
        .set({
          sourceId: data.sourceId,
          title: data.title,
          chapterNumber: data.chapterNumber ?? null,
          sourceUrl,
          cachedAt: new Date(),
        })
        .where(eq(chapters.id, byGlobalId.id))
        .returning();
      if (!row) throw new Error('Failed to update chapter row.');
      return row;
    }

    let insertSourceUrl = data.sourceUrl;
    if (!insertSourceUrl) {
      const [bySourceId] = await db
        .select({ sourceUrl: chapters.sourceUrl })
        .from(chapters)
        .where(and(eq(chapters.source, data.source), eq(chapters.sourceId, data.sourceId)))
        .limit(1);
      if (bySourceId?.sourceUrl) insertSourceUrl = bySourceId.sourceUrl;
    }

    const [row] = await db
      .insert(chapters)
      .values({
        panelId: panelRowId,
        source: data.source,
        sourceId: data.sourceId,
        globalId: data.globalId,
        title: data.title,
        chapterNumber: data.chapterNumber ?? null,
        sourceUrl: insertSourceUrl,
        publishedAt: data.publishedAt ?? null,
        cachedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [chapters.source, chapters.sourceId],
        set: {
          title: data.title,
          chapterNumber: data.chapterNumber ?? null,
          sourceUrl: insertSourceUrl,
          cachedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error('Failed to upsert chapter row.');
    return row;
  }

  async findPanelByGlobalId(globalId: string): Promise<PanelRow | undefined> {
    const [row] = await this.db.select().from(panel).where(eq(panel.globalId, globalId)).limit(1);
    return row;
  }

  /**
   * Bulk genre lookup for listing enrichment: global panel id → cached
   * genres, one query. Panels with no cached genres are absent (the caller
   * fetches those). Panels never seen have no row and are absent too.
   */
  async findGenresByGlobalIds(globalIds: readonly string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (globalIds.length === 0) return map;
    const rows = await this.db
      .select({ globalId: panel.globalId, genres: panel.genres })
      .from(panel)
      .where(inArray(panel.globalId, [...globalIds]));
    for (const row of rows) {
      if (row.genres.length > 0) map.set(row.globalId, [...row.genres]);
    }
    return map;
  }

  /**
   * Attribute an image-cache provenance tag to its panel (for per-panel
   * cache folders). Cover tags are panel ids already; chapter tags
   * (`<panel>~<token>`) resolve through the chapter's panel row.
   * Returns null when the tag is malformed or has no panel row — the
   * caller then writes flat in the cache root as before.
   */
  async resolveTagToPanel(
    tag: string,
  ): Promise<{ panelGlobalId: string; title: string; source: string } | null> {
    const target = await this.resolveTagToCacheTarget(tag);
    if (!target) return null;
    return { panelGlobalId: target.panelGlobalId, title: target.title, source: target.source };
  }

  /**
   * Target folders for an image-cache provenance tag: the panel it belongs
   * to, plus — for chapter tags — the chapter's display label (number/title)
   * for its subfolder.
   *
   * Strictly read-only: it looks at the existing panel/chapter metadata rows
   * and nothing else. The image cache never stores metadata in the database;
   * folder names are derived from rows that the source sync already wrote.
   * Returns null when the tag is malformed or has no panel row — the caller
   * then writes flat in the cache root as before. A chapter tag whose panel
   * exists but whose chapter row is missing still resolves (with null
   * chapter fields) so its files at least land in the panel folder.
   */
  async resolveTagToCacheTarget(tag: string): Promise<CacheFolderTarget | null> {
    const parsed = parseGlobalId(tag);
    if (!parsed) return null;
    const split = splitNativeChapterId(parsed.nativeId);
    const panelGlobalId = split ? `${parsed.source}:${split.panelId}` : tag;
    const row = await this.findPanelByGlobalId(panelGlobalId);
    if (!row) return null;
    if (!split) {
      return {
        panelGlobalId: row.globalId,
        title: row.title,
        source: row.source,
        chapterNumber: null,
        chapterTitle: null,
        isChapter: false,
      };
    }
    const [chapterRow] = await this.db
      .select({ title: chapters.title, chapterNumber: chapters.chapterNumber })
      .from(chapters)
      .where(eq(chapters.globalId, tag))
      .limit(1);
    return {
      panelGlobalId: row.globalId,
      title: row.title,
      source: row.source,
      chapterNumber: chapterRow?.chapterNumber ?? null,
      chapterTitle: chapterRow?.title ?? null,
      isChapter: true,
    };
  }

  /** Look up a panel row by its internal uuid (handy when joining from a
      repository that stores row ids, e.g. the bookmark folder items table). */
  async findPanelByRowId(panelRowId: string): Promise<PanelRow | undefined> {
    const [row] = await this.db.select().from(panel).where(eq(panel.id, panelRowId)).limit(1);
    return row;
  }

  async findChapterByGlobalId(globalId: string): Promise<ChapterRow | undefined> {    const [row] = await this.db
      .select()
      .from(chapters)
      .where(eq(chapters.globalId, globalId))
      .limit(1);
    return row;
  }

  /** Look up a chapter row by its internal uuid (handy when joining from a
      repository that stores row ids, e.g. reading_progress). Mirrors
      `findPanelByRowId` above. */
  async findChapterByRowId(chapterRowId: string): Promise<ChapterRow | undefined> {
    const [row] = await this.db.select().from(chapters).where(eq(chapters.id, chapterRowId)).limit(1);
    return row;
  }

  async findChaptersByPanel(globalPanelId: string): Promise<{
    panelRow: PanelRow;
    rows: ChapterRow[];
  } | undefined> {
    const panelRow = await this.findPanelByGlobalId(globalPanelId);
    if (!panelRow) return undefined;
    const rows = await this.db.select().from(chapters).where(eq(chapters.panelId, panelRow.id));
    return { panelRow, rows };
  }

  /**
   * Map every cached chapter global id to the global id of the panel it
   * belongs to. Chapter pages are tagged with the *chapter* id (so they can
   * be cleared per-chapter), but the cache-settings "Your panel" total needs
   * the *panel* id — the two are different strings with different tag hashes,
   * so the per-panel size query has to resolve chapters → panel here.
   *
   * Best-effort: chapters whose panel row is missing (source never fetched)
   * are simply absent from the map, same as a chapter with no cached pages.
   */
  async findPanelGlobalIdByChapterGlobalIds(
    chapterGlobalIds: readonly string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (chapterGlobalIds.length === 0) return map;
    const rows = await this.db
      .select({ chapterId: chapters.globalId, panelId: panel.globalId })
      .from(chapters)
      .innerJoin(panel, eq(chapters.panelId, panel.id))
      .where(inArray(chapters.globalId, chapterGlobalIds));
    for (const row of rows) map.set(row.chapterId, row.panelId);
    return map;
  }

  /**
   * Map every panel global id to the global ids of its cached chapter rows.
   * Used by the cache-settings size query to attribute on-disk chapter files
   * to their panel even when the client didn't send those chapter ids (e.g.
   * chapters opened in a previous session) — the chapter files are hashed by
   * chapter id, so without the id list they can't be matched to any panel.
   *
   * Best-effort like its inverse above: panels/rows that were never cached
   * are simply absent from the map.
   */
  async findChapterGlobalIdsByPanelGlobalIds(
    panelGlobalIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (panelGlobalIds.length === 0) return map;
    const rows = await this.db
      .select({ chapterId: chapters.globalId, panelId: panel.globalId })
      .from(chapters)
      .innerJoin(panel, eq(chapters.panelId, panel.id))
      .where(inArray(panel.globalId, panelGlobalIds));
    for (const row of rows) {
      const list = map.get(row.panelId) ?? [];
      list.push(row.chapterId);
      map.set(row.panelId, list);
    }
    return map;
  }

  async upsertChapterPages(
    chapterId: string,
    panelId: string,
    pages: PanelPage[],
    coverUrl: string | null,
    panelTitle: string | null,
    chapterTitle: string | null,
    prevChapterId: string | null,
    nextChapterId: string | null,
  ): Promise<void> {
    await this.db
      .insert(chapterPages)
      .values({
        chapterId,
        panelId,
        pages,
        coverUrl,
        panelTitle,
        chapterTitle,
        prevChapterId,
        nextChapterId,
      })
      .onConflictDoUpdate({
        target: chapterPages.chapterId,
        set: {
          pages,
          coverUrl,
          panelTitle,
          chapterTitle,
          prevChapterId,
          nextChapterId,
          cachedAt: new Date(),
        },
      });
  }

  async findChapterPagesByChapterGlobalId(globalChapterId: string) {
    const chapterRow = await this.findChapterByGlobalId(globalChapterId);
    if (!chapterRow) return undefined;
    const [row] = await this.db
      .select()
      .from(chapterPages)
      .where(eq(chapterPages.chapterId, chapterRow.id))
      .limit(1);
    return row;
  }

  async upsertList(
    kind: 'search' | 'latest',
    key: string,
    source: string,
    page: number,
    results: SourceSearchResult['results'],
    hasMore: boolean,
  ): Promise<void> {
    await this.db
      .insert(listCache)
      .values({ kind, key, source, page, results, hasMore })
      .onConflictDoUpdate({
        target: [listCache.kind, listCache.key, listCache.source, listCache.page],
        set: { results, hasMore },
      });
  }

  async findList(
    kind: 'search' | 'latest',
    key: string,
    source: string,
    page: number,
  ): Promise<ListCacheRow | undefined> {
    const [row] = await this.db
      .select()
      .from(listCache)
      .where(
        eq(listCache.kind, kind) &&
          eq(listCache.key, key) &&
          eq(listCache.source, source) &&
          eq(listCache.page, page),
      )
      .limit(1);
    return row;
  }
}
