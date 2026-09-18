import { describe, it, expect } from 'vitest';
import {
  spreadPages,
  nextSpreadPage,
  prevSpreadPage,
  applyIntent,
  intentForKey,
} from './navigation';
import type { ReadingDirection } from './settings';

const LTR: ReadingDirection = 'ltr';
const RTL: ReadingDirection = 'rtl';
const N = 6; // pages 0..5

describe('spreadPages', () => {
  it('LTR: current page is the right sheet, facing is previous', () => {
    // First page renders solo (no facing sheet) — the reader starts on page 1.
    expect(spreadPages(0, N, LTR)).toEqual({ left: null, right: 0 });
    expect(spreadPages(2, N, LTR)).toEqual({ left: 1, right: 2 });
    expect(spreadPages(4, N, LTR)).toEqual({ left: 3, right: 4 });
    // trailing solo (page 5, odd)
    expect(spreadPages(5, N, LTR)).toEqual({ left: null, right: 5 });
  });

  it('RTL: current page is the right value; facing is the NEXT page (p+1), rendered on the right sheet by PagedReader', () => {
    // spreadPages always returns `right` = current page; PagedReader swaps
    // the sheets per direction. In RTL the facing page is the next chapter
    // (p+1), so left = p+1.
    expect(spreadPages(2, N, RTL)).toEqual({ left: 3, right: 2 });
    expect(spreadPages(4, N, RTL)).toEqual({ left: 5, right: 4 });
    // Leading solo: page 0 in an even-length chapter has no facing sheet.
    expect(spreadPages(0, N, RTL)).toEqual({ left: null, right: 0 });
    // Trailing solo: last page has no facing sheet.
    expect(spreadPages(5, N, RTL)).toEqual({ left: null, right: 5 });
  });
});

describe('nextSpreadPage / prevSpreadPage', () => {
  it('LTR forward steps +2, backward steps -2', () => {
    expect(nextSpreadPage({ page: 0, pageCount: N }, LTR)).toBe(2);
    expect(nextSpreadPage({ page: 2, pageCount: N }, LTR)).toBe(4);
    expect(nextSpreadPage({ page: 4, pageCount: N }, LTR)).toBe(5); // adjacent trailing solo
    expect(nextSpreadPage({ page: 5, pageCount: N }, LTR)).toBeNull();
    expect(prevSpreadPage({ page: 4, pageCount: N }, LTR)).toBe(2);
    expect(prevSpreadPage({ page: 2, pageCount: N }, LTR)).toBe(0);
    expect(prevSpreadPage({ page: 0, pageCount: N }, LTR)).toBeNull();
  });

  it('RTL forward steps -2, backward steps +2 (mirror of LTR)', () => {
    expect(nextSpreadPage({ page: 5, pageCount: N }, RTL)).toBe(3);
    expect(nextSpreadPage({ page: 3, pageCount: N }, RTL)).toBe(1);
    expect(nextSpreadPage({ page: 1, pageCount: N }, RTL)).toBe(0); // adjacent leading solo
    expect(nextSpreadPage({ page: 0, pageCount: N }, RTL)).toBeNull();
    expect(prevSpreadPage({ page: 0, pageCount: N }, RTL)).toBe(2);
    expect(prevSpreadPage({ page: 2, pageCount: N }, RTL)).toBe(4);
    expect(prevSpreadPage({ page: 4, pageCount: N }, RTL)).toBe(5); // adjacent trailing solo
    expect(prevSpreadPage({ page: 5, pageCount: N }, RTL)).toBeNull();
  });
});

describe('applyIntent', () => {
  it('forward = next page, backward = prev page (intent already direction-aware)', () => {
    expect(applyIntent({ page: 2, pageCount: N }, 'forward')).toBe(3);
    expect(applyIntent({ page: 2, pageCount: N }, 'backward')).toBe(1);
    expect(applyIntent({ page: 0, pageCount: N }, 'backward')).toBeNull();
    expect(applyIntent({ page: 5, pageCount: N }, 'forward')).toBeNull();
  });
});

describe('intentForKey', () => {
  it('paged: ArrowLeft/ArrowRight swap by direction', () => {
    expect(intentForKey('ArrowLeft', LTR, false, 'paged')).toBe('backward');
    expect(intentForKey('ArrowRight', LTR, false, 'paged')).toBe('forward');
    expect(intentForKey('ArrowLeft', RTL, false, 'paged')).toBe('forward');
    expect(intentForKey('ArrowRight', RTL, false, 'paged')).toBe('backward');
  });
  it('vertical/gallery: ArrowLeft/ArrowRight hop chapters, swapped by direction', () => {
    expect(intentForKey('ArrowLeft', LTR, false, 'vertical')).toBe('chapterBackward');
    expect(intentForKey('ArrowRight', LTR, false, 'vertical')).toBe('chapterForward');
    expect(intentForKey('ArrowLeft', RTL, false, 'vertical')).toBe('chapterForward');
    expect(intentForKey('ArrowRight', RTL, false, 'vertical')).toBe('chapterBackward');
  });
});