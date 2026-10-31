import { Hono } from 'hono';
import { ErrorCodes, isGlobalId, ok } from '@panel/shared';
import { AppError } from '../lib/errors.js';
import type { Database } from '../db/client.js';
import type { PanelService } from '../services/panelService.js';
import type { PrefetchWorker } from '../lib/prefetchWorker.js';
import { clampPageConcurrency, PrefetchJobRepository } from '../repositories/prefetchJobRepository.js';

/** `batch_id` is a uuid column — reject malformed values with a 400
 *  instead of leaking a Postgres error as a 500. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Chapter endpoints: metadata, reader pages, and the server-side prefetch
 * queue. The synchronous cache-warm endpoint that lived here previously
 * has been replaced by a job-based flow:
 *
 *   POST /api/chapter/:id/prefetch → enqueue (returns jobId immediately)
 *
 * The worker (`apps/api/src/lib/prefetchWorker.ts`) drains the queue and
 * survives browser refresh / tab close / API restart. Status / cancel live
 * in `prefetchJobRoutes` mounted at `/api/prefetch`.
 */
export function chapterRoutes(
  panelService: PanelService,
  db: Database,
  opts?: { worker?: Pick<PrefetchWorker, 'tick'> },
): Hono {
  const app = new Hono();

  // GET /api/chapter/:id
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    if (!isGlobalId(id)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed chapter id.', { id });
    }
    return c.json(ok(await panelService.getChapter(id)));
  });

  // GET /api/chapter/:id/pages
  app.get('/:id/pages', async (c) => {
    const id = c.req.param('id');
    if (!isGlobalId(id)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed chapter id.', { id });
    }
    const serverPref = c.req.query('mkServer') ?? undefined;
    const opts = serverPref ? { serverPreference: serverPref } : undefined;
    return c.json(ok(await panelService.getChapterPages(id, opts)));
  });

  /**
   * POST /api/chapter/:id/prefetch — enqueue an image-cache warm.
   *
   * Body (optional): `{ onlyMissing?: boolean, batchId?: string,
   * intervalMs?: number, delayMs?: number, pageConcurrency?: number }`.
   * `batchId` should be shared by every chapter in the same "Download all"
   * run so the worker can honour `intervalMs` between consecutive chapters
   * in that batch. `delayMs` holds a single job back before it becomes
   * claimable — used by manual per-row clicks to honour the same pacing
   * setting. `pageConcurrency` follows the reader's image loading width
   * (parallel = 8, sequential = preloadAhead, data-saver = 1).
   *
   * Returns `{ jobId }` immediately. The actual fetch + write happens
   * asynchronously in the background worker; the web UI polls
   * `GET /api/prefetch/jobs` for live progress.
   *
   * Idempotent: if a job for this chapter is already `pending` or
   * `running`, returns the existing `jobId` rather than creating a
   * duplicate (checked in the repository before insert).
   */
  app.post('/:id/prefetch', async (c) => {
    const id = c.req.param('id');
    if (!isGlobalId(id)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed chapter id.', { id });
    }
    let body: {
      onlyMissing?: unknown;
      batchId?: unknown;
      intervalMs?: unknown;
      delayMs?: unknown;
      pageConcurrency?: unknown;
    } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      // No/invalid body — fall back to defaults below.
    }
    // Validation lives OUTSIDE the JSON-parse try/catch so AppErrors
    // propagate to the error handler instead of being swallowed into
    // defaults.
    const onlyMissing = body.onlyMissing !== undefined ? body.onlyMissing !== false : true;
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
    const delayMs =
      typeof body.delayMs === 'number' && Number.isFinite(body.delayMs)
        ? Math.max(0, Math.trunc(body.delayMs))
        : 0;
    const pageConcurrency = clampPageConcurrency(
      typeof body.pageConcurrency === 'number' ? body.pageConcurrency : undefined,
    );

    const repo = new PrefetchJobRepository(db);
    const existing = await repo.findActiveByChapter(id);
    if (existing) {
      if (opts?.worker) void opts.worker.tick().catch(() => {});
      return c.json(ok({ jobId: existing.id, reused: true }));
    }
    const created = await repo.enqueue({
      chapterId: id,
      batchId,
      intervalMs,
      onlyMissing,
      delayMs,
      pageConcurrency,
    });
    if (!created) {
      // Race: another request enqueued between our existence check and
      // our insert. Re-fetch and return whichever row the partial index
      // kept.
      const existing2 = await repo.findActiveByChapter(id);
      if (existing2) return c.json(ok({ jobId: existing2.id, reused: true }));
      throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Failed to enqueue prefetch job.');
    }
    // Wake the drain loop immediately — otherwise a single-chapter
    // download waits out the 500ms tick before the first page fetches.
    if (opts?.worker) void opts.worker.tick().catch(() => {});
    return c.json(ok({ jobId: created.id, reused: false }));
  });

  return app;
}
