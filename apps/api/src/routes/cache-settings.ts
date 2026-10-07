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
    const bodyObj = body as { liveRefresh?: unknown; autoMemoryRelief?: unknown; autoMemoryReliefThresholdMb?: unknown };
    if (!body || typeof body !== 'object' || typeof bodyObj.liveRefresh !== 'boolean' || typeof bodyObj.autoMemoryRelief !== 'boolean') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must be { liveRefresh: boolean, autoMemoryRelief: boolean, autoMemoryReliefThresholdMb?: number }.',
      );
    }
    const thresholdMb = typeof bodyObj.autoMemoryReliefThresholdMb === 'number' && !Number.isNaN(bodyObj.autoMemoryReliefThresholdMb)
      ? bodyObj.autoMemoryReliefThresholdMb
      : 20;
    return c.json(
      ok(saveCacheSettings({
        liveRefresh: bodyObj.liveRefresh,
        autoMemoryRelief: bodyObj.autoMemoryRelief,
        autoMemoryReliefThresholdMb: thresholdMb,
      })),
    );
  });

  return app;
}
