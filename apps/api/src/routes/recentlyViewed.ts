import { Hono } from 'hono';
import { z } from 'zod';
import { ErrorCodes, ok, type RecordRecentlyViewedInput } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import type { RecentlyViewedService } from '../services/recentlyViewedService.js';

const recordRecentlyViewedSchema = z.object({
  panelId: z.string().min(1).max(500),
  title: z.string().min(1).max(500),
  coverUrl: z.url().nullish(),
  source: z.string().min(1).max(50),
  sourceUrl: z.url().max(2000),
  status: z.enum(['ongoing', 'completed', 'hiatus', 'cancelled', 'unknown']).nullish(),
});

/** Server-side recently-viewed history (home-page rail). */
export function recentlyViewedRoutes(historyService: RecentlyViewedService): Hono {
  const app = new Hono();

  // GET /api/recently-viewed — newest first, capped server-side.
  app.get('/', async (c) => {
    return c.json(ok(await historyService.list()));
  });

  // POST /api/recently-viewed — record a view (idempotent bump).
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = recordRecentlyViewedSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid recently-viewed payload.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const input: RecordRecentlyViewedInput = {
      panelId: parsed.data.panelId,
      title: parsed.data.title,
      coverUrl: parsed.data.coverUrl,
      source: parsed.data.source,
      sourceUrl: parsed.data.sourceUrl,
      status: parsed.data.status ?? undefined,
    };
    const { entry, created } = await historyService.record(input);
    return c.json(ok(entry), created ? 201 : 200);
  });

  // DELETE /api/recently-viewed — clear the whole history.
  app.delete('/', async (c) => {
    return c.json(ok(await historyService.clear()));
  });

  return app;
}
