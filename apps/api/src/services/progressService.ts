import {
  ErrorCodes,
  parseGlobalId,
  splitNativeChapterId,
  type ReadingProgress,
  type ReadingProgressEntry,
  type SaveProgressInput,
} from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { safeCoverUrl } from '../lib/coverGuard.js';
import type { PanelCacheRepository } from '../repositories/panelCacheRepository.js';
import type { ProgressRepository } from '../repositories/progressRepository.js';
import { chapterNumberFromToken as chapterNumberFromTokenMk } from '../sources/mangakatana/parser.js';
import { chapterNumberFromToken as chapterNumberFromTokenNk } from '../sources/nihonkuni/parser.js';
import { chapterNumberFromToken as chapterNumberFromTokenRk } from '../sources/rawkuma/parser.js';
import { chapterNumberFromToken as chapterNumberFromTokenRs } from '../sources/rawsakura/parser.js';
import { chapterNumberFromToken as chapterNumberFromTokenHd } from '../sources/hiperdex/parser.js';
import { chapterNumberFromToken as chapterNumberFromTokenMr } from '../sources/mangaread/parser.js';
import { chapterNumberFromToken as chapterNumberFromTokenTn } from '../sources/toonily/parser.js';
import { chapterNumberFromToken as chapterNumberFromTokenRd } from '../sources/rawdex/parser.js';
import type { SourceRegistry } from '../sources/registry.js';

const chapterNumberFromTokenBySource: Record<string, (token: string) => number | null> = {
  mk: chapterNumberFromTokenMk,
  nk: chapterNumberFromTokenNk,
  rk: chapterNumberFromTokenRk,
  rs: chapterNumberFromTokenRs,
  hd: chapterNumberFromTokenHd,
  mr: chapterNumberFromTokenMr,
  tn: chapterNumberFromTokenTn,
  rd: chapterNumberFromTokenRd,
};

/**
 * Reading-progress use-cases. Progress rows reference the metadata cache;
 * the client sends display metadata along so saving progress never depends
 * on the external source being online.
 */
export class ProgressService {
  constructor(
    private readonly progress: ProgressRepository,
    private readonly panelCache: PanelCacheRepository,
    private readonly registry: SourceRegistry,
  ) {}

  /** Returns null (not 404) when nothing was recorded — a fresh read is normal. */
  async get(panelGlobalId: string, chapterGlobalId: string): Promise<ReadingProgress | null> {
    const panelRow = await this.panelCache.findPanelByGlobalId(panelGlobalId);
    if (!panelRow) return null;
    const chapterRow = await this.panelCache.findChapterByGlobalId(chapterGlobalId);
    if (!chapterRow) return null;

    const row = await this.progress.get(panelRow.id, chapterRow.id);
    if (!row) return null;
    return {
      panelId: panelGlobalId,
      chapterId: chapterGlobalId,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async save(input: SaveProgressInput): Promise<ReadingProgress> {
    const panelParsed = parseGlobalId(input.panelId);
    const chapterParsed = parseGlobalId(input.chapterId);
    if (!panelParsed || !chapterParsed) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid panel or chapter id.');
    }

    const source = this.registry.get(panelParsed.source);

    const panelRow = await this.panelCache.upsertPanel({
      source: panelParsed.source,
      sourceId: panelParsed.nativeId,
      globalId: input.panelId,
      title: input.panelTitle ?? 'Unknown title',
      coverUrl: input.coverUrl ?? null,
      sourceUrl: source.buildPanelUrl(panelParsed.nativeId),
    });

    const chapterRow = await this.panelCache.upsertChapter(panelRow.id, {
      source: chapterParsed.source,
      sourceId: chapterParsed.nativeId,
      globalId: input.chapterId,
      title: input.chapterTitle ?? splitNativeChapterId(chapterParsed.nativeId)?.chapterToken ?? 'Unknown title',
      chapterNumber: (chapterNumberFromTokenBySource[panelParsed.source] ?? chapterNumberFromTokenMk)(splitNativeChapterId(chapterParsed.nativeId)?.chapterToken ?? ''),
      sourceUrl: source.buildChapterUrl(chapterParsed.nativeId),
    });

    const row = await this.progress.upsert(panelRow.id, chapterRow.id);
    return {
      panelId: input.panelId,
      chapterId: input.chapterId,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Latest progress row for one panel (any chapter), enriched like a
   * `listRecent` entry. Returns null when nothing was recorded — a fresh
   * read is normal.
   *
   * The details page's Continue button uses this instead of the capped
   * global recent list: a panel read days ago falls out of the top-N
   * `recent` window (and its Continue button silently vanishes) even
   * though the progress row is intact.
   */
  async latestForPanel(globalPanelId: string): Promise<ReadingProgressEntry | null> {
    const panelRow = await this.panelCache.findPanelByGlobalId(globalPanelId);
    if (!panelRow) return null;
    const row = await this.progress.getLatestForPanel(panelRow.id);
    if (!row) return null;
    const chapterRow = await this.panelCache.findChapterByRowId(row.chapterId);
    if (!chapterRow) return null;
    return {
      panelId: globalPanelId,
      chapterId: chapterRow.globalId,
      updatedAt: row.updatedAt.toISOString(),
      panelTitle: panelRow.title,
      coverUrl: safeCoverUrl(panelRow.coverUrl),
      chapterTitle: chapterRow.title,
      sourceUrl: panelRow.sourceUrl,
    };
  }

  /**
   * Every progress entry for one panel (any chapter). Powers the
   * details-page chapter read markers — unlike `listRecent`, this is not
   * capped, so markers survive after the panel falls out of the global
   * top-N window.
   */
  async listForPanel(globalPanelId: string): Promise<ReadingProgressEntry[]> {
    const panelRow = await this.panelCache.findPanelByGlobalId(globalPanelId);
    if (!panelRow) return [];
    const rows = await this.progress.listByPanel(panelRow.id);
    return rows.map((row) => ({
      panelId: row.panelGlobalId,
      chapterId: row.chapterGlobalId,
      updatedAt: row.progress.updatedAt.toISOString(),
      panelTitle: row.panelTitle,
      coverUrl: safeCoverUrl(row.coverUrl),
      chapterTitle: row.chapterTitle,
      sourceUrl: row.sourceUrl,
    }));
  }

  async listRecent(limit: number): Promise<ReadingProgressEntry[]> {
    const rows = await this.progress.listRecent(limit);
    return rows.map((row) => ({
      panelId: row.panelGlobalId,
      chapterId: row.chapterGlobalId,
      updatedAt: row.progress.updatedAt.toISOString(),
      panelTitle: row.panelTitle,
      coverUrl: safeCoverUrl(row.coverUrl),
      chapterTitle: row.chapterTitle,
      sourceUrl: row.sourceUrl,
    }));
  }

  async clearByPanelId(globalPanelId: string): Promise<number> {
    const panelRow = await this.panelCache.findPanelByGlobalId(globalPanelId);
    if (!panelRow) return 0;
    return this.progress.clearByPanelId(panelRow.id);
  }

  /**
   * Bulk mark chapters read / unread (T1-6). `read` = false means
   * "unread"; otherwise a chapter-level marker is upserted. Returns the
   * count of rows that were actually changed.
   */
  async bulkMark(
    globalPanelId: string,
    chapters: Array<{ chapterId: string; read: boolean }>,
  ): Promise<{ markedRead: number; markedUnread: number }> {
    const parsed = parseGlobalId(globalPanelId);
    if (!parsed) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid panel id.', { panelId: globalPanelId });
    }
    const panelRow = await this.panelCache.findPanelByGlobalId(globalPanelId);
    if (!panelRow) return { markedRead: 0, markedUnread: 0 };

    const resolved: Array<{ chapterRowId: string; read: boolean }> = [];
    for (const entry of chapters) {
      const chapterParsed = parseGlobalId(entry.chapterId);
      if (!chapterParsed) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid chapter id.', { chapterId: entry.chapterId });
      }
      if (typeof entry.read !== 'boolean') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Field "read" must be a boolean.', {
          read: entry.read,
        });
      }
      const chapterRow = await this.panelCache.findChapterByGlobalId(entry.chapterId);
      if (!chapterRow) continue; // unknown chapter — skip rather than error
      resolved.push({ chapterRowId: chapterRow.id, read: entry.read });
    }

    if (resolved.length === 0) return { markedRead: 0, markedUnread: 0 };
    return this.progress.bulkMark(panelRow.id, resolved);
  }

  /**
   * Unread chapter counts per panel id (T2-6). Unknown ids are simply
   * absent from the result.
   */
  async unreadCounts(globalPanelIds: string[]): Promise<Record<string, number>> {
    return this.progress.unreadCounts(globalPanelIds);
  }
}
