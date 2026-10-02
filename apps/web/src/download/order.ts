import type { Chapter } from '@panel/shared';

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
 * titles (`#206`, `Ch. 206`) and leave the number null — every chapter then
 * ties at 0 and the order collapses to "whatever the list looked like", which
 * is the bug this module exists to remove. So fall back to `publishedAt` and
 * finally to the chapter's own position in the incoming array, which preserves
 * the source's own ordering for the remainder.
 *
 * A chapter with a real number always sorts ahead of one without, in both
 * directions: the numbered run reads chronologically and the unnumbered tail
 * keeps source order.
 */
function chapterSortKey(chapter: Chapter, position: number): [number, number, number] {
  const hasNumber = typeof chapter.chapterNumber === 'number' && Number.isFinite(chapter.chapterNumber);
  if (hasNumber) return [0, chapter.chapterNumber as number, position];

  const published = chapter.publishedAt ? Date.parse(chapter.publishedAt) : Number.NaN;
  if (Number.isFinite(published)) return [1, published, position];

  return [2, 0, position];
}

/**
 * Sort a batch into download order. Pure, and does not mutate the input.
 *
 * `oldest-first` reads chapter 1 upward; `newest-first` starts at the latest
 * chapter. Unnumbered chapters sit after numbered ones when ascending and
 * before them when descending, so a mixed batch still yields a coherent
 * sequence rather than interleaving arbitrarily.
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