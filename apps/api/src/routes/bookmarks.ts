import { Hono } from 'hono';
import { z } from 'zod';
import { ErrorCodes, ok, type CreateBookmarkInput } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import type { BookmarkService } from '../services/bookmarkService.js';

const createBookmarkSchema = z.object({
  panelId: z.string().min(1).max(500),
  title: z.string().min(1).max(500),
  coverUrl: z.url().nullish(),
  source: z.string().min(1).max(50),
  sourceUrl: z.url().max(2000),
});

const bookmarkIdSchema = z.uuid();

/** Bookmark CRUD. */
export function bookmarkRoutes(bookmarkService: BookmarkService): Hono {
  const app = new Hono();

  // GET /api/bookmarks
  app.get('/', async (c) => {
    return c.json(ok(await bookmarkService.list()));
  });

  // GET /api/bookmarks/by-panel/:panelId → bookmark or null (details page state)
  app.get('/by-panel/:panelId', async (c) => {
    const panelId = c.req.param('panelId');
    return c.json(ok(await bookmarkService.getByPanelId(panelId)));
  });

  // POST /api/bookmarks
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createBookmarkSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid bookmark payload.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const input: CreateBookmarkInput = parsed.data;
    const { bookmark, created } = await bookmarkService.add(input);
    return c.json(ok(bookmark), created ? 201 : 200);
  });

  // DELETE /api/bookmarks/:id
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const parsed = bookmarkIdSchema.safeParse(id);
    if (!parsed.success) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed bookmark id.', { id });
    }
    await bookmarkService.remove(id);
    return c.json(ok({ id }));
  });

  return app;
}
