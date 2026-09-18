import { and, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { prefetchJobs, type PrefetchJobRow, type PrefetchJobStatus } from '../db/schema.js';

/**
 * Repository for the server-side prefetch job queue.
 *
 * Job lifecycle: `pending` → `running` → (one of) `completed` | `failed` |
 * `cancelled`. The worker `claimNext` atomic SELECT … FOR UPDATE SKIP LOCKED
 * prevents two worker instances (or two API replicas) from processing the
 * same job simultaneously. Cancelling a job is a pure state flip — the
 * worker checks `status` between pages and bails out.
 */

export interface EnqueuePrefetchJobInput {
  chapterId: string;
  batchId?: string | null;
  intervalMs?: number;
  onlyMissing?: boolean;
  /** Wait this long after enqueue before the job becomes claimable. */
  delayMs?: number;
}

export interface PrefetchJobSnapshot {
  id: string;
  chapterId: string;
  batchId: string | null;
  status: PrefetchJobStatus;
  totalPages: number;
  cachedPages: number;
  failedPages: number;
  failed: number[];
  runAfter: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function snapshot(row: PrefetchJobRow): PrefetchJobSnapshot {
  return {
    id: row.id,
    chapterId: row.chapterId,
    batchId: row.batchId,
    status: row.status as PrefetchJobStatus,
    totalPages: row.totalPages,
    cachedPages: row.cachedPages,
    failedPages: row.failedPages,
    failed: row.failed,
    runAfter: row.runAfter ? row.runAfter.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

export class PrefetchJobRepository {
  constructor(private readonly db: Database) {}

  /**
   * Enqueue a prefetch job for a chapter. Returns the new row.
   *
   * The partial unique index on (chapter_id) WHERE status IN ('pending',
   * 'running') makes this idempotent while a previous job is still
   * active — if a job for the same chapter already exists, callers
   * should `findActiveByChapter` and use that id instead. We surface the
   * duplicate-key violation as `null` so route handlers can return the
   * existing job rather than 500.
   */
  async enqueue(input: EnqueuePrefetchJobInput): Promise<PrefetchJobSnapshot | null> {
    const delayMs = Math.max(0, Math.trunc(input.delayMs ?? 0));
    try {
      const [row] = await this.db
        .insert(prefetchJobs)
        .values({
          chapterId: input.chapterId,
          batchId: input.batchId ?? null,
          onlyMissing: input.onlyMissing ?? true,
          intervalMs: Math.max(0, Math.trunc(input.intervalMs ?? 0)),
          runAfter: delayMs > 0 ? new Date(Date.now() + delayMs) : null,
        })
        .returning();
      if (!row) return null;
      return snapshot(row);
    } catch (error) {
      // Unique-constraint hit (partial index) — a job for this chapter
      // is already pending or running.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async findActiveByChapter(chapterId: string): Promise<PrefetchJobSnapshot | null> {
    const [row] = await this.db
      .select()
      .from(prefetchJobs)
      .where(
        and(eq(prefetchJobs.chapterId, chapterId), inArray(prefetchJobs.status, ['pending', 'running'])),
      )
      .limit(1);
    return row ? snapshot(row) : null;
  }

  async findById(id: string): Promise<PrefetchJobSnapshot | null> {
    const [row] = await this.db
      .select()
      .from(prefetchJobs)
      .where(eq(prefetchJobs.id, id))
      .limit(1);
    return row ? snapshot(row) : null;
  }

  async findActiveByIds(ids: readonly string[]): Promise<PrefetchJobSnapshot[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(prefetchJobs)
      .where(and(inArray(prefetchJobs.id, ids), inArray(prefetchJobs.status, ['pending', 'running'])));
    return rows.map(snapshot);
  }

  /**
   * Latest job per chapter id (any status), one row per id. Used by the
   * details page to render persisted per-row badges ("12 / 37 cached")
   * after a browser restart, when the in-memory progress map is gone.
   * Chapters with no job row are simply absent from the map. Single
   * round-trip via DISTINCT ON, so even long series stay cheap.
   */
  async findLatestByChapters(chapterIds: readonly string[]): Promise<Map<string, PrefetchJobSnapshot>> {
    const map = new Map<string, PrefetchJobSnapshot>();
    if (chapterIds.length === 0) return map;
    const rows = await this.db
      .selectDistinctOn([prefetchJobs.chapterId])
      .from(prefetchJobs)
      .where(inArray(prefetchJobs.chapterId, chapterIds))
      .orderBy(prefetchJobs.chapterId, desc(prefetchJobs.createdAt));
    for (const row of rows) map.set(row.chapterId, snapshot(row));
    return map;
  }

  /** List every job whose status is `pending` or `running`. Used by the
   *  polling endpoint so the web UI can rebuild its progress view from a
   *  fresh page load without losing active batches. */
  async listActive(): Promise<PrefetchJobSnapshot[]> {
    const rows = await this.db
      .select()
      .from(prefetchJobs)
      .where(inArray(prefetchJobs.status, ['pending', 'running']))
      .orderBy(prefetchJobs.createdAt);
    return rows.map(snapshot);
  }

  /**
   * Crash recovery: flip every job left `running` back to `pending`.
   * A killed API process (SIGKILL, `taskkill /F`, container stop) never
   * runs graceful shutdown, so without this the partial unique index on
   * active chapters would park those chapters forever — re-enqueues would
   * keep returning the dead job's id and no worker would ever finish it.
   * Called once from `PrefetchWorker.start()`. Idempotent, so concurrent
   * API replicas starting together are harmless.
   *
   * Returns the number of jobs requeued.
   */
  async requeueStuck(): Promise<number> {
    const stuck = await this.db
      .update(prefetchJobs)
      .set({ status: 'pending', startedAt: null })
      .where(eq(prefetchJobs.status, 'running'))
      .returning({ id: prefetchJobs.id });
    return stuck.length;
  }

  /** Atomically claim the next DUE pending job for the worker.
   *  Jobs whose `run_after` lies in the future (inter-chapter pacing)
   *  are skipped until their time comes. Uses SELECT … FOR UPDATE SKIP
   *  LOCKED so multiple workers (or multiple API replicas) never
   *  double-process the same row. The transaction flips status to
   *  'running' before committing, so the claim is durable — a crash
   *  between SELECT and UPDATE leaves the row `pending` and the next
   *  worker picks it up. */
  async claimNext(): Promise<PrefetchJobRow | null> {
    return this.db.transaction(async (tx) => {
      const [pending] = await tx
        .select()
        .from(prefetchJobs)
        .where(
          and(
            eq(prefetchJobs.status, 'pending'),
            or(isNull(prefetchJobs.runAfter), lte(prefetchJobs.runAfter, new Date())),
          ),
        )
        .orderBy(prefetchJobs.runAfter, prefetchJobs.createdAt)
        .limit(1)
        .for('update', { skipLocked: true });
      if (!pending) return null;
      const [claimed] = await tx
        .update(prefetchJobs)
        .set({ status: 'running', startedAt: new Date(), runAfter: null })
        .where(eq(prefetchJobs.id, pending.id))
        .returning();
      return claimed ?? null;
    });
  }

  /**
   * Push every still-pending job in a batch forward by `delayMs`. Called
   * by the worker after each completion so the next chapter in the same
   * "Download all" run starts `intervalMs` later — pacing without ever
   * blocking the worker loop on a sleep, and restart-safe (the timestamps
   * survive a crash; the next worker simply waits them out).
   *
   * Returns the number of jobs delayed. Zero means this was the batch's
   * last pending chapter, so no wait is inserted after the final chapter.
   */
  async delayBatch(batchId: string, delayMs: number): Promise<number> {
    if (delayMs <= 0) return 0;
    const runAfter = new Date(Date.now() + delayMs);
    const updated = await this.db
      .update(prefetchJobs)
      .set({ runAfter })
      .where(and(eq(prefetchJobs.batchId, batchId), eq(prefetchJobs.status, 'pending')))
      .returning({ id: prefetchJobs.id });
    return updated.length;
  }

  async setTotalPages(id: string, total: number): Promise<void> {
    await this.db
      .update(prefetchJobs)
      .set({ totalPages: total })
      .where(eq(prefetchJobs.id, id));
  }

  /** Persist a progress update — called after every page (or chunk of
   *  pages) so a polling client sees near-real-time progress without
   *  hammering the worker. `failed` is appended to (not replaced) so a
   *  long-running job can surface new failures incrementally. */
  async updateProgress(
    id: string,
    patch: { cachedPages?: number; failedPages?: number; failed?: number[] },
  ): Promise<void> {
    const set: Partial<typeof prefetchJobs.$inferInsert> = {};
    if (patch.cachedPages !== undefined) set.cachedPages = patch.cachedPages;
    if (patch.failedPages !== undefined) set.failedPages = patch.failedPages;
    if (patch.failed !== undefined) set.failed = patch.failed;
    if (Object.keys(set).length === 0) return;
    await this.db.update(prefetchJobs).set(set).where(eq(prefetchJobs.id, id));
  }

  async complete(id: string, final: { cachedPages: number; failedPages: number; failed: number[] }): Promise<void> {
    await this.db
      .update(prefetchJobs)
      .set({
        status: 'completed',
        cachedPages: final.cachedPages,
        failedPages: final.failedPages,
        failed: final.failed,
        finishedAt: new Date(),
      })
      .where(eq(prefetchJobs.id, id));
  }

  async fail(id: string, error: string): Promise<void> {
    await this.db
      .update(prefetchJobs)
      .set({
        status: 'failed',
        finishedAt: new Date(),
      })
      .where(eq(prefetchJobs.id, id));
    // The `error` string is logged via the worker; storing it would
    // require a dedicated column and isn't surfaced to the UI yet.
    void error;
  }

  /** Flip a `pending`/`running` job to `cancelled`. The worker checks
   *  `status` between pages and stops on sight. */
  async cancel(id: string): Promise<boolean> {
    const [updated] = await this.db
      .update(prefetchJobs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(
        and(eq(prefetchJobs.id, id), inArray(prefetchJobs.status, ['pending', 'running'])),
      )
      .returning({ id: prefetchJobs.id });
    return Boolean(updated);
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  return code === '23505';
}
