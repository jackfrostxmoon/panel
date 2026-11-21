import { Hono } from 'hono';
import { z } from 'zod';
import {
  ErrorCodes,
  ok,
  type AddBookmarkToFolderInput,
  type BookmarkFolder,
  type BookmarkFolderContents,
  type CreateBookmarkFolderInput,
  type RemoveBookmarkFromFolderInput,
  type UpdateBookmarkFolderInput,
} from '@panel/shared';
import { AppError } from '../lib/errors.js';
import type { BookmarkFolderService } from '../services/bookmarkFolderService.js';

const createFolderSchema = z.object({
  name: z.string().min(1).max(64),
});

const updateFolderSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(64),
});

const folderIdSchema = z.uuid();

const addItemSchema = z.object({
  folderId: z.uuid(),
  bookmarkId: z.uuid(),
});

/** Validate with safeParse and map failures to a 400 (a raw ZodError would
 *  fall through the error handler as a 500 INTERNAL_ERROR). */
function parseOr400<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid bookmark-folder payload.', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

/**
 * Bookmark folder CRUD + membership (T2-8).
 *
 * The default folder is created lazily and is never deletable — it's the
 * home for every bookmark until the user moves it into another folder.
 */
export function bookmarkFolderRoutes(folderService: BookmarkFolderService): Hono {
  const app = new Hono();

  // GET /api/bookmark-folders
  app.get('/', async (c) => {
    const folders = await folderService.list();
    const defaultFolder = folders.find((f) => f.isDefault);
    return c.json(
      ok({
        folders: folders.map(toApiFolder),
        defaultId: defaultFolder?.id ?? null,
      }),
    );
  });

  // GET /api/bookmark-folders/default → the default folder's contents
  app.get('/default', async (c) => {
    const contents = await folderService.contents(null);
    return c.json(ok(toApiContents(contents)));
  });

  // GET /api/bookmark-folders/:id → folder + its contents
  app.get('/:id', async (c) => {
    const folderId = parseOr400(folderIdSchema, c.req.param('id'));
    const contents = await folderService.contents(folderId);
    return c.json(ok(toApiContents(contents)));
  });

  // POST /api/bookmark-folders
  app.post('/', async (c) => {
    const input: CreateBookmarkFolderInput = parseOr400(createFolderSchema, await c.req.json());
    const folder = await folderService.create(input.name);
    return c.json(ok(toApiFolder(folder)), 201);
  });

  // PATCH /api/bookmark-folders/:id → rename
  app.patch('/:id', async (c) => {
    const body: UpdateBookmarkFolderInput = parseOr400(updateFolderSchema, {
      id: c.req.param('id'),
      ...(await c.req.json()),
    });
    const folder = await folderService.rename(body.id, body.name);
    return c.json(ok(toApiFolder(folder)));
  });

  // DELETE /api/bookmark-folders/:id
  app.delete('/:id', async (c) => {
    const folderId = parseOr400(folderIdSchema, c.req.param('id'));
    const removed = await folderService.remove(folderId);
    if (!removed) {
      throw new AppError(ErrorCodes.BOOKMARK_NOT_FOUND, 'Folder not found.', { folderId });
    }
    return c.json(ok({ deleted: true }));
  });

  // POST /api/bookmark-folders/:id/items
  app.post('/:id/items', async (c) => {
    const body: AddBookmarkToFolderInput = parseOr400(addItemSchema, {
      folderId: c.req.param('id'),
      ...(await c.req.json()),
    });
    const result = await folderService.addItem(body.folderId, body.bookmarkId);
    return c.json(ok({ added: result.created }), 201);
  });

  // DELETE /api/bookmark-folders/:id/items/:bookmarkId
  app.delete('/:id/items/:bookmarkId', async (c) => {
    const body: RemoveBookmarkFromFolderInput = {
      folderId: c.req.param('id'),
      bookmarkId: c.req.param('bookmarkId'),
    };
    const removed = await folderService.removeItem(body.folderId, body.bookmarkId);
    if (!removed) {
      throw new AppError(ErrorCodes.BOOKMARK_NOT_FOUND, 'Bookmark not found in folder.', {
        folderId: body.folderId,
        bookmarkId: body.bookmarkId,
      });
    }
    return c.json(ok({ removed: true }));
  });

  return app;
}

function toApiFolder(row: {
  id: string;
  name: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}): BookmarkFolder {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toApiContents(contents: BookmarkFolderContents): BookmarkFolderContents {
  return {
    folder: contents.folder
      ? {
          id: contents.folder.id,
          name: contents.folder.name,
          isDefault: contents.folder.isDefault,
          createdAt: contents.folder.createdAt,
          updatedAt: contents.folder.updatedAt,
        }
      : null,
    items: contents.items,
  };
}