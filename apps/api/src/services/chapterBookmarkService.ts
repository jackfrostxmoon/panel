import {
  ErrorCodes,
  parseGlobalId,
  type ChapterBookmark,
  type CreateChapterBookmarkInput,
  type CreateChapterBookmarksInput,
  type ParsedGlobalId,
} from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { ChapterBookmarkRepository } from '../repositories/chapterBookmarkRepository.js';
import type { PanelCacheRepository } from '../repositories/panelCacheRepository.js';
import type { ChapterBookmarkRow, ChapterRow, PanelRow } from '../db/schema.js';

/**
 * Chapter bookmark use-cases. Chapter bookmarks reference the panel/chapter
 * metadata cache, so they survive source outages and browser refreshes.
 */
export class ChapterBookmarkService {
  constructor(
    private readonly chapterBookmarks: ChapterBookmarkRepository,
    private readonly panelCache: PanelCacheRepository,
  ) {}

  async listByPanelId(globalPanelId: string): Promise<ChapterBookmark[]> {
    const panelRow = await this.panelCache.findPanelByGlobalId(globalPanelId);
    if (!panelRow) return [];

    const rows = await this.chapterBookmarks.listByPanelId(panelRow.id);
    return rows.map(({ bookmark, chapter }) => toChapterBookmark(bookmark, chapter, globalPanelId));
  }

  /** Add a single chapter bookmark. Idempotent by design. */
  async add(input: CreateChapterBookmarkInput): Promise<ChapterBookmark> {
    const parsedPanel = parseGlobalId(input.panelId);
    const parsedChapter = parseGlobalId(input.chapterId);
    if (!parsedPanel || !parsedChapter) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid panel or chapter id.', {
        panelId: input.panelId,
        chapterId: input.chapterId,
      });
    }

    const panelRow = await this.resolvePanelRow(input.panelId, parsedPanel);

    // Upsert the chapter into the cache so the bookmark can reference it.
    const chapterRow = await this.panelCache.upsertChapter(panelRow.id, {
      source: parsedChapter.source,
      sourceId: parsedChapter.nativeId,
      globalId: input.chapterId,
      title: input.title,
      chapterNumber: input.chapterNumber,
      sourceUrl: input.sourceUrl,
      publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
    });

    const { row } = await this.chapterBookmarks.insert(panelRow.id, chapterRow.id);
    logger.info('Chapter bookmark created', { panelId: input.panelId, chapterId: input.chapterId });
    return toChapterBookmark(row, chapterRow, input.panelId);
  }

  /** Add multiple chapter bookmarks. Idempotent by design. */
  async addMany(input: CreateChapterBookmarksInput): Promise<ChapterBookmark[]> {
    const parsedPanel = parseGlobalId(input.panelId);
    if (!parsedPanel) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid panel id.', {
        panelId: input.panelId,
      });
    }

    const panelRow = await this.resolvePanelRow(input.panelId, parsedPanel);

    // Upsert all chapters into the cache.
    const chapterRows = await Promise.all(
      input.chapters.map((ch) => {
        const parsedChapter = parseGlobalId(ch.chapterId);
        if (!parsedChapter) {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid chapter id.', {
            chapterId: ch.chapterId,
          });
        }
        return this.panelCache.upsertChapter(panelRow.id, {
          source: parsedChapter.source,
          sourceId: parsedChapter.nativeId,
          globalId: ch.chapterId,
          title: ch.title,
          chapterNumber: ch.chapterNumber,
          sourceUrl: ch.sourceUrl,
          publishedAt: ch.publishedAt ? new Date(ch.publishedAt) : null,
        });
      }),
    );

    const validChapterIds = chapterRows.map((row) => row.id);

    const { rows } = await this.chapterBookmarks.insertMany(panelRow.id, validChapterIds);
    logger.info('Chapter bookmarks created', { panelId: input.panelId, count: rows.length });

    // Map back to ChapterBookmark with chapter details
    const chapterMap = new Map(chapterRows.map((c) => [c.id, c]));
    return rows.map((row) => toChapterBookmark(row, chapterMap.get(row.chapterId)!, input.panelId));
  }

  /**
   * Reuse the cached panel row when present so bookmarking never clobbers
   * cached metadata; create a placeholder row only for unknown panels.
   */
  private async resolvePanelRow(globalPanelId: string, parsed: ParsedGlobalId): Promise<PanelRow> {
    const existing = await this.panelCache.findPanelByGlobalId(globalPanelId);
    if (existing) return existing;

    return this.panelCache.upsertPanel({
      source: parsed.source,
      sourceId: parsed.nativeId,
      globalId: globalPanelId,
      title: 'Unknown title',
      coverUrl: null,
      sourceUrl: '',
    });
  }

  async clearByPanelId(globalPanelId: string): Promise<number> {
    const panelRow = await this.panelCache.findPanelByGlobalId(globalPanelId);
    if (!panelRow) return 0;

    const count = await this.chapterBookmarks.clearByPanelId(panelRow.id);
    logger.info('Chapter bookmarks cleared', { panelId: globalPanelId, count });
    return count;
  }

  /** Remove a chapter bookmark by panel ID and chapter ID (global IDs). */
  async removeByPanelAndChapter(globalPanelId: string, globalChapterId: string): Promise<void> {
    const panelRow = await this.panelCache.findPanelByGlobalId(globalPanelId);
    if (!panelRow) {
      throw new AppError(ErrorCodes.PANEL_NOT_FOUND, 'Panel not found.', { panelId: globalPanelId });
    }

    const chapterRow = await this.panelCache.findChapterByGlobalId(globalChapterId);
    if (!chapterRow) {
      // Chapter not cached — nothing to remove.
      return;
    }

    // Verify chapter belongs to this panel
    if (chapterRow.panelId !== panelRow.id) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Chapter does not belong to this panel.', {
        panelId: globalPanelId,
        chapterId: globalChapterId,
      });
    }

    const removed = await this.chapterBookmarks.removeByPanelAndChapter(panelRow.id, chapterRow.id);
    if (!removed) {
      throw new AppError(ErrorCodes.BOOKMARK_NOT_FOUND, 'The chapter bookmark could not be found.');
    }
    logger.info('Chapter bookmark removed', { panelId: globalPanelId, chapterId: globalChapterId });
  }
}

function toChapterBookmark(
  row: ChapterBookmarkRow,
  chapter: ChapterRow,
  globalPanelId: string,
): ChapterBookmark {
  return {
    id: row.id,
    panelId: globalPanelId,
    chapterId: chapter.globalId,
    createdAt: row.createdAt.toISOString(),
  };
}