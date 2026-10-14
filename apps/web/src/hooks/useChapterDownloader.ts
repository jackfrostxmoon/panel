import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BULK_CHAPTER_LIMIT, type Chapter, type PrefetchJob } from '@panel/shared';
import { api, ApiClientError } from '../api/client';
import { newBatchId } from '../download/batchId';
import { sortChaptersForDownload, type ChapterOrder } from '../download/order';

/**
 * Per-chapter download progress.
 *
 * `current` is the number of pages that have already been attempted in this
 * run; `total` is the page count reported by the worker (0 until the job
 * starts). After a chapter finishes, `state` becomes 'done' and the
 * counters stop moving; failed pages still count as `current` (otherwise
 * the UI would never reach `total` and stay stuck mid-bar).
 *
 * `cachedPages` is the total number of pages confirmed on the server's
 * ImageCache at the end of the run — the sum of pages skipped because
 * they were already cached PLUS pages freshly fetched in this run.
 */
export interface ChapterDownloadProgress {
  state: 'idle' | 'fetching-payload' | 'downloading' | 'done' | 'failed' | 'cancelled';
  current: number;
  total: number;
  failedPages: number;
  /** Pages confirmed on disk at the end of the run (skipped + freshly fetched). */
  cachedPages: number;
}

export interface DownloadChaptersOptions {
  /** Pacing between chapters in the batch (worker honors, server-side). */
  chapterIntervalMs?: number;
  /**
   * Pages fetched concurrently within each chapter (worker honors).
   * Resolved by the caller from reader + download settings via
   * `resolveDownloadPageConcurrency` — the hook only forwards it.
   */
  pageConcurrency?: number;
  /**
   * Which end of the chapter list the batch starts from. Applied here rather
   * than trusted from the caller so the enqueue order always matches the
   * direction the user chose, regardless of which entry point started the run
   * or what order the chapter list was displayed in.
   */
  order?: ChapterOrder;
  /** Hold the FIRST chapter back before it becomes claimable. Used by
   *  manual per-row clicks so they honour the same pacing setting as
   *  bulk runs. `0` (default) = start immediately. */
  delayFirstMs?: number;
}

export interface DownloadChaptersResult {
  done: number;
  failed: number;
  cancelled: boolean;
  failedPages: number;
}

/** How often the hook polls GET /api/prefetch/jobs while jobs are tracked. */
const POLL_INTERVAL_MS = 500;

/**
 * No chapter settling for this long while jobs are still tracked reads
 * as stalled — the server is wedged or crawling (throttled source,
 * wedged `running` row) rather than making progress.
 */
export const DOWNLOAD_STALL_AFTER_MS = 120_000;

/**
 * Pure stall check (exported for unit tests): stalled when at least one
 * job is tracked but nothing settled within the threshold.
 */
export function isDownloadStalled(
  activeCount: number,
  lastActivityAtMs: number,
  nowMs: number,
  thresholdMs: number = DOWNLOAD_STALL_AFTER_MS,
): boolean {
  if (activeCount <= 0) return false;
  if (!Number.isFinite(lastActivityAtMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - lastActivityAtMs > thresholdMs;
}

interface TrackedJob {
  jobId: string;
}

interface Waiter {
  chapterIds: string[];
  done: number;
  failed: number;
  failedPages: number;
  cancelled: boolean;
  resolve: (result: DownloadChaptersResult) => void;
}

function terminalProgress(job: PrefetchJob): ChapterDownloadProgress {
  if (job.status === 'cancelled') {
    return {
      state: 'cancelled',
      current: 0,
      total: job.totalPages,
      failedPages: job.failedPages,
      cachedPages: job.cachedPages,
    };
  }
  if (job.status === 'failed') {
    return {
      state: 'failed',
      current: 0,
      total: job.totalPages,
      failedPages: job.failedPages,
      cachedPages: job.cachedPages,
    };
  }
  const failed = job.failedPages > 0;
  return {
    state: failed ? 'failed' : 'done',
    current: Math.max(0, job.totalPages - job.failedPages),
    total: job.totalPages,
    failedPages: job.failedPages,
    cachedPages: job.cachedPages,
  };
}

function liveProgress(job: PrefetchJob): ChapterDownloadProgress {
  if (job.status === 'pending' || job.totalPages === 0) {
    return { state: 'fetching-payload', current: 0, total: 0, failedPages: 0, cachedPages: 0 };
  }
  const current = job.cachedPages + job.failedPages;
  return {
    state: 'downloading',
    current,
    total: job.totalPages,
    failedPages: job.failedPages,
    cachedPages: job.cachedPages,
  };
}

/**
 * Bulk pre-warming of chapter image caches — thin client over the
 * server-side prefetch queue.
 *
 * "Downloading" a chapter means enqueueing a job (POST
 * /api/chapter/:id/prefetch); the API's background worker fetches every
 * page from upstream into its on-disk ImageCache. The phone only ever
 * exchanges small JSON payloads. Because the work lives server-side:
 *
 *  - Refreshing / closing the tab mid-run does NOT kill the batch. On
 *    mount the hook adopts any still-active jobs so progress rebuilds
 *    from a fresh page load. (No `beforeunload` guard anymore.)
 *  - Pacing (`chapterIntervalMs`) is enforced by the worker via
 *    `run_after` timestamps, not by sleeps in this tab.
 *  - `cancel()` flips the server jobs to `cancelled`; pages already
 *    cached stay cached.
 *
 * Progress is rebuilt by polling GET /api/prefetch/jobs every second
 * while at least one job is tracked. Jobs that vanish from the active
 * list are fetched once individually to learn their terminal state.
 */
export function useChapterDownloader() {
  const [progress, setProgress] = useState<Record<string, ChapterDownloadProgress>>({});
  const [activeChapterIds, setActiveChapterIds] = useState<string[]>([]);
  /** Live counter so consumers (toasts, badges) can show "X of N chapters done". */
  const [doneCount, setDoneCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  /**
   * Milliseconds left before the next tracked chapter becomes claimable,
   * or `null` when nothing is waiting. The UI renders this as the
   * "Waiting 1:32 before next chapter…" countdown.
   */
  const [intervalRemainingMs, setIntervalRemainingMs] = useState<number | null>(null);
  /**
   * Last wall-clock time a tracked chapter settled (or a batch started).
   * Drives `isStalled`: while jobs are tracked but nothing settles for
   * `DOWNLOAD_STALL_AFTER_MS`, the UI tells the user the run is stuck
   * instead of showing a silently frozen progress bar.
   */
  const [lastActivityAt, setLastActivityAt] = useState<number>(() => Date.now());

  const queryClient = useQueryClient();
  /** Refresh the persisted per-row badges after runs settle. The
   *  `by-chapters` snapshot query is the only react-query consumer under
   *  this prefix (live polling uses direct `api` calls), so a prefix
   *  invalidate is precisely scoped. */
  const bumpSnapshots = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['prefetch'] });
  }, [queryClient]);

  /** chapterId → server job. Source of truth for the poll loop. */
  const trackedRef = useRef(new Map<string, TrackedJob>());
  /** In-flight `downloadChapters` callers waiting for their chapters. */
  const waitersRef = useRef<Waiter[]>([]);
  /** Last terminal progress per chapter — lets `downloadChapter` return
   *  an honest final value instead of a stale-closure guess. */
  const terminalRef = useRef(new Map<string, ChapterDownloadProgress>());
  /** Synchronous mirrors so `cancel()` (a stable callback) never reads a
   *  stale closure while a batch POST is still in flight. */
  const progressRef = useRef<Record<string, ChapterDownloadProgress>>({});
  progressRef.current = progress;

  const untrack = useCallback((chapterId: string) => {
    trackedRef.current.delete(chapterId);
    setActiveChapterIds((prev) => (prev.includes(chapterId) ? prev.filter((id) => id !== chapterId) : prev));
  }, []);

  const settleWaiters = useCallback(() => {
    const remaining = trackedRef.current;
    for (let i = waitersRef.current.length - 1; i >= 0; i -= 1) {
      const waiter = waitersRef.current[i]!;
      if (waiter.chapterIds.every((id) => !remaining.has(id))) {
        waitersRef.current.splice(i, 1);
        waiter.resolve({
          done: waiter.done,
          failed: waiter.failed,
          cancelled: waiter.cancelled,
          failedPages: waiter.failedPages,
        });
      }
    }
  }, []);

  const settleChapter = useCallback(
    (chapterId: string, job: PrefetchJob) => {
      const final = terminalProgress(job);
      terminalRef.current.set(chapterId, final);
      setProgress((p) => ({ ...p, [chapterId]: final }));
      if (final.state === 'done') {
        setDoneCount((n) => n + 1);
      } else if (final.state === 'failed') {
        setFailedCount((n) => n + 1);
      }
      for (const waiter of waitersRef.current) {
        if (!waiter.chapterIds.includes(chapterId)) continue;
        if (final.state === 'done') waiter.done += 1;
        else if (final.state === 'failed') {
          waiter.failed += 1;
          waiter.failedPages += final.failedPages;
        }
      }
      setLastActivityAt(Date.now());
      untrack(chapterId);
      settleWaiters();
      bumpSnapshots();
    },
    [bumpSnapshots, settleWaiters, untrack],
  );

  const markChapterFailed = useCallback(
    (chapterId: string, failedPages = 0) => {
      const failed: ChapterDownloadProgress = {
        state: 'failed',
        current: 0,
        total: 0,
        failedPages,
        cachedPages: 0,
      };
      terminalRef.current.set(chapterId, failed);
      setProgress((p) => ({ ...p, [chapterId]: failed }));
      setFailedCount((n) => n + 1);
      for (const waiter of waitersRef.current) {
        if (!waiter.chapterIds.includes(chapterId)) continue;
        waiter.failed += 1;
        waiter.failedPages += failedPages;
      }
      setLastActivityAt(Date.now());
      untrack(chapterId);
      settleWaiters();
      bumpSnapshots();
    },
    [bumpSnapshots, settleWaiters, untrack],
  );

  /** One poll tick: merge the active job list into progress, resolve
   *  chapters whose jobs left the active list via parallel fetches. */
  const poll = useCallback(async () => {
    const tracked = trackedRef.current;
    if (tracked.size === 0) {
      setIntervalRemainingMs(null);
      return;
    }
    let active: PrefetchJob[];
    try {
      ({ jobs: active } = await api.getPrefetchJobs());
    } catch {
      // Transient network blip — keep tracking; the next tick retries.
      return;
    }
    const byChapter = new Map(active.map((job) => [job.chapterId, job]));
    const now = Date.now();
    let maxWait: number | null = null;
    // Batch live updates into one state write per tick — the old loop
    // called setProgress per chapter, re-rendering N times every tick.
    const liveUpdates: Record<string, ChapterDownloadProgress> = {};
    const vanished: Array<{ chapterId: string; jobId: string }> = [];
    const settled: Array<{ chapterId: string; job: PrefetchJob }> = [];
    for (const [chapterId, { jobId }] of Array.from(tracked.entries())) {
      const job = byChapter.get(chapterId);
      if (!job) {
        // No job id yet (batch POST still in flight) — keep the
        // optimistic fetching-payload state until the enqueue lands.
        if (!jobId) continue;
        vanished.push({ chapterId, jobId });
        continue;
      }
      if (job.status === 'pending' || job.status === 'running') {
        liveUpdates[chapterId] = liveProgress(job);
        if (job.status === 'pending' && job.runAfter) {
          const wait = new Date(job.runAfter).getTime() - now;
          if (wait > 0) maxWait = maxWait === null ? wait : Math.max(maxWait, wait);
        }
      } else {
        settled.push({ chapterId, job });
      }
    }
    if (Object.keys(liveUpdates).length > 0) {
      setProgress((p) => ({ ...p, ...liveUpdates }));
    }
    for (const { chapterId, job } of settled) {
      settleChapter(chapterId, job);
    }
    if (vanished.length > 0) {
      // Left the active list — fetch terminal states in parallel, not
      // one await per chapter (the old sequential loop took N RTTs to
      // notice N completions).
      const snapshots = await Promise.allSettled(
        vanished.map(async ({ chapterId, jobId }) => ({
          chapterId,
          snapshot: await api.getPrefetchJob(jobId),
        })),
      );
      const vanishedLive: Record<string, ChapterDownloadProgress> = {};
      for (let i = 0; i < snapshots.length; i += 1) {
        const result = snapshots[i]!;
        if (result.status === 'fulfilled') {
          const { chapterId, snapshot } = result.value;
          if (
            snapshot.status === 'completed' ||
            snapshot.status === 'failed' ||
            snapshot.status === 'cancelled'
          ) {
            settleChapter(chapterId, snapshot);
          } else {
            // Still active but missed the list (list/active race) — keep waiting.
            vanishedLive[chapterId] = liveProgress(snapshot);
          }
        } else {
          const reason = (result as PromiseRejectedResult).reason;
          if (reason instanceof ApiClientError && reason.code === 'NOT_FOUND') {
            // Job row is gone (pruned) — count it as failed, not stuck.
            const entry = vanished[i];
            if (entry) markChapterFailed(entry.chapterId);
          }
          // Other errors (network) — retry on the next tick.
        }
      }
      if (Object.keys(vanishedLive).length > 0) {
        setProgress((p) => ({ ...p, ...vanishedLive }));
      }
    }
    setIntervalRemainingMs(maxWait);
  }, [markChapterFailed, settleChapter]);

  // Poll while jobs are tracked. The effect re-arms whenever the tracked
  // set changes size; the body reads the ref so it never goes stale.
  useEffect(() => {
    if (activeChapterIds.length === 0) return;
    const handle = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [activeChapterIds.length, poll]);

  // Adopt still-active jobs on mount so a refresh rebuilds progress
  // instead of losing the run. No waiters — they just display until
  // they settle, and `cancel()` still works on them.
  useEffect(() => {
    let alive = true;
    void api
      .getPrefetchJobs()
      .then(({ jobs }) => {
        if (!alive || jobs.length === 0) return;
        for (const job of jobs) {
          if (!trackedRef.current.has(job.chapterId)) {
            trackedRef.current.set(job.chapterId, { jobId: job.id });
          }
        }
        setActiveChapterIds(Array.from(trackedRef.current.keys()));
        void poll();
      })
      .catch(() => {
        // Server unreachable on load — nothing to adopt.
      });
    return () => {
      alive = false;
    };
  }, [poll]);

  const cancel = useCallback(() => {
    // Includes optimistic placeholders (jobId '') added before the batch
    // POST lands — otherwise Stop during enqueue leaves them stuck in
    // fetching-payload.
    const tracked = Array.from(trackedRef.current.entries());
    if (tracked.length === 0) {
      setIntervalRemainingMs(null);
      return;
    }
    for (const waiter of waitersRef.current) waiter.cancelled = true;
    const jobIds = tracked.map(([, { jobId }]) => jobId).filter((id) => id.length > 0);
    // Optimistic UI: clear locally FIRST so Stop feels instant even for a
    // 200-chapter batch. Server flips happen in the background; the worker
    // notices via the DB + in-memory abort and stops mid-chapter.
    const cancelledPatch: Record<string, ChapterDownloadProgress> = {};
    for (const [chapterId] of tracked) {
      const cur = progressRef.current[chapterId];
      if (cur && (cur.state === 'fetching-payload' || cur.state === 'downloading')) {
        cancelledPatch[chapterId] = { ...cur, state: 'cancelled' };
      }
      untrack(chapterId);
    }
    if (Object.keys(cancelledPatch).length > 0) {
      setProgress((p) => ({ ...p, ...cancelledPatch }));
    }
    setIntervalRemainingMs(null);
    settleWaiters();
    bumpSnapshots();
    if (jobIds.length === 0) return;
    // One round-trip for the whole batch (chunked like the other bulk
    // endpoints). Fire-and-forget — UI already cleared. A late batch-POST
    // that lands after this cancel is re-cancelled by downloadChapters'
    // waiter-cancelled check.
    const CHUNK = 200;
    void (async () => {
      try {
        for (let i = 0; i < jobIds.length; i += CHUNK) {
          const chunk = jobIds.slice(i, i + CHUNK);
          if (chunk.length === 1) await api.cancelPrefetchJob(chunk[0]!);
          else await api.cancelPrefetchJobs(chunk);
        }
      } catch {
        // Best-effort — a retry happens on the next Stop press, and the
        // worker's pacing skips cancelled batches anyway.
      } finally {
        bumpSnapshots();
      }
    })();
  }, [bumpSnapshots, settleWaiters, untrack]);

  const reset = useCallback(() => {
    cancel();
    setProgress({});
    setDoneCount(0);
    setFailedCount(0);
    waitersRef.current = [];
    terminalRef.current.clear();
  }, [cancel]);

  /**
   * Retarget the pacing of the in-flight batch. Called when the user
   * changes the "wait between chapters" preset mid-run — without this the
   * batch keeps the interval snapshotted at enqueue time, so switching
   * Off → 30s while chapter 1 downloads still chains chapter 2 instantly.
   * Pending AND running rows are updated server-side and the worker
   * re-reads the fresh value before each pace. Best-effort: failures are
   * swallowed (the batch simply keeps its enqueue-time pacing).
   */
  const updateInterval = useCallback(async (intervalMs: number) => {
    const jobIds = Array.from(trackedRef.current.values())
      .map(({ jobId }) => jobId)
      .filter((id) => id.length > 0);
    if (jobIds.length === 0) return;
    try {
      await api.setPrefetchJobsInterval(jobIds, Math.max(0, Math.trunc(intervalMs)));
    } catch {
      // Best-effort — the batch keeps its enqueue-time pacing.
    }
  }, []);

  /**
   * Download multiple chapters: enqueue jobs under a shared batch id
   * (worker paces them by `chapterIntervalMs`), then resolve when every
   * chapter settles. Survives page refresh — the returned promise rejects
   * only on enqueue failure, never on reload (a reloaded page has no
   * waiter, but the jobs keep running).
   */
  const downloadChapters = useCallback(
    async (
      chapters: Chapter[],
      options?: DownloadChaptersOptions,
    ): Promise<DownloadChaptersResult> => {
      if (chapters.length === 0) return { done: 0, failed: 0, cancelled: false, failedPages: 0 };
      setDoneCount(0);
      setFailedCount(0);
      setLastActivityAt(Date.now());
      setIntervalRemainingMs(null);
      const intervalMs = Math.max(0, Math.trunc(options?.chapterIntervalMs ?? 0));
      const delayFirstMs = Math.max(0, Math.trunc(options?.delayFirstMs ?? 0));
      const pageConcurrency =
        typeof options?.pageConcurrency === 'number' && Number.isFinite(options.pageConcurrency)
          ? Math.min(16, Math.max(1, Math.trunc(options.pageConcurrency)))
          : 3;
      // Sort BEFORE the waiter is built and before any enqueue, so the job
      // ids, the `created_at` order the worker claims by, and the waiter's
      // chapter list all agree on one sequence.
      const ordered = sortChaptersForDownload(chapters, options?.order ?? 'oldest-first');
      // Never `window.crypto.randomUUID()` directly — it is undefined on
      // insecure origins (plain-LAN HTTP) and throws before any request
      // fires. `newBatchId` falls back to `getRandomValues`.
      const batchId = newBatchId();
      const waiter: Waiter = {
        chapterIds: ordered.map((c) => c.id),
        done: 0,
        failed: 0,
        failedPages: 0,
        cancelled: false,
        resolve: () => {},
      };
      const settled = new Promise<DownloadChaptersResult>((resolve) => {
        waiter.resolve = resolve;
      });
      waitersRef.current.push(waiter);

      // Optimistic start: show every row as fetching + flip isDownloading
      // synchronously so Stop is visible instantly, even for a 200-chapter
      // batch whose enqueue POST hasn't returned yet. Placeholders
      // (jobId '') keep the chapters tracked so a Stop during enqueue
      // clears them instead of leaving orphans.
      const fetchingPatch: Record<string, ChapterDownloadProgress> = {};
      for (const chapter of ordered) {
        fetchingPatch[chapter.id] = {
          state: 'fetching-payload',
          current: 0,
          total: 0,
          failedPages: 0,
          cachedPages: 0,
        };
        if (!trackedRef.current.has(chapter.id)) {
          trackedRef.current.set(chapter.id, { jobId: '' });
        }
      }
      setProgress((p) => ({ ...p, ...fetchingPatch }));
      setActiveChapterIds(Array.from(trackedRef.current.keys()));
      void poll();

      const cancelNewJobs = (jobIds: string[]) => {
        if (jobIds.length === 0) return;
        void (async () => {
          try {
            if (jobIds.length === 1) await api.cancelPrefetchJob(jobIds[0]!);
            else await api.cancelPrefetchJobs(jobIds);
          } catch {
            // Best-effort — jobs stay pending and the next Stop clears them.
          }
        })();
      };

      try {
        if (ordered.length === 1) {
          const chapter = ordered[0]!;
          try {
            const { jobId } = await api.prefetchChapterPages(chapter.id, {
              onlyMissing: true,
              batchId,
              intervalMs,
              delayMs: delayFirstMs,
              pageConcurrency,
            });
            if (waiter.cancelled) {
              // Stop pressed during enqueue — don't leave an orphan running.
              trackedRef.current.delete(chapter.id);
              setActiveChapterIds(Array.from(trackedRef.current.keys()));
              cancelNewJobs([jobId]);
              settleWaiters();
            } else {
              trackedRef.current.set(chapter.id, { jobId });
              setActiveChapterIds(Array.from(trackedRef.current.keys()));
              void poll();
            }
          } catch {
            // A cancel during enqueue already untracked the placeholder;
            // don't resurrect it as failed.
            if (!waiter.cancelled) markChapterFailed(chapter.id);
            else {
              trackedRef.current.delete(chapter.id);
              setActiveChapterIds(Array.from(trackedRef.current.keys()));
              settleWaiters();
            }
          }
        } else {
          // One POST per 200 chapters (server cap) instead of one POST per
          // chapter — start latency stays flat for long series.
          for (let i = 0; i < ordered.length; i += BULK_CHAPTER_LIMIT) {
            if (waiter.cancelled) break;
            const chunk = ordered.slice(i, i + BULK_CHAPTER_LIMIT);
            try {
              const { jobs } = await api.prefetchChaptersBatch(
                chunk.map((c) => c.id),
                { batchId, intervalMs, pageConcurrency },
              );
              const newJobIds: string[] = [];
              const byChapter = new Map(jobs.map((j) => [j.chapterId, j.jobId]));
              for (const chapter of chunk) {
                const jobId = byChapter.get(chapter.id);
                if (jobId) {
                  if (waiter.cancelled) newJobIds.push(jobId);
                  else trackedRef.current.set(chapter.id, { jobId });
                } else if (!waiter.cancelled) {
                  markChapterFailed(chapter.id);
                } else {
                  trackedRef.current.delete(chapter.id);
                }
              }
              if (waiter.cancelled && newJobIds.length > 0) {
                cancelNewJobs(newJobIds);
                for (const chapter of chunk) trackedRef.current.delete(chapter.id);
              }
            } catch {
              // Whole chunk POST failed (network) — mark its chapters failed
              // unless the user already cancelled (then just drop them).
              for (const chapter of chunk) {
                if (waiter.cancelled) trackedRef.current.delete(chapter.id);
                else markChapterFailed(chapter.id);
              }
              // Keep going with the next chunk — one bad slice shouldn't
              // kill a 200-chapter run.
            }
            setActiveChapterIds(Array.from(trackedRef.current.keys()));
            void poll();
          }
          if (waiter.cancelled) settleWaiters();
        }
      } finally {
        setActiveChapterIds(Array.from(trackedRef.current.keys()));
      }
      return settled;
    },
    [markChapterFailed, poll, settleWaiters],
  );

  /**
   * Download the images of one chapter. Resolves with the final
   * progress, or rethrows an AbortError when cancelled.
   */
  const downloadChapter = useCallback(
    async (chapter: Chapter): Promise<ChapterDownloadProgress> => {
      const result = await downloadChapters([chapter]);
      if (result.cancelled) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (result.failed > 0) {
        throw new Error('Some pages failed to warm server-side.');
      }
      return (
        terminalRef.current.get(chapter.id) ?? {
          state: 'done',
          current: 0,
          total: 0,
          failedPages: result.failedPages,
          cachedPages: 0,
        }
      );
    },
    [downloadChapters],
  );

  return {
    /** Live state per chapter id. Empty until you start a download. */
    progress,
    /** Currently-tracked chapter ids (preserves enqueue order). */
    activeChapterIds,
    /** Chapters that finished successfully in the current batch. */
    doneCount,
    /** Chapters that failed in the current batch. */
    failedCount,
    /** True while a batch is running. */
    isDownloading: activeChapterIds.length > 0,
    /**
     * True while jobs are tracked but nothing settled for
     * `DOWNLOAD_STALL_AFTER_MS` — the run is wedged or crawling, not
     * progressing. The actions panel renders a hint from this instead
     * of a silently frozen progress bar.
     */
    isStalled: isDownloadStalled(activeChapterIds.length, lastActivityAt, Date.now()),
    /**
     * Milliseconds left before the next tracked chapter becomes
     * claimable, or `null` when nothing is waiting. The UI renders the
     * "Waiting 1:32 before next chapter…" countdown from this.
     */
    intervalRemainingMs,
    /** Download a single chapter. */
    downloadChapter,
    /** Enqueue a batch under one batch id (worker paces it). */
    downloadChapters,
    /** Cancel every tracked job server-side. Pages already cached stay cached. */
    cancel,
    /**
     * Push a mid-run pacing change to the in-flight batch so the next
     * chapter transition honours the new "wait between chapters" value.
     */
    updateInterval,
    /** Reset all state for a fresh run. */
    reset,
  };
}

export type ChapterDownloader = ReturnType<typeof useChapterDownloader>;
