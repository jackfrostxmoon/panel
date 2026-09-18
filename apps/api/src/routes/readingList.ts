import { Hono } from 'hono';
import { z } from 'zod';
import { ErrorCodes, isGlobalId, ok, type ReadingListStatus, type UpsertReadingListInput } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import type { ReadingListService } from '../services/readingListService.js';

const upsertSchema = z.object({
  panelId: z.string().min(1).max(500),
  status: z.enum(['want_to_read', 'reading', 'completed']),
  title: z.string().min(1).max(500),
  coverUrl: z.string().url().nullish(),
  source: z.string().min(1).max(50),
  sourceUrl: z.string().url().max(2000),
});

/**
 * Reading-list endpoints (T1-5): Want to Read / Reading / Completed.
 */
export function readingListRoutes(readingListService: ReadingListService): Hono {
  const app = new Hono();

  // GET /api/reading-list[?status=reading] → list (default: all statuses)
  app.get('/', async (c) => {
    const statusRaw = c.req.query('status');
    let status: ReadingListStatus | undefined;
    if (statusRaw) {
      if (statusRaw !== 'want_to_read' && statusRaw !== 'reading' && statusRaw !== 'completed') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid status filter.', { status: statusRaw });
      }
      status = statusRaw as ReadingListStatus;
    }
    return c.json(ok(await readingListService.list(status)));
  });

  // GET /api/reading-list/by-panel/:panelId → entry or null
  app.get('/by-panel/:panelId', async (c) => {
    const panelId = c.req.param('panelId');
    if (!isGlobalId(panelId)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed panel id.', { panelId });
    }
    return c.json(ok(await readingListService.getByPanelId(panelId)));
  });

  // PUT /api/reading-list → upsert (add or move between statuses)
  app.put('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = upsertSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid reading-list payload.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const input: UpsertReadingListInput = parsed.data;
    const entry = await readingListService.upsert(input);
    return c.json(ok(entry), 200);
  });

  // DELETE /api/reading-list/:panelId → remove from the list
  app.delete('/:panelId', async (c) => {
    const panelId = c.req.param('panelId');
    if (!isGlobalId(panelId)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed panel id.', { panelId });
    }
    await readingListService.remove(panelId);
    return c.json(ok({ panelId }));
  });

  return app;
}