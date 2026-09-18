import {
  ErrorCodes,
  type Bookmark,
  type BookmarkFolder,
  type BookmarkFolderContents,
} from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { dedupeGenreLabels } from '../lib/text.js';
import type { BookmarkFolderRepository } from '../repositories/bookmarkRepository.js';
import type { BookmarkRepository } from '../repositories/bookmarkRepository.js';
import type { PanelCacheRepository } from '../repositories/panelCacheRepository.js';
import type { BookmarkFolderRow, PanelRow } from '../db/schema.js';

/**
 * Bookmark folder use-cases (T2-8).
 *
 * A folder is a named grouping of panel bookmarks. The default folder
 * ("Reading list") is created lazily and is never deletable — it's the
 * home for every bookmark until the user moves it into another folder.
 * Panel can live in multiple folders at once.
 */
export class BookmarkFolderService {
  constructor(
    private readonly folders: BookmarkFolderRepository,
    private readonly bookmarks: BookmarkRepository,
    private readonly panelCache: PanelCacheRepository,
  ) {}

  async list(): Promise<BookmarkFolderRow[]> {
    return this.folders.list();
  }

  async ensureDefault(): Promise<BookmarkFolderRow> {
    return this.folders.ensureDefault('All bookmarks');
  }

  async create(name: string): Promise<BookmarkFolderRow> {
    const trimmed = (name ?? '').trim();
    if (!trimmed) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Folder name is required.', { name });
    }
    if (trimmed.length > 64) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Folder name is too long (max 64 chars).', {
        name,
      });
    }
    const existing = await this.folders.findByName(trimmed);
    if (existing) {
      throw new AppError(ErrorCodes.BOOKMARK_EXISTS, 'A folder with that name already exists.', {
        name: trimmed,
      });
    }
    return this.folders.insert(trimmed);
  }

  async rename(id: string, name: string): Promise<BookmarkFolderRow> {
    const trimmed = (name ?? '').trim();
    if (!trimmed) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Folder name is required.', { name });
    }
    const folder = await this.folders.findById(id);
    if (!folder) {
      throw new AppError(ErrorCodes.BOOKMARK_NOT_FOUND, 'Folder not found.', { folderId: id });
    }
    const updated = await this.folders.update(id, trimmed);
    if (!updated) throw new AppError(ErrorCodes.BOOKMARK_NOT_FOUND, 'Folder not found.', { folderId: id });
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    const folder = await this.folders.findById(id);
    if (!folder) {
      throw new AppError(ErrorCodes.BOOKMARK_NOT_FOUND, 'Folder not found.', { folderId: id });
    }
    if (folder.isDefault) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'The default folder cannot be deleted.', {
        folderId: id,
      });
    }
    return this.folders.remove(id);
  }

  async addItem(folderId: string, bookmarkId: string): Promise<{ created: boolean }> {
    const folder = await this.folders.findById(folderId);
    if (!folder) {
      throw new AppError(ErrorCodes.BOOKMARK_NOT_FOUND, 'Folder not found.', { folderId });
    }
    const bookmark = await this.bookmarks.findById(bookmarkId);
    if (!bookmark) {
      throw new AppError(ErrorCodes.BOOKMARK_NOT_FOUND, 'Bookmark not found.', { bookmarkId });
    }
    return this.folders.addItem(folderId, bookmarkId);
  }

  async removeItem(folderId: string, bookmarkId: string): Promise<boolean> {
    const folder = await this.folders.findById(folderId);
    if (!folder) {
      throw new AppError(ErrorCodes.BOOKMARK_NOT_FOUND, 'Folder not found.', { folderId });
    }
    return this.folders.removeItem(folderId, bookmarkId);
  }

  async contents(folderId: string | null): Promise<BookmarkFolderContents> {
    let folder: BookmarkFolderRow;
    if (folderId) {
      const found = await this.folders.findById(folderId);
      if (!found) {
        throw new AppError(ErrorCodes.BOOKMARK_NOT_FOUND, 'Folder not found.', { folderId });
      }
      folder = found;
    } else {
      folder = await this.folders.ensureDefault('All bookmarks');
    }

    const itemRows = await this.folders.listByFolder(folder.id);
    const items: Bookmark[] = [];
    const panelRows: PanelRow[] = [];
    const bookmarkRows: { id: string; createdAt: Date; updatedAt: Date }[] = [];
    for (const item of itemRows) {
      const bookmark = await this.bookmarks.findById(item.bookmarkId);
      if (!bookmark) continue;
      const panelRow = await this.panelCache.findPanelByRowId(bookmark.panelId);
      if (!panelRow) continue;
      bookmarkRows.push(bookmark);
      panelRows.push(panelRow);
    }
    const latestChapters = await this.bookmarks.latestChapterTitles(
      panelRows.map((m) => m.id),
    );
    const progressMap = await this.bookmarks.latestProgressForPanelRowIds(
      panelRows.map((m) => m.id),
    );
    const folderMap = await this.folders.listFoldersForBookmarks(
      bookmarkRows.map((b) => b.id),
    );
    for (let i = 0; i < bookmarkRows.length; i += 1) {
      const bookmark = bookmarkRows[i]!;
      const panelRow = panelRows[i]!;
      const latest = latestChapters.get(panelRow.id) ?? null;
      const progress = progressMap.get(panelRow.id) ?? null;
      items.push(
        toBookmarkSummary(
          bookmark,
          panelRow,
          progress
            ? {
                chapterId: progress.chapterId,
                chapterTitle: progress.chapterTitle,
                page: progress.page,
                updatedAt: progress.updatedAt,
              }
            : null,
          latest?.title ?? null,
          latest?.cachedAt ?? null,
          folderMap.get(bookmark.id) ?? [],
        ),
      );
    }
    return { folder: toApiFolder(folder), items };
  }
}

function toApiFolder(row: BookmarkFolderRow): BookmarkFolder {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toBookmarkSummary(
  row: { id: string; createdAt: Date; updatedAt: Date },
  panel: PanelRow,
  progress: { chapterId: string; chapterTitle: string; page: number; updatedAt: Date } | null,
  latestChapter: string | null = null,
  latestChapterCachedAt: Date | string | null = null,
  folderIds: string[] = [],
): Bookmark {
  return {
    id: row.id,
    panelId: panel.globalId,
    title: panel.title,
    coverUrl: panel.coverUrl,
    source: panel.source,
    sourceUrl: panel.sourceUrl,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    status: panel.status as Bookmark['status'],
    // See bookmarkService.toBookmark — same raw-label cleanup.
    genres: dedupeGenreLabels(panel.genres),
    summary: panel.description,
    latestChapter,
    latestChapterCachedAt:
      latestChapterCachedAt instanceof Date
        ? latestChapterCachedAt.toISOString()
        : latestChapterCachedAt ?? null,
    progress: progress
      ? {
          chapterId: progress.chapterId,
          chapterTitle: progress.chapterTitle,
          page: progress.page,
          updatedAt: progress.updatedAt.toISOString(),
        }
      : null,
    folderIds,
  };
}