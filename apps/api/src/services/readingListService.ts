import { ErrorCodes, parseGlobalId, type ReadingListEntry, type ReadingListStatus, type UpsertReadingListInput } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { PanelCacheRepository } from '../repositories/panelCacheRepository.js';
import type { ReadingListRepository } from '../repositories/readingListRepository.js';
import type { SourceRegistry } from '../sources/registry.js';

const VALID_STATUS: ReadingListStatus[] = ['want_to_read', 'reading', 'completed'];

/**
 * Reading-list use-cases (T1-5): Want to Read / Reading / Completed.
 *
 * A panel on the list has exactly one status; moving it between statuses
 * is an upsert. Progress is joined so the list can render a "continue"
 * affordance without an extra round-trip.
 */
export class ReadingListService {
  constructor(
    private readonly repo: ReadingListRepository,
    private readonly panelCache: PanelCacheRepository,
    private readonly registry: SourceRegistry,
  ) {}

  async list(status?: ReadingListStatus): Promise<ReadingListEntry[]> {
    const entries = await this.repo.listWithDetails(status);
    return entries.map((entry) => toEntry(entry));
  }

  async getByPanelId(globalPanelId: string): Promise<ReadingListEntry | null> {
    const panelRow = await this.panelCache.findPanelByGlobalId(globalPanelId);
    if (!panelRow) return null;
    const row = await this.repo.findByPanelRowId(panelRow.id);
    if (!row) return null;
    const entries = await this.repo.listWithDetails();
    const match = entries.find((e) => e.row.id === row.id);
    if (!match) return null;
    return toEntry(match);
  }

  async upsert(input: UpsertReadingListInput): Promise<ReadingListEntry> {
    if (!VALID_STATUS.includes(input.status)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid reading-list status.', {
        status: input.status,
        valid: VALID_STATUS,
      });
    }
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
    });

    const { row, created } = await this.repo.upsert(panelRow.id, input.status);
    logger.info(created ? 'Added to reading list' : 'Reading-list status updated', {
      panelId: input.panelId,
      status: input.status,
    });
    const entries = await this.repo.listWithDetails();
    const match = entries.find((e) => e.row.id === row.id);
    if (!match) {
      throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Could not load the reading-list entry after upsert.');
    }
    return toEntry(match);
  }

  async remove(globalPanelId: string): Promise<void> {
    const panelRow = await this.panelCache.findPanelByGlobalId(globalPanelId);
    if (!panelRow) {
      throw new AppError(ErrorCodes.READING_LIST_NOT_FOUND, 'That panel is not on the reading list.');
    }
    const removed = await this.repo.remove(panelRow.id);
    if (!removed) {
      throw new AppError(ErrorCodes.READING_LIST_NOT_FOUND, 'That panel is not on the reading list.');
    }
    logger.info('Removed from reading list', { panelId: globalPanelId });
  }
}

function toEntry(entry: {
  row: { id: string; status: string; createdAt: Date; updatedAt: Date };
  panel: { globalId: string; title: string; coverUrl: string | null; source: string; sourceUrl: string };
  progress: { chapterId: string; chapterGlobalId: string; chapterTitle: string; page: number; scrollFraction: number | null; updatedAt: Date } | null;
}): ReadingListEntry {
  return {
    id: entry.row.id,
    panelId: entry.panel.globalId,
    status: entry.row.status as ReadingListStatus,
    createdAt: entry.row.createdAt.toISOString(),
    updatedAt: entry.row.updatedAt.toISOString(),
    title: entry.panel.title,
    coverUrl: entry.panel.coverUrl,
    source: entry.panel.source,
    sourceUrl: entry.panel.sourceUrl,
    progress: entry.progress
      ? {
          panelId: entry.panel.globalId,
          chapterId: entry.progress.chapterGlobalId,
          page: entry.progress.page,
          scrollFraction: entry.progress.scrollFraction,
          updatedAt: entry.progress.updatedAt.toISOString(),
        }
      : null,
  };
}