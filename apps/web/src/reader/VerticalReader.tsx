import { useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react';
import type { PanelPage } from '@panel/shared';
import { ReaderImage } from './ReaderImage';
import { verticalReaderWidthPercent, type ReadingDirection } from './settings';
import { halfSideFromClientX, type PagePair } from './navigation';
import { glideScrollTo } from './glideScroll';
import type { GlidePreset } from './settings';

/**
 * Vertical (webtoon-style) reader: all pages stacked, with scroll-position
 * tracking for the page at the viewport center.
 *
 * The parent controls page changes; scrolling reports progress upward via
 * onPageChange, and scrollToPage() jumps to a page (continue-reading).
 */
export interface VerticalReaderHandle {
  scrollToPage: (page: number, preset?: GlidePreset) => void;
}

export const VerticalReader = forwardRef<
  VerticalReaderHandle,
  {
    pages: PanelPage[];
    /** Image width as a percent of the reader viewport (see settings). */
    imageWidth: number;
    imageWidthPx: number | null;
    imageHeightPx: number | null;
    imageGap: boolean;
    /**
     * Fit pages to the reader width (vertical mode only). When on, the
     * image-width slider and pixel sizes are ignored and pages fill the
     * column — the mirror of paged mode's `fitToHeight`.
     */
    fitToWidth?: boolean;
    /** true = fetch every page immediately; false = lazy-load while scrolling. */
    eagerPages?: boolean;
    /** While lazy-loading: fetch this many pages beyond the current one. */
    preloadAhead?: number;
    onPageChange: (page: number) => void;
    onProgress?: (page: number, scrollRatio: number) => void;
    onChapterNavigate: (dir: 'next' | 'prev') => void;
    /** Chapter global id used as the cache provenance tag. */
    chapterTag?: string | null;
    /** Reading direction; swaps the left/right chapter-hop zones. */
direction?: ReadingDirection;
    /**
     * Page to show on mount. Switching reading modes mounts this reader at
     * scrollTop 0 while the parent still holds the current page — without
     * this the first tracking update reports page 0 and the position is lost.
     */
    initialPage?: number;
/** A page gave up loading (see `ReaderImage`). Lets the parent pin the
     *  toolbar when every page in the chapter failed. */
    onPageError?: (page: PanelPage) => void;
    /** A page displayed, including one that recovered after a manual Reload. */
    onPageLoad?: (page: PanelPage) => void;
    /**
     * Manual page merges for this chapter as ordered adjacent pairs. A pair
     * renders as one side-by-side row in the scrolling column; page jumps
     * land on the row and step over both sheets.
     */
    manualSpreads?: readonly PagePair[];
  }
>(function VerticalReader(
  {
    pages,
    imageWidth,
    imageWidthPx,
    imageHeightPx,
    imageGap,
    fitToWidth = false,
    eagerPages = true,
    preloadAhead = 1,
    onPageChange,
    onProgress,
    onChapterNavigate,
    chapterTag = null,
    direction = 'ltr',
    initialPage = 0,
onPageError,
    onPageLoad,
    manualSpreads,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const glideAnimRef = useRef(0);
  /** 0-based index of the page at the viewport center (drives preloading). */
  const [currentIndex, setCurrentIndex] = useState(0);
  const onPageChangeRef = useRef(onPageChange);
  onPageChangeRef.current = onPageChange;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  /** Jump to `initialPage` once on mount (see prop docs). */
  const restoredRef = useRef(false);
  const initialPageRef = useRef(initialPage);
  initialPageRef.current = initialPage;

  /**
   * Rows to render top to bottom. A merged pair becomes one row holding both
   * pages side by side (ordered by the pair, mirrored for RTL), so scroll
   * tracking and page jumps treat the pair as a single position.
   */
  const rows = useMemo(() => {
    const pairs = manualSpreads ?? [];
    const pairByFirst = new Map<number, PagePair>();
    const covered = new Set<number>();
    for (const pair of pairs) {
      const [first, second] = pair;
      if (Math.abs(first - second) !== 1) continue;
      if (first < 0 || second < 0 || first >= pages.length || second >= pages.length) continue;
      if (covered.has(first) || covered.has(second)) continue;
      covered.add(first);
      covered.add(second);
      pairByFirst.set(Math.min(first, second), pair);
    }
    const out: Array<{ key: string; indices: number[] }> = [];
    for (let index = 0; index < pages.length; index += 1) {
      const pair = pairByFirst.get(index);
      if (pair) {
        out.push({ key: `pair:${pair[0]}:${pair[1]}`, indices: [pair[0], pair[1]] });
        continue;
      }
      if (covered.has(index)) continue;
      out.push({ key: `page:${index}`, indices: [index] });
    }
    return out;
  }, [pages.length, manualSpreads]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useImperativeHandle(ref, () => ({
    scrollToPage(page: number, preset: GlidePreset = 'quick') {
      const rowIndex = rowsRef.current.findIndex((row) => row.indices.includes(page));
      const el = rowRefs.current[rowIndex];
      if (!el) return;
      const scroller = el.closest('.reader-content') as HTMLElement | null;
      if (scroller) {
        const top = el.offsetTop - (scroller.clientTop || 0);
        glideScrollTo(scroller, top, glideAnimRef, preset);
      } else {
        el.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    },
  }));

  // Track the page at the viewport center. Uses scroll-position math rather
  // than intersection-ratio thresholds: very tall pages (e.g. a fixed px
  // height) may never reach a ratio threshold, which would freeze tracking.
  useEffect(() => {
    const scroller = containerRef.current?.closest('.reader-content') as HTMLElement | null;
    const target: HTMLElement | Window = scroller ?? window;
    let ticking = false;

    // A mode switch mounts this reader at scrollTop 0 while the parent still
    // holds the current page. Jump back there BEFORE the first tracking
    // update — otherwise update() sees the top and reports page 0, wiping
    // the preserved position. Runs once; aspect-ratio boxes keep offsets
    // stable even before images finish loading.
    if (!restoredRef.current) {
      const wanted = initialPageRef.current;
      const found = rowsRef.current.findIndex((row) => row.indices.includes(wanted));
      const rowIndex = found >= 0 ? found : Math.max(rowsRef.current.length - 1, 0);
      const el = rowRefs.current[rowIndex];
      if (el && scroller) {
        scroller.scrollTop = el.offsetTop - (scroller.clientTop || 0);
        restoredRef.current = true;
      } else if (rowRefs.current.length > 0) {
        restoredRef.current = true;
      }
    }

    const update = () => {
      ticking = false;
      const refs = rowRefs.current;
      /* Trim to the live row count: merging two pages shrinks the list and
         leaves stale (null) slots past the end. */
      const count = Math.min(refs.length, rowsRef.current.length);
      if (count <= 0) return;

      const viewportCenter = (scroller?.clientHeight ?? window.innerHeight) / 2;
      const scrollerTop = scroller?.getBoundingClientRect().top ?? 0;
      let best = count - 1;
      for (let i = 0; i < count; i++) {
        const el = refs[i];
        if (!el) continue;
        const top = el.getBoundingClientRect().top - scrollerTop;
        if (top <= viewportCenter) best = i;
        else break;
      }
      /* A merged row reports its first page (the entered reading order), so
         the page counter/progress stays on the merged spread. */
      const anchor = rowsRef.current[best]?.indices[0] ?? best;
      onPageChangeRef.current(anchor);
      setCurrentIndex((prev) => (prev === anchor ? prev : anchor));

      // Calculate scroll ratio within the current row for smooth progress
      const currentEl = refs[best];
      if (currentEl && onProgressRef.current) {
        const rect = currentEl.getBoundingClientRect();
        const pageTop = rect.top - scrollerTop;
        const pageHeight = rect.height;

        if (pageHeight > 0) {
          // Ratio of how far the viewport center has progressed through this page
          const progressThroughPage = Math.max(
            0,
            Math.min(1, (viewportCenter - pageTop) / pageHeight),
          );
          onProgressRef.current(anchor, progressThroughPage);
        }
      }
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };

    update();
    target.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      target.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [pages.length]);

  /* Desktop: the overlay zones are pointer-events:none (see reader.css), so
     this reproduces the original "click left/right half jumps chapter" while
     the mousedown still reaches the <img> (native drag / copy image keep
     working). Touch keeps using the physical zone buttons.
     In RTL the zones swap: the forward chapter sits on the left, so the
     left half hops forward and the right half hops back. */
  const handleHalfClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.nativeEvent as PointerEvent).pointerType === 'touch') return;
    if ((event.target as HTMLElement).closest('button, a')) return;
    const side = halfSideFromClientX(event.clientX, event.currentTarget.getBoundingClientRect());
    const forward = direction === 'rtl' ? side === 'left' : side === 'right';
    onChapterNavigate(forward ? 'next' : 'prev');
  };

  /** One page image, with the shared preload/lazy rules. */
  const renderPage = (page: PanelPage | undefined, rowIndex: number) => {
    if (!page) return null;
    return (
      <ReaderImage
        key={`${chapterTag ?? ''}:${page.index}`}
        page={page}
        eager={eagerPages || rowIndex <= (currentIndex + 1) * preloadAhead}
        widthPx={fitToWidth ? null : imageWidthPx}
        heightPx={fitToWidth ? null : imageHeightPx}
        chapterTag={chapterTag}
        onError={onPageError}
        onLoad={onPageLoad}
      />
    );
  };

  return (
    <div
      className={`vertical-reader${
        imageGap ? ' vertical-reader--gap' : ''
      }${fitToWidth ? ' vertical-reader--fit-width' : ''}`}
      style={{
        width: `${verticalReaderWidthPercent(fitToWidth ? 100 : imageWidth)}%`,
      }}
      onClick={handleHalfClick}
      ref={containerRef}
    >
      <button
        type="button"
        className="paged-reader__zone paged-reader__zone--left"
        onClick={() =>
          onChapterNavigate(direction === 'rtl' ? 'next' : 'prev')
        }
        aria-label="Previous chapter"
      />
      {rows.map((row, rowIndex) => (
        <div
          key={row.key}
          data-page-index={row.indices[0]}
          ref={(el) => {
            rowRefs.current[rowIndex] = el;
          }}
          className="vertical-reader__page"
        >
          {row.indices.length > 1 ? (
            <div className="vertical-reader__merged-row">
              {(direction === 'rtl' ? [...row.indices].reverse() : row.indices).map(
                (index) => (
                  <div key={index} className="vertical-reader__merged-sheet">
                    {renderPage(pages[index], rowIndex)}
                  </div>
                ),
              )}
            </div>
          ) : (
            renderPage(pages[row.indices[0] ?? -1], rowIndex)
          )}
        </div>
      ))}
      <button
        type="button"
        className="paged-reader__zone paged-reader__zone--right"
        onClick={() =>
          onChapterNavigate(direction === 'rtl' ? 'prev' : 'next')
        }
        aria-label="Next chapter"
      />
    </div>
  );
});