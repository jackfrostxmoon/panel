import { desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  chapters,
  panel,
  readingList,
  readingProgress,
  type PanelRow,
  type ReadingListRow,
} from '../db/schema.js';

/** A reading-list row joined with panel metadata + (optional) progress. */
export interface ReadingListEntry {
  row: ReadingListRow;
  panel: PanelRow;
  progress: {
    chapterId: string;
    chapterGlobalId: string;
    chapterTitle: string;
    updatedAt: Date;
  } | null;
}

/**
 * Timestamps flowing through a CTE come back as raw driver values (integer
 * ms) instead of mapped Dates — normalize at the boundary.
 */
function toDate(value: unknown, fallback: Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  return fallback;
}

/**
 * Reading-list repository (T1-5). One row per panel with a user-chosen
 * status; progress is joined from the progress table for the "continue"
 * affordance.
 */
export class ReadingListRepository {
  constructor(private readonly db: Database) {}

  /** Latest progress row per panel (window function — SQLite has no DISTINCT ON). */
  private latestProgress() {
    const ranked = this.db
      .select({
        panelId: readingProgress.panelId,
        chapterId: readingProgress.chapterId,
        updatedAt: readingProgress.updatedAt,
        rn: sql<number>`row_number() over (partition by ${readingProgress.panelId} order by ${readingProgress.updatedAt} desc)`.as(
          'rn',
        ),
      })
      .from(readingProgress)
      .as('ranked');
    return this.db.$with('latest_progress').as(
      this.db
        .select({
          panelId: ranked.panelId,
          chapterId: ranked.chapterId,
          updatedAt: ranked.updatedAt,
        })
        .from(ranked)
        .where(sql`"rn" = 1`),
    );
  }

  async listWithDetails(status?: string): Promise<ReadingListEntry[]> {
    const latest = this.latestProgress();
    const where = status ? eq(readingList.status, status) : undefined;

    const rows = await this.db
      .with(latest)
      .select({
        row: readingList,
        panel: panel,
        progressChapterRowId: latest.chapterId,
        progressUpdatedAt: latest.updatedAt,
        chapterGlobalId: chapters.globalId,
        chapterTitle: chapters.title,
      })
      .from(readingList)
      .innerJoin(panel, eq(readingList.panelId, panel.id))
      .where(where ?? undefined)
      .orderBy(desc(readingList.updatedAt))
      .leftJoin(latest, eq(latest.panelId, panel.id))
      .leftJoin(chapters, eq(chapters.id, latest.chapterId));

    return rows.map((row) => ({
      row: row.row,
      panel: row.panel,
      progress:
        row.progressChapterRowId && row.chapterGlobalId && row.chapterTitle
          ? {
              chapterId: row.chapterGlobalId,
              chapterGlobalId: row.chapterGlobalId,
              chapterTitle: row.chapterTitle,
              updatedAt: toDate(row.progressUpdatedAt, new Date(0)),
            }
          : null,
    }));
  }

  async findByPanelRowId(panelRowId: string): Promise<ReadingListRow | undefined> {
    const [row] = await this.db
      .select()
      .from(readingList)
      .where(eq(readingList.panelId, panelRowId))
      .limit(1);
    return row;
  }

  /** Upsert a row (insert if absent, update status if present). Returns the row. */
  async upsert(
    panelRowId: string,
    status: string,
  ): Promise<{ row: ReadingListRow; created: boolean }> {
    const [existing] = await this.db
      .select()
      .from(readingList)
      .where(eq(readingList.panelId, panelRowId))
      .limit(1);

    if (existing) {
      const [row] = await this.db
        .update(readingList)
        .set({ status, updatedAt: new Date() })
        .where(eq(readingList.id, existing.id))
        .returning();
      if (!row) throw new Error('Failed to update reading-list row.');
      return { row, created: false };
    }

    const [row] = await this.db
      .insert(readingList)
      .values({ panelId: panelRowId, status })
      .returning();
    if (!row) throw new Error('Failed to insert reading-list row.');
    return { row, created: true };
  }

  async remove(panelRowId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(readingList)
      .where(eq(readingList.panelId, panelRowId))
      .returning({ id: readingList.id });
    return deleted.length > 0;
  }
}