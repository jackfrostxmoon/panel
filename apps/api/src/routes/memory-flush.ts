import { Hono } from 'hono';
import { ok } from '@panel/shared';
import type { PanelService } from '../services/panelService.js';
import type { ImageCache } from '../lib/imageCache.js';
import { logger } from '../lib/logger.js';

export interface MemoryFlushResult {
  flushed: boolean;
  panelCacheCleared: boolean;
  imageIndexDropped: boolean;
  memoryBeforeBytes?: number;
  memoryAfterBytes?: number;
}

export function memoryFlushRoutes(
  panelService: PanelService,
  imageCache: ImageCache,
): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    const before = process.memoryUsage();
    const beforeHeap = before.heapUsed;

    try {
      panelService.clearCache();
      imageCache.dropMemoryIndex();

      const after = process.memoryUsage();
      logger.info('Memory flush executed', {
        heapBeforeBytes: beforeHeap,
        heapAfterBytes: after.heapUsed,
      });

      return c.json(
        ok<MemoryFlushResult>({
          flushed: true,
          panelCacheCleared: true,
          imageIndexDropped: true,
          memoryBeforeBytes: beforeHeap,
          memoryAfterBytes: after.heapUsed,
        }),
      );
    } catch (error) {
      logger.error('Memory flush failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Flush failed');
    }
  });

  return app;
}
