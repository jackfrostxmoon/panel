import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import type { PanelPage } from '@panel/shared';
import { ReaderImage } from './ReaderImage';
import { verticalReaderWidthPercent, type ReadingDirection } from './settings';
import { fractionScrollTarget, halfSideFromClientX, scrollFractionAtOffset } from './navigation';
import { useZoomGesture } from './useZoomGesture';
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
  /**
   * Jump to an overall chapter fraction (0–1) plus an exact horizontal pan.
   * Used for precise continue-reading restores — unlike per-page offsets, a
   * fraction tracks the same relative content while images load and boxes
   * grow; the X pan (nonzero while pinch-zoomed) is layout-stable because
   * image widths never grow on load. Out-of-range X is clamped by the
   * browser, including RTL negative origins.
   */
  scrollToFraction: (fraction: number, preset?: GlidePreset, scrollX?: number | null) => void;
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
    /** true = fetch every page immediately; false = lazy-load while scrolling. */
    eagerPages?: boolean;
    /** While lazy-loading: fetch this many pages beyond the current one. */
    preloadAhead?: number;
    /** Zoom multiplier (T2-1). 1.0 = fit. */
    zoom?: number;
    /** Called whenever the zoom changes (pinch). */
    onZoomChange?: (zoom: number) => void;
    onPageChange: (page: number) => void;
    onProgress?: (page: number, scrollRatio: number) => void;
    /** Overall chapter scroll fraction (0–1) for continue-reading saves. */
    onScrollFraction?: (fraction: number, scrollX: number) => void;
    onChapterNavigate: (dir: 'next' | 'prev') => void;
    /** Chapter global id used as the cache provenance tag. */
    chapterTag?: string | null;
    /** Reading direction; swaps the left/right chapter-hop zones. */
    direction?: ReadingDirection;
    /**
     * Page to show on mount. Switching reading modes mounts a fresh reader
     * at scrollTop 0 while the parent still holds the current page — without
     * this the first tracking update reports page 0 and the position is lost.
     */
    initialPage?: number;
    /**
     * Overall chapter scroll fraction (0–1) to restore on mount. Falls back
     * to `initialPage` top when absent. Read once on mount. Vertical-only.
     */
    initialFraction?: number | null;
    /** Exact horizontal pan (CSS px) to restore on mount. Defaults to 0. */
    initialScrollX?: number | null;
  }
>(function VerticalReader(
  {
    pages,
    imageWidth,
    imageWidthPx,
    imageHeightPx,
    imageGap,
    eagerPages = true,
    preloadAhead = 1,
    zoom,
    onZoomChange,
    onPageChange,
    onProgress,
    onScrollFraction,
    onChapterNavigate,
    chapterTag = null,
    direction = 'ltr',
    initialPage = 0,
    initialFraction = null,
    initialScrollX = null,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { zoom: currentZoom, origin, handlers } = useZoomGesture(containerRef, {
    initialZoom: zoom ?? 1,
    onZoomChange,
  });
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const glideAnimRef = useRef<number>(0);
  /** 0-based index of the page at the viewport center (drives preloading). */
  const [currentIndex, setCurrentIndex] = useState(0);
  const onPageChangeRef = useRef(onPageChange);
  onPageChangeRef.current = onPageChange;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onScrollFractionRef = useRef(onScrollFraction);
  onScrollFractionRef.current = onScrollFraction;
  /** Jump to `initialPage` once on mount (see prop docs). */
  const restoredRef = useRef(false);
  const initialPageRef = useRef(initialPage);
  initialPageRef.current = initialPage;
  const initialFractionRef = useRef(initialFraction);
  initialFractionRef.current = initialFraction;
  const initialScrollXRef = useRef(initialScrollX);
  initialScrollXRef.current = initialScrollX;
  /**
   * Fraction-restore correction: `fraction × total` is computed against the
   * current layout, and every image load changes the total — mostly
   * uniformly (all fallback boxes grow together), but content above the
   * viewport still shifts it. While armed, each image load re-asserts
   * `fraction × newTotal` until everything resolves, the user takes over,
   * or a timeout fires. Corrections write scrollTop directly (no glide) so
   * rapid successive loads converge without animation fighting.
   */
  const correctFractionRef = useRef<number | null>(null);
  const correctTimerRef = useRef<number>(0);
  /** Page indices whose images reported loaded (drives correction disarm). */
  const loadedPagesRef = useRef<Set<number>>(new Set());

  const clearCorrection = () => {
    correctFractionRef.current = null;
    window.clearTimeout(correctTimerRef.current);
    correctTimerRef.current = 0;
  };

  /** Recompute the armed fraction against current layout; direct write. */
  const reassertCorrection = (): void => {
    const fraction = correctFractionRef.current;
    const scroller = containerRef.current?.closest('.reader-content') as HTMLElement | null;
    if (fraction === null || !scroller) return;
    const next = fractionScrollTarget(scroller.scrollHeight, scroller.clientHeight, fraction);
    if (next !== null) scroller.scrollTop = next;
  };

  const armCorrection = (fraction: number) => {
    correctFractionRef.current = fraction;
    window.clearTimeout(correctTimerRef.current);
    // Bounded: never fight the user or loop forever.
    correctTimerRef.current = window.setTimeout(() => clearCorrection(), 5000);
  };

  const handlePageLoad = (index: number) => {
    loadedPagesRef.current.add(index);
    if (correctFractionRef.current === null) return;
    // The total grew as this image resolved — re-assert the fraction.
    reassertCorrection();
    // Everything resolved: the total is final, exact from here on.
    if (loadedPagesRef.current.size >= pageRefs.current.length && pageRefs.current.length > 0) {
      clearCorrection();
    }
  };

  const scrollerOf = (): HTMLElement | null =>
    containerRef.current?.closest('.reader-content') as HTMLElement | null;

  useImperativeHandle(ref, () => ({
    scrollToPage(page: number, preset: GlidePreset = 'quick') {
      clearCorrection();
      const el = pageRefs.current[page];
      if (!el) return;
      const scroller = el.closest('.reader-content') as HTMLElement | null;
      if (scroller) {
        const top = el.offsetTop - (scroller.clientTop || 0);
        glideScrollTo(scroller, top, glideAnimRef, preset);
      } else {
        el.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    },
    scrollToFraction(fraction: number, preset: GlidePreset = 'quick', scrollX?: number | null) {
      clearCorrection();
      if (!Number.isFinite(fraction)) return;
      const clamped = Math.max(0, Math.min(1, fraction));
      const scroller = scrollerOf();
      if (!scroller) {
        return;
      }
      // The X pan is layout-stable (widths never grow on load), so it lands
      // exactly on the first try — unlike the vertical target, which the
      // armed correction below converges as the total settles.
      if (typeof scrollX === 'number' && Number.isFinite(scrollX)) {
        scroller.scrollLeft = scrollX;
      }
      // Best-effort immediate jump; the armed correction converges as the
      // total settles (see correctFractionRef docs).
      const next = fractionScrollTarget(scroller.scrollHeight, scroller.clientHeight, clamped);
      if (next !== null) glideScrollTo(scroller, next, glideAnimRef, preset);
      armCorrection(clamped);
    },
  }));

  /* Fresh image set: forget loaded state + disarm. Runs before the tracking
     effect below, which re-arms for the restored fraction. */
  useEffect(() => {
    loadedPagesRef.current = new Set();
    correctFractionRef.current = null;
    return () => window.clearTimeout(correctTimerRef.current);
  }, [pages.length]);

  /* Keyboard scrolling bypasses the reader handle (which disarms) — yield
     the armed correction as soon as the user drives with keys. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (correctFractionRef.current === null) return;
      if (
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown' ||
        event.key === 'PageUp' ||
        event.key === 'PageDown' ||
        event.key === 'Home' ||
        event.key === 'End' ||
        event.key === ' ' ||
        event.key === 'w' ||
        event.key === 'W' ||
        event.key === 's' ||
        event.key === 'S'
      ) {
        clearCorrection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
      const want = Math.max(
        0,
        Math.min(initialPageRef.current, pageRefs.current.length - 1),
      );
      const el = pageRefs.current[want];
      if (el && scroller) {
        const fraction = initialFractionRef.current;
        if (typeof fraction === 'number' && Number.isFinite(fraction)) {
          // Overall chapter fraction: resilient to per-page box growth, and
          // re-asserted as images load (see correctFractionRef docs). The X
          // pan applies immediately — widths never grow, so it needs no
          // correction loop.
          const clamped = Math.max(0, Math.min(1, fraction));
          const next = fractionScrollTarget(
            scroller.scrollHeight,
            scroller.clientHeight,
            clamped,
          );
          if (next !== null) scroller.scrollTop = next;
          const panX = initialScrollXRef.current;
          if (typeof panX === 'number' && Number.isFinite(panX)) {
            scroller.scrollLeft = panX;
          }
          armCorrection(clamped);
        } else {
          const top = el.offsetTop - (scroller.clientTop || 0);
          scroller.scrollTop = top;
        }
        restoredRef.current = true;
      } else if (pageRefs.current.length > 0) {
        restoredRef.current = true;
      }
    }

    const update = () => {
      ticking = false;
      const refs = pageRefs.current;
      if (refs.length === 0) return;

      const viewportCenter = (scroller?.clientHeight ?? window.innerHeight) / 2;
      const scrollerTop = scroller?.getBoundingClientRect().top ?? 0;
      let best = refs.length - 1;
      for (let i = 0; i < refs.length; i++) {
        const el = refs[i];
        if (!el) continue;
        const top = el.getBoundingClientRect().top - scrollerTop;
        if (top <= viewportCenter) best = i;
        else break;
      }
      // Image preloading always follows the live position, even mid-settle.
      setCurrentIndex((prev) => (prev === best ? prev : best));

      // While a restore correction is armed, the layout is in violent flux
      // (fallback boxes resolving 12x) and any report would be garbage that
      // gets persisted (observed: page 6→0→1 flaps with mid-flux fractions
      // saved as real progress). Hold the intended restore values instead —
      // the parent's states/refs already carry them, so saves and exit
      // flushes stay correct through settle. Live reporting resumes on
      // disarm (complete/timeout/user input).
      const settling = correctFractionRef.current !== null;
      if (!settling) {
        onPageChangeRef.current(best);

        // Overall chapter fraction + exact horizontal pan for
        // continue-reading saves. Reported every tracking update; the parent
        // keeps them in refs and debounces the server write.
        if (scroller && onScrollFractionRef.current) {
          const fraction = scrollFractionAtOffset(
            scroller.scrollTop,
            scroller.scrollHeight,
            scroller.clientHeight,
          );
          if (fraction !== null) {
            const x = scroller.scrollLeft;
            onScrollFractionRef.current(fraction, Number.isFinite(x) ? x : 0);
          }
        }
      }

      // Calculate scroll ratio within the current page for smooth progress.
      // Gated with the rest while settling (this also calls setPage upstream).
      if (!settling) {
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
            onProgressRef.current(best, progressThroughPage);
          }
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

  return (
    <div
      className={`vertical-reader${
        imageGap ? ' vertical-reader--gap' : ''
      }${currentZoom !== 1 ? ' vertical-reader--zoomed' : ''}`}
      style={{
        ...handlers,
        width: `${verticalReaderWidthPercent(imageWidth)}%`,
        transform: `scale(${currentZoom})`,
        transformOrigin: origin,
      }}
      onClick={handleHalfClick}
      ref={containerRef}
      /* A correction in flight must never fight the user's own scrolling. */
      onWheel={() => clearCorrection()}
      onTouchStart={() => clearCorrection()}
      onPointerDown={() => clearCorrection()}
    >
      <button
        type="button"
        className="paged-reader__zone paged-reader__zone--left"
        onClick={() =>
          onChapterNavigate(direction === 'rtl' ? 'next' : 'prev')
        }
        aria-label="Previous chapter"
      />
      {pages.map((page, index) => (
        <div
          key={`${chapterTag ?? ''}:${page.index}`}
          data-page-index={index}
          ref={(el) => {
            pageRefs.current[index] = el;
          }}
          className="vertical-reader__page"
        >
          <ReaderImage
            page={page}
            eager={eagerPages || index <= (currentIndex + 1) * preloadAhead}
            widthPx={imageWidthPx}
            heightPx={imageHeightPx}
            chapterTag={chapterTag}
            onLoad={() => handlePageLoad(index)}
          />
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