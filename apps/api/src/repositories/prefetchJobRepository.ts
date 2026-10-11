import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { prefetchJobs, type PrefetchJobRow, type PrefetchJobStatus } from '../db/schema.js';

/**
 * Repository for the server-side prefetch job queue.
 *
 * Job lifecycle: `pending` → `running` → (one of) `completed` | `failed` |
 * `cancelled`. The worker `claimNext` atomically flips the oldest due
 * `pending` row to `running` inside one transaction (guarded by
 * `AND status = 'pending'`), so two worker instances (or two API replicas)
 * never process the same job simultaneously. Cancelling a job is a pure
 * state flip — the worker checks `status` between pages and bails out.
 */

/** Bounds for per-job page concurrency (worker honors). */
export const PREFETCH_PAGE_CONCURRENCY_MIN = 1;
export const PREFETCH_PAGE_CONCURRENCY_MAX = 16;
export const PREFETCH_PAGE_CONCURRENCY_DEFAULT = 3;

/** Clamp a user-supplied page concurrency to the supported range. */
export function clampPageConcurrency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return PREFETCH_PAGE_CONCURRENCY_DEFAULT;
  return Math.min(
    PREFETCH_PAGE_CONCURRENCY_MAX,
    Math.max(PREFETCH_PAGE_CONCURRENCY_MIN, Math.trunc(value)),
  );
}

export interface EnqueuePrefetchJobInput {
  chapterId: string;
  batchId?: string | null;
  intervalMs?: number;
  onlyMissing?: boolean;
  /** Wait this long after enqueue before the job becomes claimable. */
  delayMs?: number;
  /** Pages fetched concurrently within the chapter (worker honors). */
  pageConcurrency?: number;
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
  pageConcurrency: number;
}

function snapshot(row: PrefetchJobRow): PrefetchJobSnapshot {
  // Rows read through a subquery/CTE carry raw integer-ms timestamps —
  // normalize at the boundary.
  const asDate = (value: unknown): Date | null => {
    if (value instanceof Date) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
    return null;
  };
  const createdAt = asDate(row.createdAt) ?? new Date(0);
  // `failed` may arrive as raw JSON text when read through a subquery.
  const failed: number[] = Array.isArray(row.failed)
    ? row.failed
    : typeof row.failed === 'string'
      ? (JSON.parse(row.failed) as number[])
      : [];
  return {
    id: row.id,
    chapterId: row.chapterId,
    batchId: row.batchId,
    status: row.status as PrefetchJobStatus,
    totalPages: row.totalPages,
    cachedPages: row.cachedPages,
    failedPages: row.failedPages,
    failed,
    runAfter: asDate(row.runAfter)?.toISOString() ?? null,
    createdAt: createdAt.toISOString(),
    startedAt: asDate(row.startedAt)?.toISOString() ?? null,
    finishedAt: asDate(row.finishedAt)?.toISOString() ?? null,
    pageConcurrency: clampPageConcurrency(
      typeof row.pageConcurrency === 'number' ? row.pageConcurrency : PREFETCH_PAGE_CONCURRENCY_DEFAULT,
    ),
  };
}

export class PrefetchJobRepository {
  constructor(private readonly db: Database) {}

  /**
   * Enqueue a prefetch job for a chapter. Returns the new row.
   *
   * Duplicate active jobs for the same chapter are rejected at the
   * application level (`findActiveByChapter` check + unique-violation
   * handling here) — if a job for the same chapter already exists, callers
   * should `findActiveByChapter` and use that id instead. We surface the
   * duplicate-key violation as `null` so route handlers can return the
   * existing job rather than 500.
   */
  async enqueue(input: EnqueuePrefetchJobInput): Promise<PrefetchJobSnapshot | null> {
    const delayMs = Math.max(0, Math.trunc(input.delayMs ?? 0));
    // Application-level idempotency: an active job for this chapter means
    // "already queued" — callers fall back to the existing job's id.
    const active = await this.findActiveByChapter(input.chapterId);
    if (active) return null;
    try {
      const [row] = await this.db
        .insert(prefetchJobs)
        .values({
          chapterId: input.chapterId,
          batchId: input.batchId ?? null,
          onlyMissing: input.onlyMissing ?? true,
          intervalMs: Math.max(0, Math.trunc(input.intervalMs ?? 0)),
          pageConcurrency: clampPageConcurrency(input.pageConcurrency),
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

  /**
   * Enqueue many chapters in one call, preserving input order so
   * `created_at` order matches the download order (the worker claims the
   * oldest-due job first). Chapters that already have an active job are
   * returned with `reused: true` instead of inserting a duplicate.
   */
  async enqueueMany(
    chapterIds: readonly string[],
    opts?: { batchId?: string | null; intervalMs?: number; onlyMissing?: boolean; pageConcurrency?: number },
  ): Promise<Array<{ chapterId: string; job: PrefetchJobSnapshot; reused: boolean }>> {
    const results: Array<{ chapterId: string; job: PrefetchJobSnapshot; reused: boolean }> = [];
    if (chapterIds.length === 0) return results;
    const existing = await this.db
      .select()
      .from(prefetchJobs)
      .where(
        and(
          inArray(prefetchJobs.chapterId, [...chapterIds]),
          inArray(prefetchJobs.status, ['pending', 'running']),
        ),
      );
    const activeByChapter = new Map(existing.map((row) => [row.chapterId, snapshot(row)]));
    // Chunk-race hardening: the client enqueues long batches in slices, and
    // a fast first chapter can complete (pushing its batch-mates' `runAfter`
    // into the future) BEFORE a later slice arrives. New rows default to
    // `runAfter = null` (immediately claimable), so without this they would
    // jump the queue ahead of the delayed batch-mates and the pause would
    // appear to not work. Inherit the batch's furthest pending `runAfter`
    // when it still lies in the future.
    let inheritRunAfter: Date | null = null;
    if (opts?.batchId) {
      const pending = await this.db
        .select({ runAfter: prefetchJobs.runAfter })
        .from(prefetchJobs)
        .where(and(eq(prefetchJobs.batchId, opts.batchId), eq(prefetchJobs.status, 'pending')));
      const now = Date.now();
      for (const row of pending) {
        const value: unknown = row.runAfter;
        const when = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : NaN;
        if (Number.isFinite(when) && when > now && (!inheritRunAfter || when > inheritRunAfter.getTime())) {
          inheritRunAfter = new Date(when);
        }
      }
    }
    for (const chapterId of chapterIds) {
      const active = activeByChapter.get(chapterId);
      if (active) {
        results.push({ chapterId, job: active, reused: true });
        continue;
      }
      try {
        const [row] = await this.db
          .insert(prefetchJobs)
          .values({
            chapterId,
            batchId: opts?.batchId ?? null,
            onlyMissing: opts?.onlyMissing ?? true,
            intervalMs: Math.max(0, Math.trunc(opts?.intervalMs ?? 0)),
            pageConcurrency: clampPageConcurrency(opts?.pageConcurrency),
            ...(inheritRunAfter ? { runAfter: inheritRunAfter } : {}),
          })
          .returning();
        if (!row) continue;
        const snap = snapshot(row);
        activeByChapter.set(chapterId, snap);
        results.push({ chapterId, job: snap, reused: false });
      } catch (error) {
        if (isUniqueViolation(error)) {
          const retry = await this.findActiveByChapter(chapterId);
          if (retry) {
            activeByChapter.set(chapterId, retry);
            results.push({ chapterId, job: retry, reused: true });
          }
          continue;
        }
        throw error;
      }
    }
    return results;
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
   * round-trip via a window function (SQLite has no DISTINCT ON), so even
   * long series stay cheap.
   */
  async findLatestByChapters(chapterIds: readonly string[]): Promise<Map<string, PrefetchJobSnapshot>> {
    const map = new Map<string, PrefetchJobSnapshot>();
    if (chapterIds.length === 0) return map;
    const ranked = this.db
      .select({
        id: prefetchJobs.id,
        chapterId: prefetchJobs.chapterId,
        batchId: prefetchJobs.batchId,
        status: prefetchJobs.status,
        onlyMissing: prefetchJobs.onlyMissing,
        totalPages: prefetchJobs.totalPages,
        cachedPages: prefetchJobs.cachedPages,
        failedPages: prefetchJobs.failedPages,
        failed: prefetchJobs.failed,
        intervalMs: prefetchJobs.intervalMs,
        pageConcurrency: prefetchJobs.pageConcurrency,
        runAfter: prefetchJobs.runAfter,
        createdAt: prefetchJobs.createdAt,
        startedAt: prefetchJobs.startedAt,
        finishedAt: prefetchJobs.finishedAt,
        rn: sql<number>`row_number() over (partition by ${prefetchJobs.chapterId} order by ${prefetchJobs.createdAt} desc)`.as(
          'rn',
        ),
      })
      .from(prefetchJobs)
      .where(inArray(prefetchJobs.chapterId, chapterIds))
      .as('ranked');
    const rows = await this.db.select().from(ranked).where(sql`"rn" = 1`);
    for (const row of rows) {
      const { rn: _rn, ...job } = row;
      map.set(job.chapterId, snapshot(job));
    }
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
   * Cold-start stop: flip every job left `pending` or `running` to
   * `cancelled`. A killed + restarted server must NOT resume downloads —
   * the user expects a fresh boot to stop the run (pages already cached
   * stay cached; re-enqueue starts a new run). Called once from
   * `PrefetchWorker.start()`. Idempotent, so concurrent API replicas
   * starting together are harmless.
   *
   * Returns the number of jobs cancelled.
   */
  async cancelActive(): Promise<number> {
    const stopped = await this.db
      .update(prefetchJobs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(inArray(prefetchJobs.status, ['pending', 'running']))
      .returning({ id: prefetchJobs.id });
    return stopped.length;
  }

  /** Atomically claim the next DUE pending job for the worker.
   *  Jobs whose `run_after` lies in the future (inter-chapter pacing)
   *  are skipped until their time comes.
   *
   *  Claim = oldest due `pending` row flipped to `running` inside one
   *  transaction, guarded by `AND status = 'pending'` so two workers (or
   *  two API replicas) racing the same row can't double-process it — only
   *  one UPDATE matches. (The old PostgreSQL build used
   *  `SELECT … FOR UPDATE SKIP LOCKED`; SQLite serialises writers, and the
   *  single-instance lock plus the worker's single-flight flag mean only
   *  one claimant normally exists anyway.)
   *
   *  NOTE: the bun-sqlite driver runs `db.transaction()` callbacks
   *  synchronously, so the transaction is driven explicitly
   *  (BEGIN IMMEDIATE/COMMIT) around the awaited queries instead. */
  async claimNext(): Promise<PrefetchJobRow | null> {
    this.db.$client.exec('BEGIN IMMEDIATE');
    try {
      const [pending] = await this.db
        .select({ id: prefetchJobs.id })
        .from(prefetchJobs)
        .where(
          and(
            eq(prefetchJobs.status, 'pending'),
            or(isNull(prefetchJobs.runAfter), lte(prefetchJobs.runAfter, new Date())),
          ),
        )
        .orderBy(prefetchJobs.runAfter, prefetchJobs.createdAt)
        .limit(1);
      if (!pending) {
        this.db.$client.exec('COMMIT');
        return null;
      }
      const [row] = await this.db
        .update(prefetchJobs)
        .set({ status: 'running', startedAt: new Date(), runAfter: null })
        .where(and(eq(prefetchJobs.id, pending.id), eq(prefetchJobs.status, 'pending')))
        .returning();
      this.db.$client.exec('COMMIT');
      return row ?? null;
    } catch (error) {
      try {
        this.db.$client.exec('ROLLBACK');
      } catch {
        // Already rolled back / no transaction — surface the original error.
      }
      throw error;
    }
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

  /**
   * Mark a job completed — guarded so a concurrent user cancel wins. When
   * the row was already flipped to `cancelled`, this is a no-op and
   * returns false so the worker skips batch pacing.
   */
  async complete(id: string, final: { cachedPages: number; failedPages: number; failed: number[] }): Promise<boolean> {
    const [updated] = await this.db
      .update(prefetchJobs)
      .set({
        status: 'completed',
        cachedPages: final.cachedPages,
        failedPages: final.failedPages,
        failed: final.failed,
        finishedAt: new Date(),
      })
      .where(and(eq(prefetchJobs.id, id), inArray(prefetchJobs.status, ['pending', 'running'])))
      .returning({ id: prefetchJobs.id });
    return Boolean(updated);
  }

  /**
   * Mark a job failed — guarded like `complete` so a user cancel is never
   * overwritten by a late source error.
   */
  async fail(id: string, error: string): Promise<boolean> {
    const [updated] = await this.db
      .update(prefetchJobs)
      .set({
        status: 'failed',
        finishedAt: new Date(),
      })
      .where(and(eq(prefetchJobs.id, id), inArray(prefetchJobs.status, ['pending', 'running'])))
      .returning({ id: prefetchJobs.id });
    // The `error` string is logged via the worker; storing it would
    // require a dedicated column and isn't surfaced to the UI yet.
    void error;
    return Boolean(updated);
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

  /**
   * Flip many jobs to `cancelled` in a single UPDATE — the fast path for
   * "Stop downloads" on a large batch. Without this the client fires one
   * POST per chapter and the UI waits behind the browser's ~6-connection
   * limit. Returns the number of jobs flipped.
   */
  async cancelMany(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const updated = await this.db
      .update(prefetchJobs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(inArray(prefetchJobs.id, [...ids]), inArray(prefetchJobs.status, ['pending', 'running'])))
      .returning({ id: prefetchJobs.id });
    return updated.length;
  }

  /** True when the job row is currently `cancelled` (or gone). */
  async isCancelled(id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ status: prefetchJobs.status })
      .from(prefetchJobs)
      .where(eq(prefetchJobs.id, id))
      .limit(1);
    if (!row) return true;
    return row.status === 'cancelled';
  }

  /**
   * Retarget the pacing of in-flight jobs. The user changed the "wait
   * between chapters" setting mid-run: pending AND running rows adopt the
   * new `intervalMs` so the very next chapter transition honours it (the
   * worker re-reads the fresh value at pacing time instead of trusting its
   * claim-time snapshot). Dropping back to 0 additionally releases jobs
   * already held by an earlier wait (`runAfter` cleared) so the rest of the
   * batch starts immediately. Returns the number of jobs updated.
   */
  async setJobsInterval(ids: readonly string[], intervalMs: number): Promise<number> {
    if (ids.length === 0) return 0;
    const interval = Math.max(0, Math.trunc(intervalMs));
    const updated = await this.db
      .update(prefetchJobs)
      .set({
        intervalMs: interval,
        ...(interval === 0 ? { runAfter: null } : {}),
      })
      .where(and(inArray(prefetchJobs.id, [...ids]), inArray(prefetchJobs.status, ['pending', 'running'])))
      .returning({ id: prefetchJobs.id });
    return updated.length;
  }

  /**
   * Fresh pacing value for one job. The worker calls this at pacing time so
   * a mid-run setting change (applied via `setJobsInterval`) takes effect
   * on the next transition. Returns null when the row is gone (caller falls
   * back to its claim-time snapshot).
   */
  async getIntervalMs(id: string): Promise<number | null> {
    const [row] = await this.db
      .select({ intervalMs: prefetchJobs.intervalMs })
      .from(prefetchJobs)
      .where(eq(prefetchJobs.id, id))
      .limit(1);
    return row ? row.intervalMs : null;
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  // PostgreSQL (legacy) + SQLite constraint codes.
  return (
    code === '23505' ||
    code === 'SQLITE_CONSTRAINT' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
  );
}
