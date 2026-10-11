import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { BULK_CHAPTER_LIMIT, ErrorCodes, isGlobalId, ok } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import type { Database } from '../db/client.js';
import type { PrefetchWorker } from '../lib/prefetchWorker.js';
import { clampPageConcurrency, PrefetchJobRepository } from '../repositories/prefetchJobRepository.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
export function prefetchRoutes(
  db: Database,
  opts?: { worker?: Pick<PrefetchWorker, 'tick' | 'cancelInflight'> },
): Hono {
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

  /**
   * POST /api/prefetch/jobs/batch — enqueue many chapters in one
   * round-trip. The old client fired one POST per chapter sequentially,
   * so "Download all" on a long series spent seconds just enqueuing
   * before the first page fetched. One POST keeps start latency flat.
   * Wakes the worker immediately so the first job doesn't wait out the
   * 500ms tick interval.
   */
  app.post('/jobs/batch', async (c) => {
    let body: {
      chapters?: unknown;
      batchId?: unknown;
      intervalMs?: unknown;
      onlyMissing?: unknown;
      pageConcurrency?: unknown;
    } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      // Falls through to validation below.
    }
    const chapters = Array.isArray(body.chapters) ? body.chapters : [];
    if (chapters.length === 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Body "chapters" must list at least one chapter id.');
    }
    if (chapters.length > BULK_CHAPTER_LIMIT) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Body "chapters" must list at most ${BULK_CHAPTER_LIMIT} chapter ids.`,
      );
    }
    for (const id of chapters) {
      if (typeof id !== 'string' || !isGlobalId(id)) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed chapter id.', { id });
      }
    }
    let batchId: string | null = null;
    if (typeof body.batchId === 'string' && body.batchId.length > 0) {
      if (!UUID_RE.test(body.batchId)) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Parameter "batchId" must be a UUID.');
      }
      batchId = body.batchId;
    }
    const intervalMs =
      typeof body.intervalMs === 'number' && Number.isFinite(body.intervalMs)
        ? Math.max(0, Math.trunc(body.intervalMs))
        : 0;
    const onlyMissing = body.onlyMissing !== undefined ? body.onlyMissing !== false : true;
    const pageConcurrency = clampPageConcurrency(
      typeof body.pageConcurrency === 'number' ? body.pageConcurrency : undefined,
    );
    const results = await repo.enqueueMany(chapters as string[], {
      batchId,
      intervalMs,
      onlyMissing,
      pageConcurrency,
    });
    // Wake the drain loop without waiting out the interval — fire and
    // forget so the enqueue response stays fast even when the worker is
    // busy (tick no-ops while processing).
    if (opts?.worker) void opts.worker.tick().catch(() => {});
    return c.json(
      ok({
        jobs: results.map(({ chapterId, job, reused }) => ({ chapterId, jobId: job.id, reused })),
      }),
    );
  });

  /**
   * POST /api/prefetch/jobs/cancel-many — flip many jobs in one UPDATE.
   * "Stop downloads" on a large batch used to fire one POST per chapter
   * and wait behind the browser's connection limit; one POST stops the
   * whole run. Also aborts the in-flight job in memory so the running
   * chapter stops within its current page batch.
   */
  app.post('/jobs/cancel-many', async (c) => {
    let body: { jobIds?: unknown } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      // Falls through to validation below.
    }
    const jobIds = Array.isArray(body.jobIds) ? body.jobIds : [];
    if (jobIds.length === 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Body "jobIds" must list at least one job id.');
    }
    if (jobIds.length > BULK_CHAPTER_LIMIT) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Body "jobIds" must list at most ${BULK_CHAPTER_LIMIT} job ids.`,
      );
    }
    const ids = jobIds as string[];
    opts?.worker?.cancelInflight(ids);
    const cancelled = await repo.cancelMany(ids);
    return c.json(ok({ cancelled }));
  });

  app.post('/jobs/:id/cancel', async (c) => {
    const id = c.req.param('id');
    opts?.worker?.cancelInflight([id]);
    const cancelled = await repo.cancel(id);
    return c.json(ok({ cancelled }));
  });

  /**
   * POST /api/prefetch/jobs/interval — retarget the pacing of in-flight
   * jobs. The details page sends this when the user changes the "wait
   * between chapters" preset mid-run: without it the batch keeps the
   * interval snapshotted at enqueue time, so switching Off → 30s while
   * chapter 1 downloads still chains chapter 2 instantly. Pending AND
   * running rows are updated (the worker re-reads the fresh value before
   * each pace); dropping back to 0 also releases jobs already held by an
   * earlier wait so the rest of the batch starts immediately.
   */
  app.post('/jobs/interval', async (c) => {
    let body: { jobIds?: unknown; intervalMs?: unknown } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      // Falls through to validation below.
    }
    const jobIds = Array.isArray(body.jobIds) ? body.jobIds : [];
    if (jobIds.length === 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Body "jobIds" must list at least one job id.');
    }
    if (jobIds.length > BULK_CHAPTER_LIMIT) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Body "jobIds" must list at most ${BULK_CHAPTER_LIMIT} job ids.`,
      );
    }
    const intervalMs =
      typeof body.intervalMs === 'number' && Number.isFinite(body.intervalMs)
        ? Math.max(0, Math.trunc(body.intervalMs))
        : 0;
    const updated = await repo.setJobsInterval(jobIds as string[], intervalMs);
    return c.json(ok({ updated }));
  });

  app.post('/batch-id', async (c) => {
    return c.json(ok({ batchId: randomUUID() }));
  });

  return app;
}
