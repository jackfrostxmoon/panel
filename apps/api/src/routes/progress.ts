import { Hono } from 'hono';
import { z } from 'zod';
import { BULK_CHAPTER_LIMIT, ErrorCodes, isGlobalId, ok, type BulkMarkChaptersReadInput, type SaveProgressInput } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import type { ProgressService } from '../services/progressService.js';

const saveProgressSchema = z.object({
  panelId: z.string().min(1).max(500),
  chapterId: z.string().min(1).max(500),
  page: z.number().int().min(0).max(100_000),
  panelTitle: z.string().max(500).optional(),
  coverUrl: z.url().nullish(),
  chapterTitle: z.string().max(500).optional(),
});

const bulkMarkSchema = z.object({
  panelId: z.string().min(1).max(500),
  chapters: z
    .array(
      z.object({
        chapterId: z.string().min(1).max(500),
        page: z.union([z.number().int().min(0).max(100_000), z.null()]),
      }),
    )
    .min(1)
    .max(BULK_CHAPTER_LIMIT),
});

/** Reading-progress endpoints. */
export function progressRoutes(progressService: ProgressService): Hono {
  const app = new Hono();

  // GET /api/progress/unread-counts?ids=mk:x,mk:y → per-panel unread counts (T2-6)
  app.get('/unread-counts', async (c) => {
    const idsRaw = c.req.query('ids') ?? '';
    const ids = idsRaw
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
      .slice(0, 100);
    if (ids.length === 0) return c.json(ok({}));
    for (const id of ids) {
      if (!isGlobalId(id)) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed panel id.', { panelId: id });
      }
    }
    return c.json(ok(await progressService.unreadCounts(ids)));
  });

  // GET /api/progress/recent?limit=10 → "continue reading" rail on Home
  app.get('/recent', async (c) => {
    const limitRaw = Number.parseInt(c.req.query('limit') ?? '10', 10);
    const limit = Number.isInteger(limitRaw) && limitRaw >= 1 ? Math.min(limitRaw, 50) : 10;
    return c.json(ok(await progressService.listRecent(limit)));
  });

  // GET /api/progress/by-panel/:panelId/latest → latest entry or null.
  // Powers the details page's Continue button, which must not depend on
  // the capped global recent list (must be registered before
  // /:panelId/:chapterId, which would otherwise swallow "by-panel").
  app.get('/by-panel/:panelId/latest', async (c) => {
    const panelId = c.req.param('panelId');
    if (!isGlobalId(panelId)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed panel id.', { panelId });
    }
    return c.json(ok(await progressService.latestForPanel(panelId)));
  });

  // GET /api/progress/by-panel/:panelId/all → every entry for one panel.
  // Powers the details-page chapter read markers, which must not depend
  // on the capped global recent list. Registered before /:panelId/:chapterId.
  app.get('/by-panel/:panelId/all', async (c) => {
    const panelId = c.req.param('panelId');
    if (!isGlobalId(panelId)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed panel id.', { panelId });
    }
    return c.json(ok(await progressService.listForPanel(panelId)));
  });

  // GET /api/progress/:panelId/:chapterId → progress or null
  app.get('/:panelId/:chapterId', async (c) => {
    const panelId = c.req.param('panelId');
    const chapterId = c.req.param('chapterId');
    return c.json(ok(await progressService.get(panelId, chapterId)));
  });

  // PUT /api/progress
  app.put('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = saveProgressSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid progress payload.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const input: SaveProgressInput = parsed.data;
    return c.json(ok(await progressService.save(input)));
  });

  // DELETE /api/progress?panelId= — clear all reading progress for a panel
  app.delete('/', async (c) => {
    const panelId = c.req.query('panelId');
    if (!panelId) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Missing panelId query parameter.');
    }
    const count = await progressService.clearByPanelId(panelId);
    return c.json(ok({ count }));
  });

  // POST /api/progress/bulk — mark chapters read / unread in bulk (T1-6)
  app.post('/bulk', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = bulkMarkSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid bulk-mark payload.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const input: BulkMarkChaptersReadInput = parsed.data;
    if (!isGlobalId(input.panelId)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed panel id.', { panelId: input.panelId });
    }
    const result = await progressService.bulkMark(input.panelId, input.chapters);
    return c.json(ok(result));
  });

  return app;
}
