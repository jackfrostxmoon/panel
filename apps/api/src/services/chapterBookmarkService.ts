import {
  ErrorCodes,
  parseGlobalId,
  type ChapterBookmark,
  type ChapterBookmarkPanelSummary,
  type CreateChapterBookmarkInput,
  type CreateChapterBookmarksInput,
  type ParsedGlobalId,
} from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { ChapterBookmarkRepository } from '../repositories/chapterBookmarkRepository.js';
import type { PanelCacheRepository } from '../repositories/panelCacheRepository.js';
import type { SourceRegistry } from '../sources/registry.js';
import type { ChapterBookmarkRow, ChapterRow, PanelRow } from '../db/schema.js';

/**
 * Chapter bookmark use-cases. Chapter bookmarks reference the panel/chapter
 * metadata cache, so they survive source outages and browser refreshes.
 */
export class ChapterBookmarkService {
  constructor(
    private readonly chapterBookmarks: ChapterBookmarkRepository,
    private readonly panelCache: PanelCacheRepository,
    private readonly registry?: SourceRegistry,
  ) {}

  /** Per-panel bookmarked-chapter counts for every panel that has at least
      one. Used by the bookmarks-page filter dropdown — the client joins
      these counts against its own bookmark list. */
  async listPanelCounts(): Promise<ChapterBookmarkPanelSummary[]> {
    return this.chapterBookmarks.listPanelCounts();
  }

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
    // The reader may bookmark before the chapter list loads (or while the
    // source is down) and can only send an empty sourceUrl — backfill a
    // canonical URL so the bookmark survives offline instead of 400ing.
    const sourceUrl = await this.resolveChapterSourceUrl(
      parsedChapter.source,
      parsedChapter.nativeId,
      input.chapterId,
      input.sourceUrl,
    );
    const chapterRow = await this.panelCache.upsertChapter(panelRow.id, {
      source: parsedChapter.source,
      sourceId: parsedChapter.nativeId,
      globalId: input.chapterId,
      title: input.title,
      chapterNumber: input.chapterNumber,
      sourceUrl,
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
      input.chapters.map(async (ch) => {
        const parsedChapter = parseGlobalId(ch.chapterId);
        if (!parsedChapter) {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid chapter id.', {
            chapterId: ch.chapterId,
          });
        }
        const sourceUrl = await this.resolveChapterSourceUrl(
          parsedChapter.source,
          parsedChapter.nativeId,
          ch.chapterId,
          ch.sourceUrl,
        );
        return this.panelCache.upsertChapter(panelRow.id, {
          source: parsedChapter.source,
          sourceId: parsedChapter.nativeId,
          globalId: ch.chapterId,
          title: ch.title,
          chapterNumber: ch.chapterNumber,
          sourceUrl,
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
   * Resolve a usable chapter sourceUrl. Preference order: client-supplied
   * valid URL → cached chapter row → registry-built canonical URL (pure
   * string building, works offline) → existing cached value → ''.
   * Never throws — the chapters table requires NOT NULL but tolerates
   * empty, so '' is the last resort.
   */
  private async resolveChapterSourceUrl(
    source: string,
    nativeChapterId: string,
    globalChapterId: string,
    inputSourceUrl: string,
  ): Promise<string> {
    if (inputSourceUrl && isHttpUrl(inputSourceUrl)) return inputSourceUrl;
    try {
      const cached = await this.panelCache.findChapterByGlobalId(globalChapterId);
      if (cached?.sourceUrl && isHttpUrl(cached.sourceUrl)) return cached.sourceUrl;
    } catch {
      // Cache lookup is best-effort — fall through to the registry build.
    }
    if (this.registry) {
      try {
        const adapter = this.registry.get(source);
        return adapter.buildChapterUrl(nativeChapterId);
      } catch {
        // Unknown source or malformed id — fall through to panel fallback.
      }
    }
    try {
      const cached = await this.panelCache.findChapterByGlobalId(globalChapterId);
      if (cached?.sourceUrl) return cached.sourceUrl;
    } catch {
      // Ignore — '' below still satisfies NOT NULL.
    }
    return inputSourceUrl && inputSourceUrl.length > 0 && inputSourceUrl.length <= 2000
      ? inputSourceUrl
      : '';
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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
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