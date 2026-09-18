import {
  and,
  desc,
  eq,
  inArray,
  sql,
} from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  bookmarkFolderItems,
  bookmarkFolders,
  bookmarks,
  chapters,
  panel,
  panelRatings,
  panelTags,
  readingProgress,
  tags,
  type BookmarkFolderItemRow,
  type BookmarkFolderRow,
  type BookmarkRow,
  type ChapterRow,
  type PanelRatingRow,
  type PanelRow,
  type TagRow,
} from '../db/schema.js';

/** Bookmark row joined with everything the UI needs to render it. */
export interface BookmarkWithDetails {
  bookmark: BookmarkRow;
  panel: PanelRow;
  progress: {
    chapterId: string;
    chapterGlobalId: string;
    chapterTitle: string;
    page: number;
    updatedAt: Date;
  } | null;
}

/** Latest progress per panel, resolved to the chapter's global id + title. */
export interface LatestProgress {
  panelId: string;
  chapterId: string;
  chapterTitle: string;
  page: number;
  updatedAt: Date;
}

export class BookmarkRepository {
  constructor(private readonly db: Database) {}

  /**
   * Latest progress row per panel (DISTINCT ON is Postgres-specific),
   * shared by the flat list and the folder-contents batch lookup below.
   */
  private latestProgressCte() {
    return this.db.$with('latest_progress').as(
      this.db
        .selectDistinctOn([readingProgress.panelId], {
          panelId: readingProgress.panelId,
          chapterId: readingProgress.chapterId,
          page: readingProgress.page,
          updatedAt: readingProgress.updatedAt,
        })
        .from(readingProgress)
        .orderBy(readingProgress.panelId, desc(readingProgress.updatedAt)),
    );
  }

  async listWithDetails(): Promise<BookmarkWithDetails[]> {
    const latest = this.latestProgressCte();

    const rows = await this.db
      .with(latest)
      .select({
        bookmark: bookmarks,
        panel: panel,
        progressChapterRowId: latest.chapterId,
        progressPage: latest.page,
        progressUpdatedAt: latest.updatedAt,
        chapterGlobalId: chapters.globalId,
        chapterTitle: chapters.title,
      })
      .from(bookmarks)
      .innerJoin(panel, eq(bookmarks.panelId, panel.id))
      .leftJoin(latest, eq(latest.panelId, panel.id))
      .leftJoin(chapters, eq(chapters.id, latest.chapterId))
      .orderBy(desc(bookmarks.updatedAt));

    return rows.map((row) => ({
      bookmark: row.bookmark,
      panel: row.panel,
      progress:
        row.progressChapterRowId && row.chapterGlobalId && row.chapterTitle
          ? {
              chapterId: row.chapterGlobalId,
              chapterGlobalId: row.chapterGlobalId,
              chapterTitle: row.chapterTitle,
              page: row.progressPage ?? 0,
              updatedAt: row.progressUpdatedAt ?? new Date(0),
            }
          : null,
    }));
  }

  /**
   * Latest progress for many panel rows at once — one round-trip for the
   * folder-contents view (which can't reuse listWithDetails). Panel without
   * progress, or whose progress chapter left the chapter cache, are absent
   * from the map; callers render those as "Not started yet".
   */
  async latestProgressForPanelRowIds(
    panelRowIds: readonly string[],
  ): Promise<Map<string, LatestProgress>> {
    const map = new Map<string, LatestProgress>();
    if (panelRowIds.length === 0) return map;
    const latest = this.latestProgressCte();
    const rows = await this.db
      .with(latest)
      .select({
        panelId: latest.panelId,
        page: latest.page,
        updatedAt: latest.updatedAt,
        chapterGlobalId: chapters.globalId,
        chapterTitle: chapters.title,
      })
      .from(latest)
      .innerJoin(chapters, eq(chapters.id, latest.chapterId))
      .where(inArray(latest.panelId, [...panelRowIds]));
    for (const row of rows) {
      map.set(row.panelId, {
        panelId: row.panelId,
        chapterId: row.chapterGlobalId,
        chapterTitle: row.chapterTitle,
        page: row.page,
        updatedAt: row.updatedAt,
      });
    }
    return map;
  }

  /**
   * Latest cached chapter per panel row id (for bookmark card footers).
   * Returns `{ title, cachedAt }` so callers can either show the title or
   * sort by recency (the bookmarks page uses both).
   */
  async latestChapterTitles(
    panelRowIds: string[],
  ): Promise<Map<string, { title: string; cachedAt: Date }>> {
    if (panelRowIds.length === 0) return new Map();
    const rows = await this.db
      .selectDistinctOn([chapters.panelId], {
        panelId: chapters.panelId,
        title: chapters.title,
        cachedAt: chapters.cachedAt,
      })
      .from(chapters)
      .where(inArray(chapters.panelId, panelRowIds))
      .orderBy(
        chapters.panelId,
        sql`${chapters.chapterNumber} desc nulls last`,
        desc(chapters.cachedAt),
      );
    return new Map(
      rows.map((row) => [row.panelId, { title: row.title, cachedAt: row.cachedAt }]),
    );
  }

  async findById(id: string): Promise<BookmarkRow | undefined> {
    const [row] = await this.db.select().from(bookmarks).where(eq(bookmarks.id, id)).limit(1);
    return row;
  }

  async findByPanelRowId(panelRowId: string): Promise<BookmarkRow | undefined> {
    const [row] = await this.db
      .select()
      .from(bookmarks)
      .where(eq(bookmarks.panelId, panelRowId))
      .limit(1);
    return row;
  }

  /** Insert; returns the existing row when the panel is already bookmarked. */
  async insert(panelRowId: string): Promise<{ row: BookmarkRow; created: boolean }> {
    const [row] = await this.db
      .insert(bookmarks)
      .values({ panelId: panelRowId })
      .onConflictDoNothing({ target: bookmarks.panelId })
      .returning();

    if (row) return { row, created: true };

    const existing = await this.findByPanelRowId(panelRowId);
    if (!existing) throw new Error('Failed to insert bookmark.');
    return { row: existing, created: false };
  }

  async remove(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(bookmarks)
      .where(eq(bookmarks.id, id))
      .returning({ id: bookmarks.id });
    return deleted.length > 0;
  }

  /** Fetch a bookmark joined with its panel row (folder contents helper). */
  async findWithPanel(id: string): Promise<{ bookmark: BookmarkRow; panel: PanelRow } | undefined> {
    const [row] = await this.db
      .select({ bookmark: bookmarks, panel: panel })
      .from(bookmarks)
      .innerJoin(panel, eq(bookmarks.panelId, panel.id))
      .where(eq(bookmarks.id, id))
      .limit(1);
    return row;
  }
}

/**
 * Bookmark folder repository (T2-8). Folders are a many-to-many grouping
 * of panel bookmarks. The default folder is created lazily and is never
 * deletable — it's the home for every bookmark until the user moves it.
 */
export class BookmarkFolderRepository {
  constructor(private readonly db: Database) {}

  async list(): Promise<BookmarkFolderRow[]> {
    return this.db.select().from(bookmarkFolders).orderBy(bookmarkFolders.name);
  }

  async findByName(name: string): Promise<BookmarkFolderRow | undefined> {
    const [row] = await this.db
      .select()
      .from(bookmarkFolders)
      .where(eq(bookmarkFolders.name, name))
      .limit(1);
    return row;
  }

  async findDefault(): Promise<BookmarkFolderRow | undefined> {
    const [row] = await this.db
      .select()
      .from(bookmarkFolders)
      .where(eq(bookmarkFolders.isDefault, true))
      .limit(1);
    return row;
  }

  async ensureDefault(name = 'All bookmarks'): Promise<BookmarkFolderRow> {
    const existing = await this.findDefault();
    if (existing) return existing;
    const [row] = await this.db
      .insert(bookmarkFolders)
      .values({ name, isDefault: true })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const again = await this.findDefault();
    if (!again) throw new Error('Failed to create default bookmark folder.');
    return again;
  }

  async insert(name: string): Promise<BookmarkFolderRow> {
    const [row] = await this.db
      .insert(bookmarkFolders)
      .values({ name })
      .returning();
    if (!row) throw new Error('Failed to create bookmark folder.');
    return row;
  }

  async update(id: string, name: string): Promise<BookmarkFolderRow | undefined> {
    const [row] = await this.db
      .update(bookmarkFolders)
      .set({ name, updatedAt: new Date() })
      .where(eq(bookmarkFolders.id, id))
      .returning();
    return row;
  }

  async remove(id: string): Promise<boolean> {
    // Default folder is never deletable — guarded by the service too.
    const existing = await this.findById(id);
    if (!existing || existing.isDefault) return false;
    const deleted = await this.db
      .delete(bookmarkFolders)
      .where(eq(bookmarkFolders.id, id))
      .returning({ id: bookmarkFolders.id });
    return deleted.length > 0;
  }

  async findById(id: string): Promise<BookmarkFolderRow | undefined> {
    const [row] = await this.db
      .select()
      .from(bookmarkFolders)
      .where(eq(bookmarkFolders.id, id))
      .limit(1);
    return row;
  }

  async addItem(folderId: string, bookmarkId: string): Promise<{ created: boolean }> {
    const [row] = await this.db
      .insert(bookmarkFolderItems)
      .values({ folderId, bookmarkId })
      .onConflictDoNothing()
      .returning();
    return { created: !!row };
  }

  async removeItem(folderId: string, bookmarkId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(bookmarkFolderItems)
      .where(
        and(
          eq(bookmarkFolderItems.folderId, folderId),
          eq(bookmarkFolderItems.bookmarkId, bookmarkId),
        ),
      )
      .returning({ id: bookmarkFolderItems.id });
    return deleted.length > 0;
  }

  async listByFolder(folderId: string): Promise<BookmarkFolderItemRow[]> {
    return this.db
      .select()
      .from(bookmarkFolderItems)
      .where(eq(bookmarkFolderItems.folderId, folderId));
  }

  async listByBookmark(bookmarkId: string): Promise<BookmarkFolderItemRow[]> {
    return this.db
      .select()
      .from(bookmarkFolderItems)
      .where(eq(bookmarkFolderItems.bookmarkId, bookmarkId));
  }

  /**
   * Folder memberships for many bookmarks at once. Returns a map from
   * bookmark id → folder id[] so callers can stamp `folderIds` on every
   * row in a single round-trip (used by the bookmark list + folder
   * contents responses so the picker can pre-check the right rows).
   */
  async listFoldersForBookmarks(
    bookmarkIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (bookmarkIds.length === 0) return map;
    const rows = await this.db
      .select({
        bookmarkId: bookmarkFolderItems.bookmarkId,
        folderId: bookmarkFolderItems.folderId,
      })
      .from(bookmarkFolderItems)
      .where(inArray(bookmarkFolderItems.bookmarkId, [...bookmarkIds]));
    for (const row of rows) {
      const list = map.get(row.bookmarkId);
      if (list) list.push(row.folderId);
      else map.set(row.bookmarkId, [row.folderId]);
    }
    return map;
  }
}

/**
 * Star-rating repository (T3-3). One row per panel — upsert semantics.
 */
export class PanelRatingRepository {
  constructor(private readonly db: Database) {}

  async getByPanelRowId(panelRowId: string): Promise<PanelRatingRow | undefined> {
    const [row] = await this.db
      .select()
      .from(panelRatings)
      .where(eq(panelRatings.panelId, panelRowId))
      .limit(1);
    return row;
  }

  async upsert(panelRowId: string, rating: number): Promise<PanelRatingRow> {
    const [row] = await this.db
      .insert(panelRatings)
      .values({ panelId: panelRowId, rating })
      .onConflictDoUpdate({
        target: panelRatings.panelId,
        set: { rating, updatedAt: new Date() },
      })
      .returning();
    if (!row) throw new Error('Failed to upsert rating.');
    return row;
  }

  async remove(panelRowId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(panelRatings)
      .where(eq(panelRatings.panelId, panelRowId))
      .returning({ id: panelRatings.id });
    return deleted.length > 0;
  }
}

/**
 * Custom-tag repository (T3-4). Tags are created on demand and matched
 * case-insensitively (stored lowercase).
 */
export class TagRepository {
  constructor(private readonly db: Database) {}

  async list(): Promise<TagRow[]> {
    return this.db.select().from(tags).orderBy(tags.name);
  }

  async findByName(name: string): Promise<TagRow | undefined> {
    const [row] = await this.db.select().from(tags).where(eq(tags.name, name)).limit(1);
    return row;
  }

  /** Idempotent insert by name. */
  async ensure(name: string): Promise<TagRow> {
    const existing = await this.findByName(name);
    if (existing) return existing;
    const [row] = await this.db
      .insert(tags)
      .values({ name })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const again = await this.findByName(name);
    if (!again) throw new Error('Failed to create tag.');
    return again;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(tags)
      .where(eq(tags.id, id))
      .returning({ id: tags.id });
    return deleted.length > 0;
  }

  async listByPanelRowId(panelRowId: string): Promise<TagRow[]> {
    return this.db
      .select({ id: tags.id, name: tags.name, createdAt: tags.createdAt })
      .from(panelTags)
      .innerJoin(tags, eq(panelTags.tagId, tags.id))
      .where(eq(panelTags.panelId, panelRowId))
      .orderBy(tags.name);
  }

  /** Tag → panel row ids, for the "tags with panel" listing. */
  async listPanelRowIdsByTag(): Promise<Array<{ tagId: string; panelId: string }>> {
    return this.db
      .select({ tagId: panelTags.tagId, panelId: panelTags.panelId })
      .from(panelTags);
  }

  /** Replace a panel's tag set with the given tag row ids. */
  async setPanelTags(panelRowId: string, tagRowIds: string[]): Promise<void> {
    await this.db.delete(panelTags).where(eq(panelTags.panelId, panelRowId));
    if (tagRowIds.length === 0) return;
    await this.db
      .insert(panelTags)
      .values(tagRowIds.map((tagId) => ({ panelId: panelRowId, tagId })))
      .onConflictDoNothing();
  }

  /** Orphan cleanup: delete tags no longer applied to any panel. */
  async pruneOrphans(): Promise<number> {
    const all = await this.db.select({ id: tags.id }).from(tags);
    if (all.length === 0) return 0;
    const used = await this.db
      .select({ tagId: panelTags.tagId })
      .from(panelTags)
      .where(
        inArray(
          panelTags.tagId,
          all.map((t) => t.id),
        ),
      );
    const usedIds = new Set(used.map((u) => u.tagId));
    const orphans = all.filter((t) => !usedIds.has(t.id)).map((t) => t.id);
    if (orphans.length === 0) return 0;
    const deleted = await this.db
      .delete(tags)
      .where(inArray(tags.id, orphans))
      .returning({ id: tags.id });
    return deleted.length;
  }
}

export type { ChapterRow };
