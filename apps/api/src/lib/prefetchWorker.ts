import type { Database } from '../db/client.js';
import { logger } from './logger.js';
import type { ImageCache } from './imageCache.js';
import type { PanelService } from '../services/panelService.js';
import type { SourceRegistry } from '../sources/registry.js';
import { PrefetchJobRepository } from '../repositories/prefetchJobRepository.js';
import type { PrefetchJobRow } from '../db/schema.js';

/**
 * Background worker that drains the `prefetch_jobs` queue.
 *
 * Started once per API process (from `apps/api/src/index.ts`) and stopped
 * on graceful shutdown. A single instance per process is sufficient for
 * the local single-user app — multiple API replicas would coordinate via
 * the atomic `claimNext` (only one UPDATE can win a pending row).
 *
 * Loop:
 *   1. `claimNext()` — atomic transition `pending` → `running`.
 *   2. Resolve the chapter pages (live source via the source registry,
 *      offline fallback to the `chapter_pages` DB cache — same path the
 *      synchronous prefetch endpoint already uses).
 *   3. Probe ImageCache for already-cached pages (when `onlyMissing`).
 *   4. Fetch the missing pages in parallel chunks (concurrency =
 *      the job's `page_concurrency`, following the reader's image loading
 *      width) via the source adapters; persist counters after each chunk
 *      so the polled web UI sees live progress.
 *   5. Mark the job `completed` / `failed`. If the status was flipped to
 *      `cancelled` mid-run (by the user via DELETE /api/prefetch/jobs/:id),
 *      mark it `cancelled` and stop without an error.
 *
 * Pacing: after each completion the worker pushes the remaining
 * pending jobs in the same `batchId` forward by `intervalMs`
 * (`run_after`). The loop itself never sleeps — other batches' jobs stay
 * claimable while one batch waits — and pacing survives a restart
 * because the timestamps live in the database, not in memory.
 */

/**
 * Fallback pages-in-flight when a job row predates the `page_concurrency`
 * column (or carries an out-of-range value). New jobs always store a
 * clamped 1–16 value following the reader's image loading width.
 */
export const PREFETCH_PAGE_CONCURRENCY_FALLBACK = 3;
const PROGRESS_PERSIST_EVERY = 3;

/** Internal control-flow error: the user cancelled mid-run. Never surfaced. */
class JobCancelledError extends Error {
  constructor() {
    super('job cancelled');
    this.name = 'JobCancelledError';
  }
}

export interface PrefetchWorkerDeps {
  db: Database;
  registry: SourceRegistry;
  imageCache: ImageCache;
  panelService: PanelService;
}

export class PrefetchWorker {
  private readonly repo: PrefetchJobRepository;
  private running = false;
  private stopRequested = false;
  private inflightAbort: AbortController | null = null;
  private inflightJobId: string | null = null;
  /**
   * Guard against overlapping ticks. The tick interval fires every
   * 500ms but a single chapter can take minutes; without this flag a
   * second tick would claim (and process) a second job concurrently.
   * The queue is intentionally single-flight per process.
   */
  private processing = false;

  constructor(private readonly deps: PrefetchWorkerDeps) {
    this.repo = new PrefetchJobRepository(deps.db);
  }

  /** Start the drain loop. First cancels jobs stranded `pending`/`running`
   *  by a previous run (see `cancelActive`) — a cold start stops downloads
   *  instead of resuming them — then returns. The loop itself runs on the
   *  API's setInterval so HTTP requests aren't blocked. */
  async start(): Promise<void> {
    if (this.running) return;
    const cancelled = await this.repo.cancelActive();
    if (cancelled > 0) logger.info('PrefetchWorker cancelled active jobs on startup', { cancelled });
    this.running = true;
    this.stopRequested = false;
    logger.info('PrefetchWorker started');
  }

  /** Request graceful shutdown. The in-flight job finishes its current
   *  page batch, then the loop exits before claiming the next job. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopRequested = true;
    this.inflightAbort?.abort();
    logger.info('PrefetchWorker stop requested');
  }

  /**
   * Abort the in-flight job when it matches one of the given ids. Called
   * synchronously from the cancel routes so "Stop downloads" interrupts
   * the running chapter within its current page batch instead of letting
   * it run to completion. Pending jobs need no abort — the DB flip alone
   * keeps them unclaimable. The worker's DB-cancel checks below are the
   * backstop when this in-memory signal misses (e.g. multi-process).
   */
  cancelInflight(jobIds: readonly string[]): void {
    if (this.inflightJobId && jobIds.includes(this.inflightJobId)) {
      this.inflightAbort?.abort();
    }
  }

  /** Called from the API's setInterval. No-ops when the worker has
   *  nothing to do, is shutting down, or is already processing a job. */
  async tick(): Promise<void> {
    if (!this.running || this.stopRequested || this.processing) return;
    this.processing = true;
    try {
      const claimed = await this.repo.claimNext();
      if (!claimed) return;
      await this.process(claimed);
    } finally {
      this.processing = false;
    }
  }

  private async process(job: PrefetchJobRow): Promise<void> {
    const controller = new AbortController();
    this.inflightAbort = controller;
    this.inflightJobId = job.id;
    const jobId = job.id;
    const chapterId = job.chapterId;
    const log = (msg: string, ctx?: Record<string, unknown>) =>
      logger.info(`[prefetch ${jobId.slice(0, 8)}] ${msg}`, { chapterId, ...ctx });

    log('claimed', { batchId: job.batchId, onlyMissing: job.onlyMissing, pageConcurrency: job.pageConcurrency });

    // `0` until the page list resolves. Doubles as the "did we learn the
    // chapter size" flag for the pacing decision below: a job-level
    // failure leaves it at 0, which correctly still paces the batch.
    let total = 0;
    let cachedPages = 0;
    let failedPages = 0;
    /** Successful upstream fetches (excludes pages skipped as cached). */
    let fetched = 0;
    const failed: number[] = [];
    let lastPersist = 0;

    const isCancelRequested = async (): Promise<boolean> => {
      if (controller.signal.aborted) return true;
      // DB flip from the cancel routes (pending/running → cancelled). The
      // in-memory abort covers the single-process fast path; this covers
      // every other path and is cheap on local SQLite.
      try {
        return await this.repo.isCancelled(jobId);
      } catch {
        return controller.signal.aborted;
      }
    };

    try {
      const payload = await this.deps.panelService.getChapterPages(chapterId);
      if (await isCancelRequested()) {
        await this.markCancelled(jobId, { cachedPages, failedPages, failed });
        log('cancelled before start');
        return;
      }
      const chapterTag = payload.chapterId || chapterId;
      const pages = payload.pages;
      total = pages.length;

      if (await isCancelRequested()) {
        await this.markCancelled(jobId, { cachedPages, failedPages, failed });
        log('cancelled before start');
        return;
      }
      await this.repo.setTotalPages(jobId, total);

      if (total === 0) {
        const completed = await this.repo.complete(jobId, { cachedPages: 0, failedPages: 0, failed: [] });
        log(completed ? 'completed (empty chapter)' : 'cancelled (empty chapter)');
        return;
      }

      const fallbackPrefix = chapterId.includes(':') ? chapterId.split(':')[0]! : null;

      // Warm the panel cover too, tagged with the GLOBAL panel id — the
      // same bucket the details page requests
      // (`getProxiedImageUrl(source, coverUrl, 'cover', panelId)`). Without
      // this, "download all → clear image cache → offline" leaves every
      // cover a disk miss, so homepage/detail/bookmark covers break even
      // though the chapter pages themselves read fine. Best-effort: a
      // cover failure never fails the job.
      const panelGlobalId = chapterId.slice(0, chapterId.lastIndexOf('~'));
      if (payload.coverUrl && panelGlobalId && panelGlobalId !== chapterId) {
        try {
          let coverUpstream = payload.coverUrl;
          let coverSource: string | null = fallbackPrefix;
          if (coverUpstream.startsWith('/api/source-image')) {
            const parsed = new URL(coverUpstream, 'http://localhost');
            const u = parsed.searchParams.get('u');
            const s = parsed.searchParams.get('source');
            if (u) coverUpstream = decodeURIComponent(u);
            if (s) coverSource = s;
          }
          const coverUrl = coverUpstream.replace(/[?&]_retry=\d+/, '');
          const source = coverSource ? this.deps.registry.get(coverSource) : null;
          if (source?.fetchImage) {
            await this.deps.imageCache.getOrCreate(
              coverUrl,
              () => source.fetchImage!(coverUrl),
              'cover',
              panelGlobalId,
              null,
            );
            log('cover warmed', { panelGlobalId });
          }
        } catch (error) {
          logger.warn('prefetch cover failed', {
            jobId,
            chapterId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const targets = pages.map((page, position) => {
        const pageIdx = typeof page.index === 'number' ? page.index : position;
        let sourceName: string | null = page.source ?? fallbackPrefix;
        let upstreamUrl = page.url;
        if (page.url.startsWith('/api/source-image')) {
          try {
            const parsed = new URL(page.url, 'http://localhost');
            const u = parsed.searchParams.get('u');
            const s = parsed.searchParams.get('source');
            if (u) upstreamUrl = u;
            if (s) sourceName = s;
          } catch {
            // Keep raw values — the fetch below will fail and count as failed.
          }
        }
        const cacheUrl = upstreamUrl.replace(/[?&]_retry=\d+/, '');
        return { pageIdx, sourceName, cacheUrl };
      });

      if (await isCancelRequested()) {
        await this.markCancelled(jobId, { cachedPages, failedPages, failed });
        log('cancelled before fetch');
        return;
      }

      let skip = new Set<number>();
      if (job.onlyMissing) {
        const probes = await Promise.all(
          targets.map(async (t) => ({
            pageIdx: t.pageIdx,
            hit: await this.deps.imageCache.hasEntry('chapter', chapterTag, `${chapterTag}#p${t.pageIdx}`),
          })),
        );
        skip = new Set(probes.filter((p) => p.hit).map((p) => p.pageIdx));
        cachedPages = skip.size;
      }

      const toFetch = targets.filter((t) => !skip.has(t.pageIdx));
      log('resolved', {
        total,
        cachedBeforeFetch: cachedPages,
        toFetch: toFetch.length,
      });

      const persist = async () => {
        await this.repo.updateProgress(jobId, { cachedPages, failedPages, failed });
        lastPersist = cachedPages + failedPages;
        // Mid-run cancel check on every progress persist (every few pages)
        // so "Stop downloads" interrupts the running chapter promptly
        // instead of letting it run to completion.
        if (await isCancelRequested()) {
          throw new JobCancelledError();
        }
      };

      let cursor = 0;
      const next = async (): Promise<void> => {
        while (cursor < toFetch.length) {
          if (controller.signal.aborted) throw new JobCancelledError();
          const target = toFetch[cursor++]!;
          try {
            const source = target.sourceName ? this.deps.registry.get(target.sourceName) : null;
            if (!source?.fetchImage) throw new Error(`no fetchImage for ${target.sourceName}`);
            await this.deps.imageCache.getOrCreate(
              target.cacheUrl,
              () => source.fetchImage!(target.cacheUrl),
              'chapter',
              chapterTag,
              `${chapterTag}#p${target.pageIdx}`,
            );
            cachedPages += 1;
            fetched += 1;
          } catch (error) {
            failedPages += 1;
            failed.push(target.pageIdx);
            logger.warn('prefetch page failed', {
              jobId,
              chapterId,
              pageIdx: target.pageIdx,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          if (cachedPages + failedPages - lastPersist >= PROGRESS_PERSIST_EVERY) {
            await persist();
          }
        }
      };

      // Per-job width: parallel reader = 8, sequential = preloadAhead,
      // data-saver = 1. Clamped 1–16 at enqueue; legacy rows fall back to 3.
      // The queue itself stays single-flight (one chapter at a time) — only
      // the pages within the chapter fan out wider.
      const rawConcurrency =
        typeof (job as { pageConcurrency?: unknown }).pageConcurrency === 'number'
          ? (job as { pageConcurrency?: number }).pageConcurrency!
          : PREFETCH_PAGE_CONCURRENCY_FALLBACK;
      const pageConcurrency = Math.min(
        16,
        Math.max(1, Math.trunc(rawConcurrency) || PREFETCH_PAGE_CONCURRENCY_FALLBACK),
      );
      try {
        await Promise.all(
          Array.from({ length: Math.min(pageConcurrency, toFetch.length) }, () => next()),
        );
      } catch (error) {
        if (error instanceof JobCancelledError || controller.signal.aborted || (await isCancelRequested())) {
          await this.markCancelled(jobId, { cachedPages, failedPages, failed });
          log('cancelled mid-flight');
          return;
        }
        throw error;
      }

      if (await isCancelRequested()) {
        await this.markCancelled(jobId, { cachedPages, failedPages, failed });
        log('cancelled mid-flight');
        return;
      }

      await persist();
      const completed = await this.repo.complete(jobId, { cachedPages, failedPages, failed });
      if (!completed) {
        log('cancelled at finish (cancel won the race)');
        return;
      }
      log('completed', { cachedPages, failedPages });
    } catch (error) {
      if (error instanceof JobCancelledError) {
        await this.markCancelled(jobId, { cachedPages, failedPages, failed });
        log('cancelled mid-flight');
        return;
      }
      logger.error('prefetch job errored', {
        jobId,
        chapterId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.repo.fail(jobId, error instanceof Error ? error.message : String(error));
    } finally {
      this.inflightAbort = null;
      if (this.inflightJobId === jobId) this.inflightJobId = null;
    }

    // Pace the batch after every chapter (success or per-chapter failure)
    // — but never after a user cancel, and never after the batch's last
    // pending chapter (nothing left to wait for). The wait applies even
    // when the chapter needed no upstream work (fully cached): the user
    // explicitly configured the pause, and skipping it made the countdown
    // never appear while chapters chained instantly — "the timer doesn't
    // work". Pushes the remaining pending chapters forward by
    // `intervalMs`. Zero delayed means this was the batch's last pending
    // chapter, so no wait is inserted after the final chapter.
    // NOTE: `fetched`/`failedPages` below are only assigned on the success
    // path — a job-level `fail()` leaves them at 0/0 with `total` still 0,
    // and that correctly still paces (the source may be struggling, so
    // back off).
    // NOTE: the interval is re-read fresh (not trusted from the claim-time
    // snapshot) so a mid-run preset change (Off → 30s while chapter 1
    // downloads) takes effect on the very next transition. A deleted row
    // falls back to the snapshot.
    if (!controller.signal.aborted && job.batchId) {
      let intervalMs = job.intervalMs;
      try {
        const fresh = await this.repo.getIntervalMs(jobId);
        if (fresh !== null) intervalMs = fresh;
      } catch {
        // Row read failed — pace with the claim-time value.
      }
      if (intervalMs > 0) {
        const delayed = await this.repo.delayBatch(job.batchId, intervalMs);
        if (delayed > 0) log('paced batch', { delayed, intervalMs });
      }
    }
  }

  private async markCancelled(
    jobId: string,
    final: { cachedPages: number; failedPages: number; failed: number[] },
  ): Promise<void> {
    await this.repo.updateProgress(jobId, final);
    await this.repo.cancel(jobId);
  }
}
