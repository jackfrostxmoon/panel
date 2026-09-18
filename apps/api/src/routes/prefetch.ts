import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { ErrorCodes, isGlobalId, ok } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import type { Database } from '../db/client.js';
import { PrefetchJobRepository } from '../repositories/prefetchJobRepository.js';

/**
 * Prefetch job management routes (status, cancel, batch id).
 *
 * Mounted at `/api/prefetch` from `apps/api/src/app.ts`. The web UI uses
 * these to:
 *
 *   - GET  /api/prefetch/jobs          — rebuild progress view on page load
 *   - GET  /api/prefetch/jobs/:id      — fetch a single snapshot
 *   - POST /api/prefetch/jobs/:id/cancel — abort an in-flight job
 *   - POST /api/prefetch/batch-id      — mint a fresh batch id for a multi-chapter run
 *
 * The actual enqueue lives on POST /api/chapter/:id/prefetch (chapters.ts)
 * because it's keyed on the chapter id.
 */
export function prefetchRoutes(db: Database): Hono {
  const app = new Hono();
  const repo = new PrefetchJobRepository(db);

  app.get('/jobs', async (c) => {
    const jobs = await repo.listActive();
    return c.json(ok({ jobs }));
  });

  /**
   * GET /api/prefetch/jobs/by-chapters?ids=<csv> — latest job per chapter
   * id (any status), as `{ jobs: Record<chapterId, PrefetchJob> }`.
   * Chapters with no job row are absent. The details page uses this to
   * render persisted per-row badges ("12 / 37 cached") after a browser
   * restart, when the downloader's in-memory progress map is gone.
   * Must stay above `/jobs/:id` so "by-chapters" isn't parsed as an id.
   */
  app.get('/jobs/by-chapters', async (c) => {
    const raw = c.req.query('ids') ?? '';
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (ids.length === 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Query parameter "ids" must list at least one chapter id.');
    }
    if (ids.length > 1000) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Query parameter "ids" must list at most 1000 chapter ids.');
    }
    for (const id of ids) {
      if (!isGlobalId(id)) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed chapter id.', { id });
      }
    }
    const map = await repo.findLatestByChapters(ids);
    return c.json(ok({ jobs: Object.fromEntries(map) }));
  });

  app.get('/jobs/:id', async (c) => {
    const id = c.req.param('id');
    const job = await repo.findById(id);
    if (!job) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'Prefetch job not found.', { id });
    }
    return c.json(ok(job));
  });

  app.post('/jobs/:id/cancel', async (c) => {
    const id = c.req.param('id');
    const cancelled = await repo.cancel(id);
    return c.json(ok({ cancelled }));
  });

  app.post('/batch-id', async (c) => {
    return c.json(ok({ batchId: randomUUID() }));
  });

  return app;
}
