import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Chapter, PrefetchJob } from '@panel/shared';
import { api, ApiClientError } from '../api/client';
import { newBatchId } from '../download/batchId';

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
const POLL_INTERVAL_MS = 1000;

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
      untrack(chapterId);
      settleWaiters();
      bumpSnapshots();
    },
    [bumpSnapshots, settleWaiters, untrack],
  );

  /** One poll tick: merge the active job list into progress, resolve
   *  chapters whose jobs left the active list via a single fetch. */
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
    for (const [chapterId, { jobId }] of Array.from(tracked.entries())) {
      const job = byChapter.get(chapterId);
      if (!job) {
        // Left the active list — fetch once for the terminal state.
        try {
          const snapshot = await api.getPrefetchJob(jobId);
          if (
            snapshot.status === 'completed' ||
            snapshot.status === 'failed' ||
            snapshot.status === 'cancelled'
          ) {
            settleChapter(chapterId, snapshot);
            continue;
          }
          // Still active but missed the list (list/active race) — keep waiting.
          setProgress((p) => ({ ...p, [chapterId]: liveProgress(snapshot) }));
        } catch (error) {
          if (error instanceof ApiClientError && error.code === 'NOT_FOUND') {
            // Job row is gone (pruned) — count it as failed, not stuck.
            markChapterFailed(chapterId);
          }
          // Other errors (network) — retry on the next tick.
        }
        continue;
      }
      if (job.status === 'pending' || job.status === 'running') {
        setProgress((p) => ({ ...p, [chapterId]: liveProgress(job) }));
        if (job.status === 'pending' && job.runAfter) {
          const wait = new Date(job.runAfter).getTime() - now;
          if (wait > 0) maxWait = maxWait === null ? wait : Math.max(maxWait, wait);
        }
      } else {
        settleChapter(chapterId, job);
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
    const tracked = Array.from(trackedRef.current.entries());
    if (tracked.length === 0) {
      setIntervalRemainingMs(null);
      return;
    }
    for (const waiter of waitersRef.current) waiter.cancelled = true;
    // Best-effort: flip every tracked job server-side, then mark them
    // cancelled locally. Jobs that already finished settle via the poll.
    void Promise.allSettled(tracked.map(([, { jobId }]) => api.cancelPrefetchJob(jobId))).then(
      () => {
        for (const [chapterId] of tracked) {
          if (!trackedRef.current.has(chapterId)) continue;
          setProgress((p) => {
            const cur = p[chapterId];
            if (cur && (cur.state === 'fetching-payload' || cur.state === 'downloading')) {
              return { ...p, [chapterId]: { ...cur, state: 'cancelled' } };
            }
            return p;
          });
          untrack(chapterId);
        }
        setIntervalRemainingMs(null);
        settleWaiters();
        bumpSnapshots();
      },
    );
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
   * Download multiple chapters: enqueue one job per chapter under a
   * shared batch id (worker paces them by `chapterIntervalMs`), then
   * resolve when every chapter settles. Survives page refresh — the
   * returned promise rejects only on enqueue failure, never on reload
   * (a reloaded page has no waiter, but the jobs keep running).
   */
  const downloadChapters = useCallback(
    async (
      chapters: Chapter[],
      options?: DownloadChaptersOptions,
    ): Promise<DownloadChaptersResult> => {
      if (chapters.length === 0) return { done: 0, failed: 0, cancelled: false, failedPages: 0 };
      setDoneCount(0);
      setFailedCount(0);
      setIntervalRemainingMs(null);
      const intervalMs = Math.max(0, Math.trunc(options?.chapterIntervalMs ?? 0));
      const delayFirstMs = Math.max(0, Math.trunc(options?.delayFirstMs ?? 0));
      // Never `window.crypto.randomUUID()` directly — it is undefined on
      // insecure origins (plain-LAN HTTP) and throws before any request
      // fires. `newBatchId` falls back to `getRandomValues`.
      const batchId = newBatchId();
      const waiter: Waiter = {
        chapterIds: chapters.map((c) => c.id),
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

      // Enqueue sequentially so `created_at` order matches chapter order
      // (the worker claims the earliest-due job first). A single failure
      // marks just that chapter failed — the rest still enqueue.
      for (let i = 0; i < chapters.length; i += 1) {
        const chapter = chapters[i]!;
        setProgress((p) => ({
          ...p,
          [chapter.id]: {
            state: 'fetching-payload',
            current: 0,
            total: 0,
            failedPages: 0,
            cachedPages: 0,
          },
        }));
        try {
          const { jobId } = await api.prefetchChapterPages(chapter.id, {
            onlyMissing: true,
            batchId,
            intervalMs,
            delayMs: i === 0 ? delayFirstMs : 0,
          });
          trackedRef.current.set(chapter.id, { jobId });
        } catch {
          markChapterFailed(chapter.id);
        }
      }
      setActiveChapterIds(Array.from(trackedRef.current.keys()));
      void poll();
      return settled;
    },
    [markChapterFailed, poll],
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
    /** Reset all state for a fresh run. */
    reset,
  };
}

export type ChapterDownloader = ReturnType<typeof useChapterDownloader>;
