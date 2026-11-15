import { ErrorCodes, parseGlobalId, type Bookmark, type CreateBookmarkInput } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { dedupeGenreLabels } from '../lib/text.js';
import { safeCoverUrl } from '../lib/coverGuard.js';
import type { BookmarkFolderRepository, BookmarkRepository } from '../repositories/bookmarkRepository.js';
import type { PanelCacheRepository } from '../repositories/panelCacheRepository.js';
import type { BookmarkRow, PanelRow } from '../db/schema.js';

/**
 * Bookmark use-cases. Bookmarks reference the panel metadata cache, so they
 * survive source outages and browser refreshes.
 */
export class BookmarkService {
  constructor(
    private readonly bookmarks: BookmarkRepository,
    private readonly panelCache: PanelCacheRepository,
    private readonly folders: BookmarkFolderRepository,
  ) {}

  /** Single round-trip folder-membership lookup for many bookmark ids. */
  private async folderMemberships(
    bookmarkIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    return this.folders.listFoldersForBookmarks(bookmarkIds);
  }

  async list(): Promise<Bookmark[]> {
    const rows = await this.bookmarks.listWithDetails();
    const latestChapters = await this.bookmarks.latestChapterTitles(rows.map((r) => r.panel.id));
    const folderMap = await this.folderMemberships(rows.map((r) => r.bookmark.id));
    return rows.map(({ bookmark, panel, progress }) => {
      const latest = latestChapters.get(panel.id) ?? null;
      return toBookmark(
        bookmark,
        panel,
        progress,
        latest?.title ?? null,
        latest?.cachedAt ?? null,
        folderMap.get(bookmark.id) ?? [],
        latest?.publishedAt ?? null,
      );
    });
  }

  /** Returns the bookmark for a global panel id, or null. */
  async getByPanelId(globalPanelId: string): Promise<Bookmark | null> {
    const panelRow = await this.panelCache.findPanelByGlobalId(globalPanelId);
    if (!panelRow) return null;
    const row = await this.bookmarks.findByPanelRowId(panelRow.id);
    if (!row) return null;
    const folderMap = await this.folderMemberships([row.id]);
    const latestChapters = await this.bookmarks.latestChapterTitles([panelRow.id]);
    const progressMap = await this.bookmarks.latestProgressForPanelRowIds([panelRow.id]);
    const latest = latestChapters.get(panelRow.id) ?? null;
    const progress = progressMap.get(panelRow.id) ?? null;
    return toBookmark(
      row,
      panelRow,
      progress
        ? {
            chapterId: progress.chapterId,
            chapterTitle: progress.chapterTitle,
            updatedAt: progress.updatedAt,
          }
        : null,
      latest?.title ?? null,
      latest?.cachedAt ?? null,
      folderMap.get(row.id) ?? [],
      latest?.publishedAt ?? null,
    );
  }

  /**
   * Add a bookmark. Idempotent by design: bookmarking the same panel twice
   * returns the existing bookmark instead of failing (the UI toggles).
   */
  async add(input: CreateBookmarkInput): Promise<{ bookmark: Bookmark; created: boolean }> {
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

    const existingPanel = await this.panelCache.findPanelByGlobalId(input.panelId);
    const panelRow = await this.panelCache.upsertPanel({
      source: parsed.source,
      sourceId: parsed.nativeId,
      globalId: input.panelId,
      title: input.title,
      coverUrl: input.coverUrl ?? null,
      sourceUrl: input.sourceUrl,
      genres: existingPanel?.genres ?? [],
      status: existingPanel?.status ?? 'unknown',
    });

    const { row, created } = await this.bookmarks.insert(panelRow.id);
    logger.info(created ? 'Bookmark created' : 'Bookmark already existed', {
      panelId: input.panelId,
    });
    // Every new bookmark is auto-joined to the default Reading list
    // folder so the user sees it in the bookmark list immediately.
    await this.folders.addItem((await this.folders.ensureDefault('All bookmarks')).id, row.id);
    const folderMap = await this.folderMemberships([row.id]);
    return {
      bookmark: toBookmark(
        row,
        panelRow,
        null,
        null,
        null,
        folderMap.get(row.id) ?? [],
      ),
      created,
    };
  }

  async remove(id: string): Promise<void> {
    const removed = await this.bookmarks.remove(id);
    if (!removed) {
      throw new AppError(ErrorCodes.BOOKMARK_NOT_FOUND, 'The bookmark could not be found.');
    }
    logger.info('Bookmark removed', { bookmarkId: id });
  }
}

function toBookmark(
  row: BookmarkRow,
  panel: PanelRow,
  progress: { chapterId: string; chapterTitle: string; updatedAt: Date } | null,
  latestChapter: string | null = null,
  latestChapterCachedAt: Date | string | null = null,
  folderIds: string[] = [],
  latestChapterPublishedAt: Date | string | null = null,
): Bookmark {
  return {
    id: row.id,
    panelId: panel.globalId,
    title: panel.title,
    coverUrl: safeCoverUrl(panel.coverUrl),
    source: panel.source,
    sourceUrl: panel.sourceUrl,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    status: panel.status as Bookmark['status'],
    // Panel rows may carry the sites' raw labels ("Action ,", case
    // variants) — serve the cleaned, deduped form so dropdowns and
    // matching never see the mess.
    genres: dedupeGenreLabels(panel.genres),
    summary: panel.description,
    latestChapter,
    latestChapterCachedAt:
      latestChapterCachedAt instanceof Date
        ? latestChapterCachedAt.toISOString()
        : latestChapterCachedAt ?? null,
    latestChapterPublishedAt:
      latestChapterPublishedAt instanceof Date
        ? latestChapterPublishedAt.toISOString()
        : latestChapterPublishedAt ?? null,
    progress: progress
      ? {
          chapterId: progress.chapterId,
          chapterTitle: progress.chapterTitle,
          updatedAt: progress.updatedAt.toISOString(),
        }
      : null,
    folderIds,
  };
}
