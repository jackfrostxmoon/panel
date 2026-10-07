/**
 * Reader keyboard shortcuts
 * ========================
 *
 * A typed, categorized catalogue of the keyboard shortcuts the reader honors.
 * The live input binding itself lives in `navigation.ts` (`intentForKey`) plus
 * the `q` (toggle settings), `f` (cycle reading mode), `e` (fullscreen),
 * `v` (bookmark chapter), `c` (fit to height) and `Escape` exit handled
 * by `ReaderPage`; this module is the human-facing source of truth that drives
 * the help dialog.
 *
 * It is intentionally React-free (like `settings.ts`) so the catalogue is
 * unit-testable in isolation and can grow into the single source of truth for
 * input matching without pulling the DOM along.
 */

import type { ReadingDirection, ReadingMode } from './settings';

/** Logical section a shortcut belongs to, used to group the help dialog. */
export type ShortcutCategory = 'Navigation' | 'Reader';

/**
 * A single triggering key.
 *
 * `code` mirrors `KeyboardEvent.key` so the catalogue can later drive real
 * input matching; `label` is the glyph shown in the dialog. `reversible` marks
 * keys whose meaning inverts between LTR and RTL reading directions.
 * `modifier` marks keys that require a held modifier (e.g. Shift) — the
 * help dialog renders it as a prefix, and the input matcher requires it.
 */
export interface ShortcutKey {
  code: string;
  label: string;
  reversible: boolean;
  modifier?: 'Shift' | 'Ctrl' | 'Alt' | 'Meta';
}

/** One logical action and the keys that perform it. */
export interface Shortcut {
  /** Stable id — used as the React key, for tests, and future i18n. */
  id: string;
  /** Human-readable description of the action. */
  label: string;
  /** Keys that trigger the action (alternatives). */
  keys: ShortcutKey[];
  category: ShortcutCategory;
  /** When set, the action only works in this reading mode (e.g. vertical scroll). */
  modes?: ReadingMode[];
}

/**
 * The canonical catalogue, expressed for left-to-right reading. Use
 * {@link resolveShortcuts} to adapt it for the active reading direction.
 */
export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: 'previousPage',
    label: 'Previous page',
    modes: ['paged'],
    keys: [
      { code: 'ArrowLeft', label: '←', reversible: true },
      { code: 'a', label: 'A', reversible: true },
      { code: 'ArrowUp', label: '↑', reversible: false },
      { code: 'w', label: 'W', reversible: false },
    ],
    category: 'Navigation',
  },
  {
    id: 'nextPage',
    label: 'Next page',
    modes: ['paged'],
    keys: [
      { code: 'ArrowRight', label: '→', reversible: true },
      { code: 'd', label: 'D', reversible: true },
      { code: ' ', label: 'Space', reversible: false },
      { code: 'ArrowDown', label: '↓', reversible: false },
      { code: 's', label: 'S', reversible: false },
    ],
    category: 'Navigation',
  },
  {
    id: 'previousChapter',
    label: 'Previous chapter',
    modes: ['vertical', 'gallery'],
    keys: [
      { code: 'ArrowLeft', label: '←', reversible: true },
      { code: 'a', label: 'A', reversible: true },
    ],
    category: 'Navigation',
  },
  {
    id: 'nextChapter',
    label: 'Next chapter',
    modes: ['vertical', 'gallery'],
    keys: [
      { code: 'ArrowRight', label: '→', reversible: true },
      { code: 'd', label: 'D', reversible: true },
      { code: ' ', label: 'Space', reversible: false },
    ],
    category: 'Navigation',
  },
  {
    id: 'stepUp',
    label: 'Previous page (vertical) · scroll up (gallery)',
    modes: ['vertical', 'gallery'],
    keys: [
      { code: 'ArrowUp', label: '↑', reversible: false },
      { code: 'w', label: 'W', reversible: false },
    ],
    category: 'Navigation',
  },
  {
    id: 'stepDown',
    label: 'Next page (vertical) · scroll down (gallery)',
    modes: ['vertical', 'gallery'],
    keys: [
      { code: 'ArrowDown', label: '↓', reversible: false },
      { code: 's', label: 'S', reversible: false },
    ],
    category: 'Navigation',
  },
  {
    id: 'scrollUp',
    label: 'Scroll up (smooth)',
    modes: ['vertical'],
    keys: [
      { code: 'ArrowUp', label: '↑', reversible: false, modifier: 'Shift' },
      { code: 'w', label: 'W', reversible: false, modifier: 'Shift' },
    ],
    category: 'Navigation',
  },
  {
    id: 'scrollDown',
    label: 'Scroll down (smooth)',
    modes: ['vertical'],
    keys: [
      { code: 'ArrowDown', label: '↓', reversible: false, modifier: 'Shift' },
      { code: 's', label: 'S', reversible: false, modifier: 'Shift' },
    ],
    category: 'Navigation',
  },
  {
    id: 'exitReader',
    label: 'Exit reader (back to panel)',
    keys: [{ code: 'Escape', label: 'Esc', reversible: false }],
    category: 'Reader',
  },
  {
    id: 'openSettings',
    label: 'Toggle reading settings',
    keys: [{ code: 'q', label: 'Q', reversible: false }],
    category: 'Reader',
  },
  {
    id: 'cycleReadingMode',
    label: 'Cycle reading mode',
    keys: [{ code: 'f', label: 'F', reversible: false }],
    category: 'Reader',
  },
  {
    id: 'toggleImageGap',
    label: 'Toggle image gap',
    /** Breathing room between stacked/grid images — vertical + gallery modes
     *  only; paged mode lays pages out on a single sheet, so the gap doesn't
     *  apply there. */
    modes: ['vertical', 'gallery'],
    keys: [{ code: 'g', label: 'G', reversible: false }],
    category: 'Reader',
  },
  {
    id: 'toggleFitHeight',
    label: 'Toggle fit to height',
    /** Constrain the page to the viewport height — paged mode only, mirroring
     *  the settings switch, which is disabled in the other modes. */
    modes: ['paged'],
    keys: [{ code: 'c', label: 'C', reversible: false }],
    category: 'Reader',
  },
  {
    id: 'toggleBookmark',
    label: 'Bookmark this chapter',
    keys: [{ code: 'v', label: 'V', reversible: false }],
    category: 'Reader',
  },
  {
    id: 'toggleFullscreen',
    label: 'Toggle fullscreen',
    keys: [{ code: 'e', label: 'E', reversible: false }],
    category: 'Reader',
  },
];

/** Categories in the order they should appear in the help dialog. */
export const SHORTCUT_CATEGORIES: ShortcutCategory[] = ['Navigation', 'Reader'];

/**
 * Returns a defensive copy of the catalogue, with the reversible page-turn
 * keys resolved for the requested reading direction and shortcuts filtered to
 * the active reading mode (mode-restricted shortcuts like the smooth-scroll
 * keys only show when they can actually do something).
 *
 * In RTL the reversible arrow and letter keys swap between "previous" and
 * "next" (←/A advance, →/D retreat); Space is non-reversible, so it stays
 * with "next" (forward). Reader-control shortcuts are unaffected. The source
 * `SHORTCUTS` constant is never mutated.
 */
export function resolveShortcuts(direction: ReadingDirection, mode: ReadingMode): Shortcut[] {
  const clones = SHORTCUTS.map(cloneShortcut);
  if (direction === 'ltr') return clones.filter((s) => !s.modes || s.modes.includes(mode));

  swapReversiblePairs(clones, 'previousPage', 'nextPage');
  swapReversiblePairs(clones, 'previousChapter', 'nextChapter');
  return clones.filter((s) => !s.modes || s.modes.includes(mode));
}

/**
 * For two shortcuts, swap their *reversible* keys so that in RTL the
 * left-hand keys (←/A) mean "forward" and the right-hand keys (→/D) mean
 * "backward". Non-reversible keys (e.g. Space, always "forward") stay with
 * the "next" action.
 */
function swapReversiblePairs(clones: Shortcut[], prevId: string, nextId: string) {
  const previous = clones.find((s) => s.id === prevId);
  const next = clones.find((s) => s.id === nextId);
  if (!previous || !next) return;

  const reversibleFromNext = next.keys.filter((k) => k.reversible);
  const reversibleFromPrev = previous.keys.filter((k) => k.reversible);
  const stickyNext = next.keys.filter((k) => !k.reversible);

  previous.keys = reversibleFromNext;
  next.keys = [...reversibleFromPrev, ...stickyNext];
}

function cloneShortcut(shortcut: Shortcut): Shortcut {
  return {
    ...shortcut,
    keys: shortcut.keys.map((k) => ({ ...k })),
  };
}
