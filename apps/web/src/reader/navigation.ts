/**
 * Pure reader navigation logic — extracted from components so the page /
 * chapter transition rules are unit-testable without a DOM.
 */

import type { ReadingDirection } from './settings';

export interface NavigationState {
  /** 0-based current page. */
  page: number;
  /** Total pages in the chapter. */
  pageCount: number;
}

export function clampPage(page: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return Math.min(Math.max(page, 0), pageCount - 1);
}

/** Advance one page; returns null when already past the last page. */
export function nextPage(state: NavigationState): number | null {
  const next = state.page + 1;
  return next < state.pageCount ? next : null;
}

/** Go back one page; returns null when already on the first page. */
export function prevPage(state: NavigationState): number | null {
  const prev = state.page - 1;
  return prev >= 0 ? prev : null;
}

/**
 * Which half of the reader a click landed in.
 *
 * On desktop the tap-zone overlays stop swallowing mouse events (so page
 * images stay natively draggable / right-clickable); the container click
 * handler uses this to reproduce the original left/right-half behavior:
 * click the left half → previous, right half → next (independent of the
 * reading direction — callers map the side to the navigation action).
 */
export function halfSideFromClientX(clientX: number, rect: { left: number; width: number }): 'left' | 'right' {
  return clientX - rect.left < rect.width / 2 ? 'left' : 'right';
}

/**
 * True when a keydown target is a text-entry control whose keystrokes must
 * not trigger reader shortcuts (e.g. the style-name field in the settings
 * panel). Range sliders are deliberately NOT editable here: arrow keys on a
 * focused slider must still turn pages instead of scrubbing image width.
 */
export function isEditableKeyTarget(
  target: { tagName?: string; type?: string; isContentEditable?: boolean } | null,
): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target.type ?? 'text').toLowerCase();
    return type !== 'range' && type !== 'checkbox' && type !== 'radio' && type !== 'button'
      && type !== 'submit' && type !== 'reset' && type !== 'color' && type !== 'file'
      && type !== 'image';
  }
  return false;
}

/**
 * Map a key press to a navigation intent.
 *
 * Paged mode:
 *   ← / A   → "backward"     → / D / Space → "forward"
 *   Esc     → "exit"
 *
 * Vertical / gallery modes:
 *   Esc     → "exit"
 *   Space   → "forward"      (advance one page within the chapter)
 *   ← / A   → "chapterBackward"   (hop to previous chapter)
 *   → / D   → "chapterForward"    (hop to next chapter)
 *   Shift+W / Shift+↑ → "scrollUp"     (smooth continuous scroll up)
 *   Shift+S / Shift+↓ → "scrollDown"   (smooth continuous scroll down)
 *   W / ↑   → "stepUp"       (vertical: previous page, like one wheel notch;
 *                             gallery: smooth step scroll up)
 *   S / ↓   → "stepDown"     (vertical: next page; gallery: step scroll down)
 *                             (with smoothScrollKeys on, plain W/S glide instead —
 *                             see below; both vertical and gallery modes)
 *   G      → "toggleGap"     (bare press only — toggle breathing room between images)
 *   V      → "toggleBookmark" (bare press only — bookmark / unbookmark the current chapter)
  *   C      → "toggleFitHeight" in paged mode (fit the page to the viewport height)
  *          → "toggleFitWidth" in vertical mode (fit pages to the reader width)
 *
 * The single-letter toggles require a bare press (no Shift/Ctrl/Meta/Alt):
 * Shift is reserved for the smooth-scroll chords (Shift+W/S, Shift+↑/↓),
 * and Ctrl/Meta/Alt guard browser shortcuts (copy/paste/find) from being
 * hijacked — e.g. Ctrl+C must keep copying, Shift+V must not bookmark.
 *
 * When `smoothScrollKeys` is on, plain W / ↑ and S / ↓ in vertical and
 * gallery modes act
 * like their Shift-held variants ("scrollUp"/"scrollDown" — hold to glide at
 * scroll speed, release to stop) and the step intents are not emitted there.
 * Paged mode is unaffected.
 *
 * In RTL reading direction the left/right (and A/D) keys swap their chapter
 * meaning: "forward" is the LEFT arrow / A.
 *
 * In paged mode, W/S (and ↑/↓) additionally turn pages — up = previous,
 * down = next — matching the mouse wheel, which also turns pages there.
 *
 * Scroll/move intents are emitted only for the vertical reader; the caller gates
 * them by reading mode before acting. `toggleGap` is a modeless toggle — the
 * caller decides which modes actually honor it.
 */
export function intentForKey(
  key: string,
  direction: ReadingDirection,
  shiftKey = false,
  mode?: 'vertical' | 'paged' | 'gallery',
  smoothScrollKeys = false,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {},
):
  | 'forward'
  | 'backward'
  | 'exit'
  | 'scrollUp'
  | 'scrollDown'
  | 'stepUp'
  | 'stepDown'
  | 'chapterForward'
  | 'chapterBackward'
  | 'toggleGap'
  | 'toggleBookmark'
  | 'toggleFitHeight'
  | 'toggleFitWidth'
  | null {
  // Bare-press reader toggles — checked before the mode-specific
  // navigation keys so they work in every reading mode (the caller gates
  // which modes actually render the effect, e.g. fit-to-height is paged-only
  // and fit-to-width is vertical-only).
  // A bare press means no modifier is held: Shift is reserved for the
  // smooth-scroll chords above, and Ctrl/Meta/Alt guard browser shortcuts
  // (copy/paste/find) from being hijacked by a same-letter toggle.
  const barePress = !shiftKey && !modifiers.ctrlKey && !modifiers.metaKey && !modifiers.altKey;
  if (barePress && (key === 'g' || key === 'G')) return 'toggleGap';
  if (barePress && (key === 'v' || key === 'V')) return 'toggleBookmark';
  if (barePress && (key === 'c' || key === 'C')) {
    // One key, per-mode effect (mirrors the settings switches): paged mode
    // fits the page to the viewport height, vertical mode fits pages to the
    // reader width. Other modes (and unknown callers without a mode) keep
    // the historic fit-height intent so the caller can toast.
    return mode === 'vertical' ? 'toggleFitWidth' : 'toggleFitHeight';
  }

  if (shiftKey && (key === 'ArrowUp' || key === 'w' || key === 'W')) return 'scrollUp';
  if (shiftKey && (key === 'ArrowDown' || key === 's' || key === 'S')) return 'scrollDown';

  // Smooth-scroll keys toggle: plain W/S / arrows glide in vertical and
  // gallery modes.
  if (smoothScrollKeys && !shiftKey && (mode === 'vertical' || mode === 'gallery')) {
    if (key === 'ArrowUp' || key === 'w' || key === 'W') return 'scrollUp';
    if (key === 'ArrowDown' || key === 's' || key === 'S') return 'scrollDown';
  }

  // Smooth step scroll (vertical/gallery modes, no Shift)
  if (!shiftKey && (mode === 'vertical' || mode === 'gallery')) {
    if (key === 'ArrowUp' || key === 'w' || key === 'W') return 'stepUp';
    if (key === 'ArrowDown' || key === 's' || key === 'S') return 'stepDown';
  }

  // In vertical AND gallery modes the left/right (and A/D) keys hop between
  // chapters — in vertical, pages within a chapter are scrolled with W/S;
  // in gallery, the grid is browsed with the wheel. Space keeps turning
  // pages. In paged mode the same keys turn pages.
  if (mode === 'vertical' || mode === 'gallery') {
    switch (key) {
      case 'Escape':
        return 'exit';
      case ' ':
      case 'Spacebar':
        return 'forward';
      case 'ArrowRight':
      case 'd':
      case 'D':
        return direction === 'rtl' ? 'chapterBackward' : 'chapterForward';
      case 'ArrowLeft':
      case 'a':
      case 'A':
        return direction === 'rtl' ? 'chapterForward' : 'chapterBackward';
      default:
        return null;
    }
  }

  switch (key) {
    case 'Escape':
      return 'exit';
    case ' ':
    case 'Spacebar':
      return 'forward';
    case 'ArrowUp':
    case 'w':
    case 'W':
      // Extra page-turn keys: vertical keys also work in paged mode
      // (up = previous, down = next), independent of reading direction.
      return 'backward';
    case 'ArrowDown':
    case 's':
    case 'S':
      return 'forward';
    case 'ArrowRight':
    case 'd':
    case 'D':
      return direction === 'rtl' ? 'backward' : 'forward';
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return direction === 'rtl' ? 'forward' : 'backward';
    default:
      return null;
  }
}

/**
 * Resolve a forward/backward intent into a page delta, respecting the
 * reading direction (RTL: forward = visually left = next page).
 */
export function applyIntent(state: NavigationState, intent: 'forward' | 'backward'): number | null {
  return intent === 'forward' ? nextPage(state) : prevPage(state);
}

/** Reading progress as a 0..1 fraction for progress bars. */
export function progressFraction(page: number, pageCount: number): number {
  if (pageCount <= 1) return pageCount === 1 ? 1 : 0;
  return clampPage(page, pageCount) / (pageCount - 1);
}

/**
 * Smooth reading progress as a 0..1 fraction for progress bars.
 * Uses page index + optional intra-page scroll ratio for fluid updates
 * in vertical/gallery modes.
 */
export function smoothProgressFraction(
  page: number,
  pageCount: number,
  scrollRatio?: number,
): number {
  if (pageCount <= 1) return pageCount === 1 ? 1 : 0;
  const clampedPage = clampPage(page, pageCount);
  const baseProgress = clampedPage / (pageCount - 1);
  if (scrollRatio === undefined) return baseProgress;
  const nextPageProgress = (clampedPage + 1) / (pageCount - 1);
  return baseProgress + (nextPageProgress - baseProgress) * Math.max(0, Math.min(1, scrollRatio));
}

/* ------------------------------------------------------------------ */
/* Vertical chapter-fraction resume                                      */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Double-page spread (T1-1)                                           */
/* ------------------------------------------------------------------ */

export interface SpreadPage {
  left: number | null;
  right: number;
}

/**
 * The two page indices a double-page spread shows for the given current
 * page. In LTR the current page is the RIGHT sheet; in RTL the current
 * page is the LEFT sheet (the reader's forward direction is toward the
 * spine). `right` is always the current page; `left` is its facing page,
 * or null when there is none (first page in LTR, last in RTL).
 *
 * An unpaired *final* sheet renders solo: in LTR an odd-indexed last page
 * (even-length chapter) has no right-hand partner, and in RTL an
 * even-length chapter leaves page 0 without a facing sheet. Without this,
 * spread stepping by two would re-show the previous spread's sheet.
 */
export function spreadPages(
  page: number,
  pageCount: number,
  direction: ReadingDirection,
): SpreadPage {
  const p = clampPage(page, pageCount);
  if (direction === 'ltr') {
    const trailingSolo = p === pageCount - 1 && p % 2 === 1;
    return { left: !trailingSolo && p > 0 ? p - 1 : null, right: p };
  }
  const leadingSolo = p === 0 && pageCount % 2 === 0;
  return { left: !leadingSolo && p < pageCount - 1 ? p + 1 : null, right: p };
}

/** True when the spread's facing page is missing (start / odd-final sheet). */
export function isOddSpread(spread: SpreadPage): boolean {
  return spread.left === null;
}

/* ------------------------------------------------------------------ */
/* Manual page merges (paged single mode)                              */
/* ------------------------------------------------------------------ */

/**
 * Normalize a list of manual pair starts (0-based first page of each
 * adjacent pair). Drops negatives/non-integers, dedupes, sorts ascending and
 * removes pairs that would overlap an earlier one — a page can only belong to
 * one merged spread, so starts closer than 2 apart keep the lower one.
 */
export function normalizeManualSpreadStarts(starts: readonly unknown[]): number[] {
  const cleaned: number[] = [];
  for (const entry of starts) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) continue;
    const start = Math.trunc(entry);
    if (start < 0 || start > 10_000) continue;
    cleaned.push(start);
  }
  const sorted = [...new Set(cleaned)].sort((a, b) => a - b);
  const result: number[] = [];
  for (const start of sorted) {
    const previous = result[result.length - 1];
    if (previous !== undefined && start - previous < 2) continue;
    result.push(start);
  }
  return result;
}

/**
 * The manual pair covering `page`, as sheet indices in page order
 * (`left` = first page, `right` = second page), or null when the page is not
 * part of a complete manual pair. Incomplete pairs (no following page) are
 * ignored so the last page still renders solo.
 *
 * Callers must pass normalized `starts` (see `normalizeManualSpreadStarts`);
 * the helper still tolerates unsorted input and only needs to scan until it
 * passes the current page.
 */
export function manualSpreadPages(
  page: number,
  pageCount: number,
  starts: readonly number[] | undefined,
): SpreadPage | null {
  if (!starts || starts.length === 0 || pageCount <= 1) return null;
  const p = clampPage(page, pageCount);
  for (const start of starts) {
    if (start > p) break;
    if ((p === start || p === start + 1) && start + 1 < pageCount) {
      return { left: start, right: start + 1 };
    }
  }
  return null;
}

/**
 * Next reading position in paged single mode, stepping over a manual pair as
 * one spread (forward from either sheet lands past both pages). Returns null
 * at the end of the chapter so the caller hops to the next chapter.
 */
export function nextPageWithSpreads(
  state: NavigationState,
  starts: readonly number[] | undefined,
): number | null {
  const { page, pageCount } = state;
  if (pageCount <= 0) return null;
  const pair = manualSpreadPages(page, pageCount, starts);
  const start = pair?.left ?? null;
  const next = start !== null ? start + 2 : page + 1;
  return next < pageCount ? next : null;
}

/** Previous reading position in paged single mode, stepping over manual pairs. */
export function prevPageWithSpreads(
  state: NavigationState,
  starts: readonly number[] | undefined,
): number | null {
  const { page, pageCount } = state;
  if (pageCount <= 0) return null;
  const pair = manualSpreadPages(page, pageCount, starts);
  const start = pair?.left ?? null;
  const previous = start !== null ? start - 1 : page - 1;
  return previous >= 0 ? previous : null;
}

/* ------------------------------------------------------------------ */
/* Configurable spread start (double-page mode)                        */
/* ------------------------------------------------------------------ */

/**
 * 0-based index of the first page of the first automatic spread. Pages
 * before it render solo, so a cover page stays on its own and pairing begins
 * at the page the user typed.
 */
function spreadStartIndex(pageCount: number, startPage: number): number {
  if (pageCount <= 0) return 0;
  return Math.min(Math.max(Math.trunc(startPage) - 1, 0), pageCount - 1);
}

/**
 * Pair of 0-based indices for the spread that contains `page` when the
 * automatic pairing starts at `startPage` (1-based). `left`/`right` are in
 * page order; the paged reader mirrors them for right-to-left reading.
 * Pages before the start — and a final page without a partner — render solo
 * (`left: null`).
 */
export function spreadPagesAt(
  page: number,
  pageCount: number,
  startPage: number,
): SpreadPage {
  if (pageCount <= 0) return { left: null, right: 0 };
  const p = clampPage(page, pageCount);
  const start = spreadStartIndex(pageCount, startPage);
  if (p < start) return { left: null, right: p };
  const first = start + 2 * Math.floor((p - start) / 2);
  if (first + 1 < pageCount) return { left: first, right: first + 1 };
  return { left: null, right: first };
}

/**
 * Next spread's landing page under an explicit spread start. Forward always
 * moves to the next pages in reading order (higher indices) in both reading
 * directions, matching single-page navigation.
 */
export function nextSpreadPageAt(
  state: NavigationState,
  startPage: number,
): number | null {
  const { page, pageCount } = state;
  if (pageCount <= 0) return null;
  const p = clampPage(page, pageCount);
  const start = spreadStartIndex(pageCount, startPage);
  if (p < start) {
    const next = p + 1;
    return next < pageCount ? next : null;
  }
  const first = start + 2 * Math.floor((p - start) / 2);
  const next = first + 2;
  return next < pageCount ? next : null;
}

/** Previous spread's landing page under an explicit spread start. */
export function prevSpreadPageAt(
  state: NavigationState,
  startPage: number,
): number | null {
  const { page, pageCount } = state;
  if (pageCount <= 0) return null;
  const p = clampPage(page, pageCount);
  const start = spreadStartIndex(pageCount, startPage);
  if (p < start) return p > 0 ? p - 1 : null;
  const first = start + 2 * Math.floor((p - start) / 2);
  const previous = first - 2 >= start ? first - 2 : first - 1;
  return previous >= 0 ? previous : null;
}

/**
 * Advance to the next spread's current page; null when already at the end.
 *
 * Spreads overlap if you step by one (the right sheet would reappear as the
 * next spread's left sheet), so we advance by two pages — a full spread —
 * and clamp onto the final solo sheet so the last page of an even-length
 * chapter stays reachable.
 */
export function nextSpreadPage(state: NavigationState, direction: ReadingDirection): number | null {
  const { page, pageCount } = state;
  if (pageCount <= 0) return null;
  const step = direction === 'ltr' ? 2 : -2;
  const next = page + step;
  if (next >= 0 && next < pageCount) return next;
  // Past the last full spread → land on the trailing solo sheet, if any.
  const adjacent = page + (direction === 'ltr' ? 1 : -1);
  return adjacent >= 0 && adjacent < pageCount ? adjacent : null;
}
export function prevSpreadPage(state: NavigationState, direction: ReadingDirection): number | null {
  const { page, pageCount } = state;
  if (pageCount <= 0) return null;
  const step = direction === 'ltr' ? -2 : 2;
  const prev = page + step;
  if (prev >= 0 && prev < pageCount) return prev;
  // Before the first full spread → land on the leading solo sheet, if any.
  const adjacent = page + (direction === 'ltr' ? -1 : 1);
  return adjacent >= 0 && adjacent < pageCount ? adjacent : null;
}

/** Chapter-like object the ordering helpers can sort. */
export interface ChapterOrderable {
  id: string;
  title?: string | null;
  chapterNumber: number | null;
  publishedAt?: string | null;
}

/**
 * Extract a chapter number from free-ish text ("Chapter 2.2",
 * "Chapter 244.1646023630", "ch-3"). Prefers a chapter-ish keyword
 * anchor; falls back to the trailing number group. Cache-busting
 * suffixes ("chapter-244.1646023630") stay larger than the base chapter,
 * which is all the ordering needs.
 */
export function matchChapterNumber(value: string): number | null {
  const anchored = /(?:chapter|chap|ch|ep|episode)\s*[._\-–—]*\s*0*(\d+(?:\.\d+)?)/i.exec(value);
  if (anchored?.[1]) return Number(anchored[1]);
  const trailing = /(\d+(?:\.\d+)?)\s*$/.exec(value);
  return trailing?.[1] ? Number(trailing[1]) : null;
}

/**
 * Best-effort numeric sort key for a chapter: the explicit
 * `chapterNumber`, else parsed from the title or id token
 * ("Chapter 2.2" → 2.2), else the publish timestamp, else a constant
 * bucket (unnumbered chapters keep source order and sort last).
 * Rows persisted via the background prefetch path carry no number, so a
 * naive "null → last/zero" bucket scrambles partially-numbered panels.
 */
export function chapterOrderKey(chapter: ChapterOrderable): [number, number] {
  const num = chapter.chapterNumber;
  if (typeof num === 'number' && Number.isFinite(num)) return [0, num];
  const parsed =
    (chapter.title ? matchChapterNumber(chapter.title) : null) ?? matchChapterNumber(chapter.id);
  if (parsed !== null) return [0, parsed];
  const published = chapter.publishedAt ? Date.parse(chapter.publishedAt) : Number.NaN;
  if (Number.isFinite(published)) return [1, published];
  return [2, 0];
}

/**
 * Ascending chapter order (stable): numbered/parsed chapters by number,
 * then published-date chapters, then unnumbered in source order. Shared
 * by the reader hops and every chapter list so the visible order matches
 * navigation exactly.
 */
export function compareChaptersAscending(a: ChapterOrderable, b: ChapterOrderable): number {
  const aKey = chapterOrderKey(a);
  const bKey = chapterOrderKey(b);
  if (aKey[0] !== bKey[0]) return aKey[0] - bKey[0];
  return aKey[1] - bKey[1];
}

/**
 * Derive adjacent chapter ids from the chapter list (ascending by chapter
 * number, unnumbered chapters keep their source order and sort last,
 * stable). The reader falls back to this when the chapter-pages payload
 * carries no prev/next ids: a persisted pages row captures prev/next at
 * read time, so a chapter that was the latest when read dead-ends forever
 * even after newer chapters ship — the chapter list (which keeps
 * revalidating) still knows them.
 */
export function deriveAdjacentChapterIds(
  chapters: readonly ChapterOrderable[],
  currentChapterId: string,
): { prevChapterId: string | null; nextChapterId: string | null } {
  // Stable sort — unnumbered chapters keep their source order.
  const sorted = [...chapters].sort(compareChaptersAscending);
  const currentIndex = sorted.findIndex((chapter) => chapter.id === currentChapterId);
  if (currentIndex < 0) return { prevChapterId: null, nextChapterId: null };
  return {
    prevChapterId: currentIndex > 0 ? sorted[currentIndex - 1]!.id : null,
    nextChapterId: currentIndex < sorted.length - 1 ? sorted[currentIndex + 1]!.id : null,
  };
}

/* ------------------------------------------------------------------ */
/* Wheel smooth scroll (T1-3)                                          */
/* ------------------------------------------------------------------ */

/**
 * Convert a wheel delta into a page-step count for smooth vertical scroll.
 *
 * `pagesPerNotch` is the user setting: 0 = native (one page per notch,
 * the browser decides), otherwise the delta is quantised to whole pages
 * so a flick of the wheel never lands mid-page. Negative delta = scroll
 * down (forward in reading order).
 */
export function wheelPageStep(deltaY: number, pagesPerNotch: number): number {
  if (pagesPerNotch <= 0) return 0; // 0 = let the browser handle it
  const sign = deltaY < 0 ? -1 : 1;
  const magnitude = Math.ceil(Math.abs(deltaY) / 120); // ~120 px = 1 notch
  return sign * Math.max(1, magnitude * pagesPerNotch);
}
