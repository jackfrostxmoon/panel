import {
  ErrorCodes,
  parseGlobalId,
  type PanelStatus,
  type RecentlyViewedPanel,
  type RecordRecentlyViewedInput,
} from '@panel/shared';
import { AppError } from '../lib/errors.js';
import type { BookmarkRepository } from '../repositories/bookmarkRepository.js';
import type { PanelCacheRepository } from '../repositories/panelCacheRepository.js';
import type { RecentlyViewedRepository } from '../repositories/recentlyViewedRepository.js';
import type { PanelRow, RecentlyViewedRow } from '../db/schema.js';

/** Server-side cap — mirrors the old localStorage rail (top 10). */
export const RECENTLY_VIEWED_MAX = 10;

const KNOWN_STATUSES: PanelStatus[] = ['ongoing', 'completed', 'hiatus', 'cancelled', 'unknown'];

/**
 * Recently-viewed history use-cases. Backs the home-page rail so it
 * survives browser clears, incognito sessions, and device switches.
 * Panel metadata is upserted into the shared cache, so rows keep
 * rendering even when the source is down.
 */
export class RecentlyViewedService {
  constructor(
    private readonly history: RecentlyViewedRepository,
    private readonly bookmarks: BookmarkRepository,
    private readonly panelCache: PanelCacheRepository,
  ) {}

  async list(): Promise<RecentlyViewedPanel[]> {
    const rows = await this.history.listWithPanel(RECENTLY_VIEWED_MAX);
    const latestChapters = await this.bookmarks.latestChapterTitles(rows.map((r) => r.panel.id));
    return rows.map(({ view, panel }) =>
      toRecentlyViewedPanel(view, panel, latestChapters.get(panel.id)?.title ?? null),
    );
  }

  /**
   * Record a view. Idempotent: re-opening a panel just bumps it to the
   * front. Prunes past the cap so the table never grows.
   */
  async record(input: RecordRecentlyViewedInput): Promise<{ entry: RecentlyViewedPanel; created: boolean }> {
    const parsed = parseGlobalId(input.panelId);
    if (!parsed) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid panel id.', {
        panelId: input.panelId,
      });
    }
    if (parsed.source !== input.source) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Panel id does not match the given source.', {
        panelId: input.panelId,
        source: input.source,
      });
    }

    const panelRow = await this.panelCache.upsertPanel({
      source: parsed.source,
      sourceId: parsed.nativeId,
      globalId: input.panelId,
      title: input.title,
      coverUrl: input.coverUrl ?? null,
      sourceUrl: input.sourceUrl,
      // A bump without metadata must not wipe the stored status back to
      // 'unknown' — keep whatever the cache already has.
      status: input.status ?? (await this.panelCache.findPanelByGlobalId(input.panelId))?.status ?? 'unknown',
    });

    const { row, created } = await this.history.touch(panelRow.id);
    await this.history.prune(RECENTLY_VIEWED_MAX);
    const latestChapters = await this.bookmarks.latestChapterTitles([panelRow.id]);
    return {
      entry: toRecentlyViewedPanel(row, panelRow, latestChapters.get(panelRow.id)?.title ?? null),
      created,
    };
  }

  async clear(): Promise<{ count: number }> {
    return { count: await this.history.clear() };
  }
}

function toRecentlyViewedPanel(
  row: RecentlyViewedRow,
  panel: PanelRow,
  latestChapter: string | null,
): RecentlyViewedPanel {
  const status: PanelStatus = KNOWN_STATUSES.includes(panel.status as PanelStatus)
    ? (panel.status as PanelStatus)
    : 'unknown';
  return {
    id: panel.globalId,
    title: panel.title,
    coverUrl: panel.coverUrl,
    source: panel.source,
    sourceUrl: panel.sourceUrl,
    status,
    latestChapter,
    viewedAt: row.viewedAt.toISOString(),
  };
}
