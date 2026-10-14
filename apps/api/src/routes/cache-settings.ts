import { Hono } from 'hono';
import { ErrorCodes, ok } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import { loadCacheSettings, saveCacheSettings } from '../lib/cacheSettingsFile.js';
import type { ImageCache } from '../lib/imageCache.js';
import type { PanelService } from '../services/panelService.js';
import type { SourceRegistry } from '../sources/registry.js';

export interface CacheSettingsDeps {
  panelService: PanelService;
  imageCache: ImageCache;
  registry: SourceRegistry;
}

/**
 * Apply the max-throughput profile (or restore standard limits) the moment
 * the toggle is saved — no restart needed. Kept next to the route (rather
 * than inside `saveCacheSettings`, which is a pure file helper) so the
 * file layer stays free of service singletons; index.ts re-applies the
 * persisted value at boot via the same function.
 */
export async function applyPerformanceProfile(deps: CacheSettingsDeps, on: boolean): Promise<void> {
  deps.panelService.setPerformanceMode(on);
  deps.imageCache.setPerformanceBoost(on);
  deps.registry.setPerformanceModeAll(on);
}

export function cacheSettingsRoutes(deps?: CacheSettingsDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return c.json(ok(loadCacheSettings()));
  });

  app.put('/', async (c) => {
    const body = (await c.req.json()) as unknown;
    const bodyObj = body as { liveRefresh?: unknown; autoMemoryRelief?: unknown; autoMemoryReliefThresholdMb?: unknown; autoMemoryReliefRssThresholdMb?: unknown; performanceMode?: unknown };
    if (!body || typeof body !== 'object' || typeof bodyObj.liveRefresh !== 'boolean' || typeof bodyObj.autoMemoryRelief !== 'boolean') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must be { liveRefresh: boolean, autoMemoryRelief: boolean, autoMemoryReliefThresholdMb?: number, autoMemoryReliefRssThresholdMb?: number, performanceMode?: boolean }.',
      );
    }
    if (bodyObj.performanceMode !== undefined && typeof bodyObj.performanceMode !== 'boolean') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Field "performanceMode" must be a boolean when provided.',
      );
    }
    const thresholdMb = typeof bodyObj.autoMemoryReliefThresholdMb === 'number' && !Number.isNaN(bodyObj.autoMemoryReliefThresholdMb)
      ? bodyObj.autoMemoryReliefThresholdMb
      : 20;
    const rssThresholdMb = typeof bodyObj.autoMemoryReliefRssThresholdMb === 'number' && !Number.isNaN(bodyObj.autoMemoryReliefRssThresholdMb)
      ? bodyObj.autoMemoryReliefRssThresholdMb
      : 256;
    // `performanceMode` is optional so older clients (which send only the
    // four original fields) never reset it as a side effect — absent means
    // "keep the stored value".
    const stored = loadCacheSettings();
    const performanceMode = typeof bodyObj.performanceMode === 'boolean'
      ? bodyObj.performanceMode
      : stored.performanceMode;
    const saved = saveCacheSettings({
      liveRefresh: bodyObj.liveRefresh,
      autoMemoryRelief: bodyObj.autoMemoryRelief,
      autoMemoryReliefThresholdMb: thresholdMb,
      autoMemoryReliefRssThresholdMb: rssThresholdMb,
      performanceMode,
    });
    if (deps && saved.performanceMode !== stored.performanceMode) {
      await applyPerformanceProfile(deps, saved.performanceMode);
    }
    return c.json(ok(saved));
  });

  return app;
}
