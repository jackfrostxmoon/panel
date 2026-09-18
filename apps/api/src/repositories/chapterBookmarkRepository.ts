import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  chapterBookmarks,
  chapters,
  type ChapterBookmarkRow,
  type ChapterRow,
} from '../db/schema.js';

/** Chapter bookmark row joined with chapter details. */
export interface ChapterBookmarkWithDetails {
  bookmark: ChapterBookmarkRow;
  chapter: ChapterRow;
}

export class ChapterBookmarkRepository {
  constructor(private readonly db: Database) {}

  async listByPanelId(panelRowId: string): Promise<ChapterBookmarkWithDetails[]> {
    const rows = await this.db
      .select({
        bookmark: chapterBookmarks,
        chapter: chapters,
      })
      .from(chapterBookmarks)
      .innerJoin(chapters, eq(chapterBookmarks.chapterId, chapters.id))
      .where(eq(chapterBookmarks.panelId, panelRowId))
      .orderBy(desc(chapterBookmarks.createdAt));

    return rows.map((row) => ({
      bookmark: row.bookmark,
      chapter: row.chapter,
    }));
  }

  async findByPanelAndChapter(panelRowId: string, chapterRowId: string): Promise<ChapterBookmarkRow | undefined> {
    const [row] = await this.db
      .select()
      .from(chapterBookmarks)
      .where(and(eq(chapterBookmarks.panelId, panelRowId), eq(chapterBookmarks.chapterId, chapterRowId)))
      .limit(1);
    return row;
  }

  /** Insert; returns the existing row when the chapter is already bookmarked. */
  async insert(panelRowId: string, chapterRowId: string): Promise<{ row: ChapterBookmarkRow; created: boolean }> {
    const [row] = await this.db
      .insert(chapterBookmarks)
      .values({ panelId: panelRowId, chapterId: chapterRowId })
      .onConflictDoNothing({ target: [chapterBookmarks.panelId, chapterBookmarks.chapterId] })
      .returning();

    if (row) return { row, created: true };

    const existing = await this.findByPanelAndChapter(panelRowId, chapterRowId);
    if (!existing) throw new Error('Failed to insert chapter bookmark.');
    return { row: existing, created: false };
  }

  async insertMany(panelRowId: string, chapterRowIds: string[]): Promise<{ rows: ChapterBookmarkRow[]; created: number }> {
    if (chapterRowIds.length === 0) return { rows: [], created: 0 };

    const values = chapterRowIds.map((chapterId) => ({ panelId: panelRowId, chapterId }));

    const rows = await this.db
      .insert(chapterBookmarks)
      .values(values)
      .onConflictDoNothing({ target: [chapterBookmarks.panelId, chapterBookmarks.chapterId] })
      .returning();

    return { rows, created: rows.length };
  }

  async removeByPanelAndChapter(panelRowId: string, chapterRowId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(chapterBookmarks)
      .where(and(eq(chapterBookmarks.panelId, panelRowId), eq(chapterBookmarks.chapterId, chapterRowId)))
      .returning({ id: chapterBookmarks.id });
    return deleted.length > 0;
  }

  async clearByPanelId(panelRowId: string): Promise<number> {
    const deleted = await this.db
      .delete(chapterBookmarks)
      .where(eq(chapterBookmarks.panelId, panelRowId))
      .returning({ id: chapterBookmarks.id });
    return deleted.length;
  }
}