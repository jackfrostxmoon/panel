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
 * When `smoothScrollKeys` is on, plain W / ↑ and S / ↓ in vertical mode act
 * like their Shift-held variants ("scrollUp"/"scrollDown" — hold to glide at
 * scroll speed, release to stop) and the step intents are not emitted there.
 * Gallery and paged modes are unaffected.
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

  // Smooth-scroll keys toggle: plain W/S / arrows glide in vertical mode.
  if (smoothScrollKeys && !shiftKey && mode === 'vertical') {
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

/**
 * Derive adjacent chapter ids from the chapter list (ascending by
 * `chapterNumber`, unnumbered chapters keep their source order and sort
 * last, stable). The reader falls back to this when the chapter-pages
 * payload carries no prev/next ids: a persisted pages row captures
 * prev/next at read time, so a chapter that was the latest when read
 * dead-ends forever even after newer chapters ship — the chapter list
 * (which keeps revalidating) still knows them.
 */
export function deriveAdjacentChapterIds(
  chapters: readonly { id: string; chapterNumber: number | null }[],
  currentChapterId: string,
): { prevChapterId: string | null; nextChapterId: string | null } {
  const indexed = chapters.map((chapter, index) => ({ chapter, index }));
  indexed.sort((a, b) => {
    const aNum = a.chapter.chapterNumber;
    const bNum = b.chapter.chapterNumber;
    const aKey = typeof aNum === 'number' && Number.isFinite(aNum) ? aNum : Number.POSITIVE_INFINITY;
    const bKey = typeof bNum === 'number' && Number.isFinite(bNum) ? bNum : Number.POSITIVE_INFINITY;
    if (aKey !== bKey) return aKey - bKey;
    return a.index - b.index;
  });
  const currentIndex = indexed.findIndex((entry) => entry.chapter.id === currentChapterId);
  if (currentIndex < 0) return { prevChapterId: null, nextChapterId: null };
  return {
    prevChapterId: currentIndex > 0 ? indexed[currentIndex - 1]!.chapter.id : null,
    nextChapterId: currentIndex < indexed.length - 1 ? indexed[currentIndex + 1]!.chapter.id : null,
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
