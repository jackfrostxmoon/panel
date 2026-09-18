import { Hono } from 'hono';
import { z } from 'zod';
import { ErrorCodes, isGlobalId, ok } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import type { TagService } from '../services/tagService.js';

const createTagSchema = z.object({
  name: z.string().min(1).max(32),
});

const setTagsSchema = z.object({
  panelId: z.string().min(1).max(500),
  names: z.array(z.string().max(32)).max(50),
});

/** Custom tags (T3-4): list, create, delete, per-panel get/set. */
export function tagRoutes(tagService: TagService): Hono {
  const app = new Hono();

  // GET /api/tags → all tags with the panel ids carrying them
  app.get('/', async (c) => {
    return c.json(ok(await tagService.listWithPanel()));
  });

  // POST /api/tags
  app.post('/', async (c) => {
    const input = createTagSchema.parse(await c.req.json());
    return c.json(ok(await tagService.create(input.name)), 201);
  });

  // DELETE /api/tags/:id
  app.delete('/:id', async (c) => {
    await tagService.remove(c.req.param('id'));
    return c.json(ok({ deleted: true }));
  });

  // GET /api/tags/by-panel/:panelId → tags on that panel
  app.get('/by-panel/:panelId', async (c) => {
    const panelId = c.req.param('panelId');
    if (!isGlobalId(panelId)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed panel id.', { panelId });
    }
    return c.json(ok(await tagService.listByPanelId(panelId)));
  });

  // PUT /api/tags/by-panel/:panelId → replace the panel's tag set
  app.put('/by-panel/:panelId', async (c) => {
    const body = setTagsSchema.parse({ ...(await c.req.json()), panelId: c.req.param('panelId') });
    if (!isGlobalId(body.panelId)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed panel id.', {
        panelId: body.panelId,
      });
    }
    return c.json(ok(await tagService.setPanelTags(body.panelId, body.names)));
  });

  return app;
}