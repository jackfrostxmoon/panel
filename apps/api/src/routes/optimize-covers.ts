import { Hono } from 'hono';
import { ErrorCodes, ok } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import type { CoverOptimizer } from '../lib/coverOptimizer.js';

/**
 * Bulk cover re-encoding for the on-disk image cache.
 *
 * POST starts the job (202-style: it returns immediately; the heavy lifting
 * continues in the background) and 409s while a run is already in flight.
 * GET reports the status snapshot the cache-settings page polls. The job
 * state lives in memory only — a restart resets it to `idle`, which is
 * correct: nothing in the cache needs "finishing" after a restart.
 */
export function optimizeCoversRoutes(optimizer: CoverOptimizer): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return c.json(ok(optimizer.getStatus()));
  });

  app.post('/', (c) => {
    if (optimizer.isRunning()) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Cover optimization is already running.',
        undefined,
        409,
      );
    }
    optimizer.start();
    return c.json(ok({ started: true } as const));
  });

  return app;
}
