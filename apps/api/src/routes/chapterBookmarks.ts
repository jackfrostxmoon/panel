import { Hono } from 'hono';
import { z } from 'zod';
import { BULK_CHAPTER_LIMIT, ErrorCodes, ok, type CreateChapterBookmarkInput, type CreateChapterBookmarksInput } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import type { ChapterBookmarkService } from '../services/chapterBookmarkService.js';

const createChapterBookmarkSchema = z.object({
  panelId: z.string().min(1).max(500),
  chapterId: z.string().min(1).max(500),
  title: z.string().min(1).max(500),
  chapterNumber: z.number().nullable(),
  sourceUrl: z.string().url().min(1).max(2000),
  publishedAt: z.string().datetime().nullable(),
});

const createChapterBookmarksSchema = z.object({
  panelId: z.string().min(1).max(500),
  // Cap the array size so a single POST can't push the server into an
  // unbounded insert loop. Shared with /api/progress/bulk via
  // BULK_CHAPTER_LIMIT — the client chunks at this size too.
  chapters: z.array(z.object({
    chapterId: z.string().min(1).max(500),
    title: z.string().min(1).max(500),
    chapterNumber: z.number().nullable(),
    sourceUrl: z.string().url().min(1).max(2000),
    publishedAt: z.string().datetime().nullable(),
  })).min(1).max(BULK_CHAPTER_LIMIT),
});

/** Chapter Bookmark CRUD. */
export function chapterBookmarkRoutes(chapterBookmarkService: ChapterBookmarkService): Hono {
  const app = new Hono();

  // GET /api/chapter-bookmarks?panelId=
  app.get('/', async (c) => {
    const panelId = c.req.query('panelId');
    if (!panelId) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Missing panelId query parameter.');
    }
    return c.json(ok(await chapterBookmarkService.listByPanelId(panelId)));
  });

  // POST /api/chapter-bookmarks (single)
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createChapterBookmarkSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid chapter bookmark payload.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const input: CreateChapterBookmarkInput = parsed.data;
    const bookmark = await chapterBookmarkService.add(input);
    return c.json(ok(bookmark), 201);
  });

  // POST /api/chapter-bookmarks/batch (multiple)
  app.post('/batch', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createChapterBookmarksSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid chapter bookmarks payload.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const input: CreateChapterBookmarksInput = parsed.data;
    const bookmarks = await chapterBookmarkService.addMany(input);
    return c.json(ok(bookmarks), 201);
  });

  // DELETE /api/chapter-bookmarks?panelId=&chapterId= (remove single chapter bookmark)
  app.delete('/', async (c) => {
    const panelId = c.req.query('panelId');
    const chapterId = c.req.query('chapterId');
    
    if (!panelId) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Missing panelId query parameter.');
    }
    
    if (chapterId) {
      // Remove single chapter bookmark
      await chapterBookmarkService.removeByPanelAndChapter(panelId, chapterId);
      return c.json(ok({ panelId, chapterId }));
    }
    
    // Clear all for panel
    const count = await chapterBookmarkService.clearByPanelId(panelId);
    return c.json(ok({ count }));
  });

  return app;
}