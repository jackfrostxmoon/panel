import { Hono } from 'hono';
import { ErrorCodes, ok } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { loadSearchSettings, saveSearchSettings } from '../lib/searchSettingsFile.js';

export function searchSettingsRoutes(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return c.json(ok(loadSearchSettings()));
  });

  app.put('/', async (c) => {
    const body = (await c.req.json()) as unknown;
    if (!body || typeof body !== 'object' || typeof (body as { infiniteScroll?: unknown }).infiniteScroll !== 'boolean') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must be { infiniteScroll: boolean }.',
      );
    }
    return c.json(
      ok(saveSearchSettings({ infiniteScroll: (body as { infiniteScroll: boolean }).infiniteScroll })),
    );
  });

  return app;
}
