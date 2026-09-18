import type { Chapter } from '@panel/shared';

/**
 * Filler / optional chapter markers (T2-7).
 *
 * Sources don't expose a canonical "filler" flag, so we use a conservative
 * heuristic over the chapter title and number:
 *   - fractional chapter numbers (12.5, 103.1) are almost always extras;
 *   - common side-content keywords in the title.
 * The badge is informational only — chapters are never hidden or reordered.
 */

const FILLER_TITLE_RE =
  /\b(side[- ]?stor(?:y|ies)|special|omake|extra|oneshot|one[- ]?shot|intermission|interlude|bonus|gaiden|spin[- ]?off|announcement|recap)\b/i;

export type ChapterMarker = 'filler' | null;

export function chapterMarker(chapter: Pick<Chapter, 'title' | 'chapterNumber'>): ChapterMarker {
  if (chapter.chapterNumber !== null && !Number.isInteger(chapter.chapterNumber)) {
    return 'filler';
  }
  if (FILLER_TITLE_RE.test(chapter.title)) return 'filler';
  return null;
}
