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
    const bodyObj = body as { liveRefresh?: unknown; autoMemoryRelief?: unknown; autoMemoryReliefThresholdMb?: unknown; autoMemoryReliefRssThresholdMb?: unknown; autoRestartEveryMs?: unknown };
    if (!body || typeof body !== 'object' || typeof bodyObj.liveRefresh !== 'boolean' || typeof bodyObj.autoMemoryRelief !== 'boolean') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must be { liveRefresh: boolean, autoMemoryRelief: boolean, autoMemoryReliefThresholdMb?: number, autoMemoryReliefRssThresholdMb?: number, autoRestartEveryMs?: number }.',
      );
    }
    const thresholdMb = typeof bodyObj.autoMemoryReliefThresholdMb === 'number' && !Number.isNaN(bodyObj.autoMemoryReliefThresholdMb)
      ? bodyObj.autoMemoryReliefThresholdMb
      : 20;
    const rssThresholdMb = typeof bodyObj.autoMemoryReliefRssThresholdMb === 'number' && !Number.isNaN(bodyObj.autoMemoryReliefRssThresholdMb)
      ? bodyObj.autoMemoryReliefRssThresholdMb
      : 256;
    const restartEveryMs = typeof bodyObj.autoRestartEveryMs === 'number' && !Number.isNaN(bodyObj.autoRestartEveryMs)
      ? Math.max(0, Math.round(bodyObj.autoRestartEveryMs))
      : 0;
    return c.json(
      ok(saveCacheSettings({
        liveRefresh: bodyObj.liveRefresh,
        autoMemoryRelief: bodyObj.autoMemoryRelief,
        autoMemoryReliefThresholdMb: thresholdMb,
        autoMemoryReliefRssThresholdMb: rssThresholdMb,
        autoRestartEveryMs: restartEveryMs,
      })),
    );
  });

  return app;
}
