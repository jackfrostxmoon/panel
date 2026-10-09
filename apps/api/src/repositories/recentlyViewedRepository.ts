import { desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  panel,
  recentlyViewed,
  type PanelRow,
  type RecentlyViewedRow,
} from '../db/schema.js';

/** Recently-viewed row joined with the panel metadata the rail renders. */
export interface RecentlyViewedWithPanel {
  view: RecentlyViewedRow;
  panel: PanelRow;
}

export class RecentlyViewedRepository {
  constructor(private readonly db: Database) {}

  /** Newest-first history with panel details, capped at `limit`. */
  async listWithPanel(limit: number): Promise<RecentlyViewedWithPanel[]> {
    return this.db
      .select({ view: recentlyViewed, panel })
      .from(recentlyViewed)
      .innerJoin(panel, eq(recentlyViewed.panelId, panel.id))
      .orderBy(desc(recentlyViewed.viewedAt))
      .limit(limit);
  }

  /**
   * Record a view: insert, or bump `viewedAt` when the panel is already
   * in the history. Returns the row and whether it is brand-new.
   */
  async touch(panelRowId: string): Promise<{ row: RecentlyViewedRow; created: boolean }> {
    const [existing] = await this.db
      .select()
      .from(recentlyViewed)
      .where(eq(recentlyViewed.panelId, panelRowId))
      .limit(1);
    if (existing) {
      const [bumped] = await this.db
        .update(recentlyViewed)
        .set({ viewedAt: new Date() })
        .where(eq(recentlyViewed.id, existing.id))
        .returning();
      if (!bumped) throw new Error('Failed to record recently-viewed entry.');
      return { row: bumped, created: false };
    }
    const [row] = await this.db
      .insert(recentlyViewed)
      .values({ panelId: panelRowId, viewedAt: new Date() })
      .returning();
    if (!row) throw new Error('Failed to record recently-viewed entry.');
    return { row, created: true };
  }

  /** Drop everything but the newest `keep` rows (the rail only shows 10). */
  async prune(keep: number): Promise<number> {
    const overflow = await this.db
      .select({ id: recentlyViewed.id })
      .from(recentlyViewed)
      .orderBy(desc(recentlyViewed.viewedAt))
      // SQLite rejects bare OFFSET without LIMIT — LIMIT -1 means "no limit".
      .limit(-1)
      .offset(keep);
    if (overflow.length === 0) return 0;
    const deleted = await this.db
      .delete(recentlyViewed)
      .where(
        inArray(
          recentlyViewed.id,
          overflow.map((r) => r.id),
        ),
      )
      .returning({ id: recentlyViewed.id });
    return deleted.length;
  }

  /** Clear the whole history (home-page "Clear" button). */
  async clear(): Promise<number> {
    const deleted = await this.db
      .delete(recentlyViewed)
      .returning({ id: recentlyViewed.id });
    return deleted.length;
  }
}
