import { Hono } from 'hono';
import { ErrorCodes, ok } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { loadCacheSettings, saveCacheSettings } from '../lib/cacheSettingsFile.js';

export function cacheSettingsRoutes(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return c.json(ok(loadCacheSettings()));
  });

  app.put('/', async (c) => {
    const body = (await c.req.json()) as unknown;
    if (!body || typeof body !== 'object' || typeof (body as { liveRefresh?: unknown }).liveRefresh !== 'boolean') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must be { liveRefresh: boolean }.',
      );
    }
    return c.json(
      ok(saveCacheSettings({ liveRefresh: (body as { liveRefresh: boolean }).liveRefresh })),
    );
  });

  return app;
}
