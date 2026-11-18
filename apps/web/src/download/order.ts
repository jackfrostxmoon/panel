import type { Chapter } from '@panel/shared';
import { chapterOrderKey } from '../reader/navigation';

/**
 * Chapter ordering for bulk download batches.
 *
 * The downloader enqueues one job per chapter sequentially so that
 * `created_at` order equals array order — the worker claims the earliest-due
 * job first. That makes the batch order the *download* order, which is why it
 * has to be decided deliberately: before this module, callers passed whatever
 * order the chapter list happened to be displayed in, so flipping the
 * Newest/Oldest view toggle silently reversed the download sequence.
 *
 * Sorting here — rather than trusting the caller — means the direction the
 * user picked in the order dialog is the direction that runs, no matter which
 * entry point started the batch.
 */

/** Which end of the chapter list a batch starts from. */
export type ChapterOrder = 'oldest-first' | 'newest-first';

/**
 * Stable sort key for a chapter.
 *
 * `chapterNumber` is the natural key, but some sources publish raw tokens as
 * titles (`#206`, `Ch. 206`) and leave the number null — so the key also
 * accepts a number parsed from the title/id token and, failing that, falls
 * back to `publishedAt` and finally to the chapter's own position in the
 * incoming array, which preserves the source's own ordering for the
 * remainder. Rows persisted via the background prefetch path carry neither
 * number nor publish date, so position is the last resort.
 */
function chapterSortKey(chapter: Chapter, position: number): [number, number, number] {
  const [bucket, key] = chapterOrderKey(chapter);
  return [bucket, key, position];
}

/**
 * Sort a batch into download order. Pure, and does not mutate the input.
 *
 * `oldest-first` reads chapter 1 upward; `newest-first` starts at the latest
 * chapter. Numbered chapters — explicit or parsed from the title — always
 * sort chronologically; anything still unnumbered falls back to its publish
 * date, then to source order.
 */
export function sortChaptersForDownload(
  chapters: readonly Chapter[],
  order: ChapterOrder,
): Chapter[] {
  const keys = chapters.map((chapter, position) => chapterSortKey(chapter, position));
  const sorted = chapters
    .map((chapter, i) => ({ chapter, key: keys[i] as [number, number, number] }))
    .sort((a, b) => {
      for (let i = 0; i < a.key.length; i += 1) {
        const delta = (a.key[i] as number) - (b.key[i] as number);
        if (delta !== 0) return delta;
      }
      return 0;
    })
    .map((entry) => entry.chapter);
  return order === 'newest-first' ? sorted.reverse() : sorted;
}