import { randomUUID } from 'node:crypto';
import { writeFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import sharp from 'sharp';
import type { ImageCache } from './imageCache.js';
import { logger } from './logger.js';
import type { OptimizeCoversStatus } from '@panel/shared';

/**
 * Bulk cover re-encoder. Rewrites every cover in the on-disk image cache to
 * WebP — losslessly for lossless sources (PNG/GIF/TIFF/AVIF), at q85 for
 * lossy ones (JPEG, or anything else) — and replaces the originals in place.
 *
 * Quality contract:
 *   - PNG-ish covers are pixel-identical (WebP lossless).
 *   - JPEG covers are re-encoded at q85, which is visually indistinguishable.
 *   - Animated covers (pages > 1) are skipped, never flattened.
 *   - Undecodable files are skipped and reported, never corrupted.
 *   - A re-encode that would not save bytes keeps the original — so the
 *     operation is always monotonically space-neutral-or-better, and
 *     re-running it is cheap (already-WebP entries are skipped up front).
 *
 * The job runs in the background (fire-and-forget from `start()`); the
 * cache-settings page polls `getStatus()` to render a progress line. The
 * job holds no database state — the cache remains a pure cache; fresh
 * covers fetched after a run are simply unconverted and are picked up by
 * the next run.
 */
class CoverOptimizer {
  private job: OptimizeCoversStatus = {
    state: 'idle',
    startedAt: null,
    finishedAt: null,
    total: 0,
    processed: 0,
    converted: 0,
    skippedOptimal: 0,
    skippedAnimated: 0,
    skippedError: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    currentFile: null,
    error: null,
  };

  constructor(
    private readonly imageCache: ImageCache,
    private readonly dir: string,
  ) {}

  /** Snapshot of the current (or last) run. */
  getStatus(): OptimizeCoversStatus {
    return { ...this.job };
  }

  isRunning(): boolean {
    return this.job.state === 'running';
  }

  /**
   * Kick off a run. Synchronous state transition (fail fast when one is
   * already in flight); the heavy lifting continues in the background.
   */
  start(): void {
    if (this.job.state === 'running') {
      throw new Error('cover optimization is already running');
    }
    this.job = {
      state: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      total: 0,
      processed: 0,
      converted: 0,
      skippedOptimal: 0,
      skippedAnimated: 0,
      skippedError: 0,
      bytesBefore: 0,
      bytesAfter: 0,
      currentFile: null,
      error: null,
    };
    void this.run();
  }

  private async run(): Promise<void> {
    let files: string[] = [];
    try {
      files = await this.imageCache.listCoverFiles();
      this.job.total = files.length;
    } catch (error) {
      this.fail(error);
      return;
    }

    for (const rel of files) {
      // No cancel endpoint in v1 — a run always completes its batch.
      this.job.currentFile = basename(rel);
      await this.processFile(rel);
      this.job.processed += 1;
    }

    this.job.currentFile = null;
    this.job.state = 'done';
    this.job.finishedAt = new Date().toISOString();
    logger.info('Cover optimization finished', {
      total: this.job.total,
      converted: this.job.converted,
      skippedOptimal: this.job.skippedOptimal,
      skippedAnimated: this.job.skippedAnimated,
      skippedError: this.job.skippedError,
      bytesBefore: this.job.bytesBefore,
      bytesAfter: this.job.bytesAfter,
    });
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Cover optimization failed', { error: message });
    this.job.state = 'error';
    this.job.error = message;
    this.job.currentFile = null;
    this.job.finishedAt = new Date().toISOString();
  }

  private addBytes(before: number, after: number): void {
    this.job.bytesBefore += before;
    this.job.bytesAfter += after;
  }

  private async processFile(rel: string): Promise<void> {
    let oldSize = 0;
    try {
      const absOld = join(this.dir, rel);
      const oldStat = await stat(absOld);
      oldSize = oldStat.size;

      // Already WebP — nothing to gain; leave it untouched.
      if (extname(rel).toLowerCase() === '.webp') {
        this.addBytes(oldSize, oldSize);
        this.job.skippedOptimal += 1;
        return;
      }

      const meta = await sharp(absOld, { animated: false }).metadata();
      if ((meta.pages ?? 1) > 1) {
        this.addBytes(oldSize, oldSize);
        this.job.skippedAnimated += 1;
        return;
      }

      // JPEG is the only lossy format covers realistically carry (AVIF/HEIF
      // decode to pixels re-encoded losslessly) — it gets q85. Everything
      // else is pixel-exact.
      const lossless = meta.format !== 'jpeg';
      const out = await sharp(absOld, { animated: false })
        // Bake EXIF orientation into the pixels, then strip metadata —
        // pixel-identical display everywhere, smaller file.
        .rotate()
        .webp(lossless ? { lossless: true } : { quality: 85 })
        .toBuffer();

      if (out.length >= oldSize) {
        this.addBytes(oldSize, oldSize);
        this.job.skippedOptimal += 1;
        return;
      }

      const stem = basename(rel, extname(rel));
      const newRel = join(dirname(rel), `${stem}.webp`);
      const staging = join(this.dir, dirname(rel), `.staging-${randomUUID()}.webp`);
      await writeFile(staging, out);
      await this.imageCache.swapFile(rel, newRel, staging);
      this.addBytes(oldSize, out.length);
      this.job.converted += 1;
    } catch (error) {
      // One bad cover must never fail the batch — count it and move on.
      logger.warn('Cover optimization skipped a file', {
        file: rel,
        error: error instanceof Error ? error.message : String(error),
      });
      this.addBytes(oldSize, oldSize);
      this.job.skippedError += 1;
    }
  }
}

export { CoverOptimizer };
