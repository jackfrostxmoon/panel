import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { chapters, panel, readingProgress, type ReadingProgressRow } from '../db/schema.js';

export interface RecentProgressEntry {
  progress: ReadingProgressRow;
  panelGlobalId: string;
  panelTitle: string;
  coverUrl: string | null;
  sourceUrl: string;
  chapterGlobalId: string;
  chapterTitle: string;
}

export class ProgressRepository {
  constructor(private readonly db: Database) {}

  async get(panelRowId: string, chapterRowId: string): Promise<ReadingProgressRow | undefined> {
    const [row] = await this.db
      .select()
      .from(readingProgress)
      .where(
        and(eq(readingProgress.panelId, panelRowId), eq(readingProgress.chapterId, chapterRowId)),
      )
      .limit(1);
    return row;
  }

  /** Latest progress row for a panel regardless of chapter. */
  async getLatestForPanel(panelRowId: string): Promise<ReadingProgressRow | undefined> {
    const [row] = await this.db
      .select()
      .from(readingProgress)
      .where(eq(readingProgress.panelId, panelRowId))
      .orderBy(desc(readingProgress.updatedAt))
      .limit(1);
    return row;
  }

  async upsert(
    panelRowId: string,
    chapterRowId: string,
    page: number,
    scrollFraction?: number | null,
  ): Promise<ReadingProgressRow> {
    const fraction =
      typeof scrollFraction === 'number' && Number.isFinite(scrollFraction)
        ? Math.max(0, Math.min(1, scrollFraction))
        : null;
    const [row] = await this.db
      .insert(readingProgress)
      .values({ panelId: panelRowId, chapterId: chapterRowId, page, scrollFraction: fraction, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [readingProgress.panelId, readingProgress.chapterId],
        set: { page, scrollFraction: fraction, updatedAt: new Date() },
      })
      .returning();
    if (!row) throw new Error('Failed to save reading progress.');
    return row;
  }

  /** Most recently updated progress entries, joined with display metadata. */
  async listRecent(limit: number): Promise<RecentProgressEntry[]> {
    const rows = await this.db
      .select({
        progress: readingProgress,
        panelGlobalId: panel.globalId,
        panelTitle: panel.title,
        coverUrl: panel.coverUrl,
        sourceUrl: panel.sourceUrl,
        chapterGlobalId: chapters.globalId,
        chapterTitle: chapters.title,
      })
      .from(readingProgress)
      .innerJoin(panel, eq(readingProgress.panelId, panel.id))
      .innerJoin(chapters, eq(readingProgress.chapterId, chapters.id))
      .orderBy(desc(readingProgress.updatedAt))
      .limit(limit);

    return rows;
  }

  /**
   * Every progress row for one panel, resolved to global chapter ids.
   * Powers the details-page chapter read markers, which must not depend
   * on the capped global `recent` list (a panel read days ago falls out
   * of the top-N window and its markers silently vanish even though the
   * rows are intact).
   */
  async listByPanel(panelRowId: string): Promise<RecentProgressEntry[]> {
    const rows = await this.db
      .select({
        progress: readingProgress,
        panelGlobalId: panel.globalId,
        panelTitle: panel.title,
        coverUrl: panel.coverUrl,
        sourceUrl: panel.sourceUrl,
        chapterGlobalId: chapters.globalId,
        chapterTitle: chapters.title,
      })
      .from(readingProgress)
      .innerJoin(panel, eq(readingProgress.panelId, panel.id))
      .innerJoin(chapters, eq(readingProgress.chapterId, chapters.id))
      .where(eq(readingProgress.panelId, panelRowId))
      .orderBy(desc(readingProgress.updatedAt));
    return rows;
  }

  /** Delete all reading progress for a panel. Returns count of deleted rows. */
  async clearByPanelId(panelRowId: string): Promise<number> {
    const deleted = await this.db
      .delete(readingProgress)
      .where(eq(readingProgress.panelId, panelRowId))
      .returning({ id: readingProgress.id });
    return deleted.length;
  }

  /**
   * Bulk upsert or delete progress rows. `page` = null deletes the row
   * (unread); otherwise it upserts at that page. Returns counts.
   */
  async bulkMark(
    panelRowId: string,
    chapterRowIds: Array<{ chapterRowId: string; page: number | null }>,
  ): Promise<{ markedRead: number; markedUnread: number }> {
    let markedRead = 0;
    let markedUnread = 0;
    for (const { chapterRowId, page } of chapterRowIds) {
      if (page === null) {
        const deleted = await this.db
          .delete(readingProgress)
          .where(
            and(
              eq(readingProgress.panelId, panelRowId),
              eq(readingProgress.chapterId, chapterRowId),
            ),
          )
          .returning({ id: readingProgress.id });
        if (deleted.length > 0) markedUnread++;
      } else {
        const [row] = await this.db
          .insert(readingProgress)
          .values({ panelId: panelRowId, chapterId: chapterRowId, page, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: [readingProgress.panelId, readingProgress.chapterId],
            set: { page, updatedAt: new Date() },
          })
          .returning();
        if (row) markedRead++;
      }
    }
    return { markedRead, markedUnread };
  }

  /**
   * Unread chapter counts per panel (T2-6). "Read" = a progress row exists
   * for that chapter (partially-read chapters count as started, so the
   * badge means "chapters you haven't opened yet").
   */
  async unreadCounts(panelGlobalIds: string[]): Promise<Record<string, number>> {
    if (panelGlobalIds.length === 0) return {};
    const rows = await this.db
      .select({
        globalId: panel.globalId,
        total: sql<number>`count(distinct ${chapters.id})::int`,
        read: sql<number>`count(distinct ${readingProgress.chapterId})::int`,
      })
      .from(panel)
      .innerJoin(chapters, eq(chapters.panelId, panel.id))
      .leftJoin(
        readingProgress,
        and(
          eq(readingProgress.panelId, panel.id),
          eq(readingProgress.chapterId, chapters.id),
        ),
      )
      .where(inArray(panel.globalId, panelGlobalIds))
      .groupBy(panel.id, panel.globalId);

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.globalId] = Math.max(0, row.total - row.read);
    }
    return result;
  }
}
