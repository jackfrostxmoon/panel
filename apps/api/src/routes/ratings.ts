import { Hono } from 'hono';
import { z } from 'zod';
import { ErrorCodes, isGlobalId, ok } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import type { PanelRatingService } from '../services/panelRatingService.js';

const setRatingSchema = z.object({
  panelId: z.string().min(1).max(500),
  rating: z.number().int().min(1).max(5),
});

/** User star ratings (T3-3): GET by panel, PUT upsert, DELETE clear. */
export function panelRatingRoutes(ratingService: PanelRatingService): Hono {
  const app = new Hono();

  // GET /api/ratings/by-panel/:panelId → rating or null
  app.get('/by-panel/:panelId', async (c) => {
    const panelId = c.req.param('panelId');
    if (!isGlobalId(panelId)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed panel id.', { panelId });
    }
    return c.json(ok(await ratingService.getByPanelId(panelId)));
  });

  // PUT /api/ratings
  app.put('/', async (c) => {
    const input = setRatingSchema.parse(await c.req.json());
    if (!isGlobalId(input.panelId)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed panel id.', {
        panelId: input.panelId,
      });
    }
    return c.json(ok(await ratingService.set(input)));
  });

  // DELETE /api/ratings/:panelId
  app.delete('/:panelId', async (c) => {
    const panelId = c.req.param('panelId');
    if (!isGlobalId(panelId)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed panel id.', { panelId });
    }
    await ratingService.clear(panelId);
    return c.json(ok({ cleared: true }));
  });

  return app;
}