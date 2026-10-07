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
 *   4. Fetch the missing pages in parallel chunks (concurrency = 3) via
 *      the source adapters; persist counters after each chunk so the
 *      polled web UI sees live progress.
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

const PAGE_CONCURRENCY = 3;
const PROGRESS_PERSIST_EVERY = 3;

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

  /** Start the drain loop. First requeues jobs stranded `running` by a
   *  previous unclean shutdown (see `requeueStuck`), then returns — the
   *  loop itself runs on the API's setInterval so HTTP requests aren't
   *  blocked. */
  async start(): Promise<void> {
    if (this.running) return;
    const requeued = await this.repo.requeueStuck();
    if (requeued > 0) logger.info('PrefetchWorker requeued stuck jobs', { requeued });
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
    const jobId = job.id;
    const chapterId = job.chapterId;
    const log = (msg: string, ctx?: Record<string, unknown>) =>
      logger.info(`[prefetch ${jobId.slice(0, 8)}] ${msg}`, { chapterId, ...ctx });

    log('claimed', { batchId: job.batchId, onlyMissing: job.onlyMissing });

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

    try {
      const payload = await this.deps.panelService.getChapterPages(chapterId);
      const chapterTag = payload.chapterId || chapterId;
      const pages = payload.pages;
      total = pages.length;

      if (controller.signal.aborted) return;
      await this.repo.setTotalPages(jobId, total);

      if (total === 0) {
        await this.repo.complete(jobId, { cachedPages: 0, failedPages: 0, failed: [] });
        log('completed (empty chapter)');
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
      };

      let cursor = 0;
      const next = async (): Promise<void> => {
        while (cursor < toFetch.length) {
          if (controller.signal.aborted) return;
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

      await Promise.all(
        Array.from({ length: Math.min(PAGE_CONCURRENCY, toFetch.length) }, () => next()),
      );

      if (controller.signal.aborted) {
        await this.markCancelled(jobId, { cachedPages, failedPages, failed });
        log('cancelled mid-flight');
        return;
      }

      await persist();
      await this.repo.complete(jobId, { cachedPages, failedPages, failed });
      log('completed', { cachedPages, failedPages });
    } catch (error) {
      logger.error('prefetch job errored', {
        jobId,
        chapterId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.repo.fail(jobId, error instanceof Error ? error.message : String(error));
    } finally {
      this.inflightAbort = null;
    }

    // Pace the batch whether this chapter succeeded or failed (matches
    // the old client-side loop) — but never after a user cancel, and never
    // when the chapter needed no work at all. A fully-cached chapter
    // completes instantly with zero fetches and zero failures; penalising
    // the rest of the batch with a wait for that would make "Download all"
    // crawl on re-runs. Pushes the remaining pending chapters forward by
    // `intervalMs`. Zero delayed means this was the batch's last pending
    // chapter, so no wait is inserted after the final chapter.
    // NOTE: `fetched`/`failedPages` below are only assigned on the success
    // path — a job-level `fail()` leaves them at 0/0 with `total` still 0,
    // and that correctly still paces (the source may be struggling, so
    // back off).
    const alreadyCached = fetched === 0 && failedPages === 0 && total > 0;
    if (alreadyCached) {
      log('already cached — skipping batch pace', { cachedPages });
    } else if (!controller.signal.aborted && job.batchId && job.intervalMs > 0) {
      const delayed = await this.repo.delayBatch(job.batchId, job.intervalMs);
      if (delayed > 0) log('paced batch', { delayed, intervalMs: job.intervalMs });
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
