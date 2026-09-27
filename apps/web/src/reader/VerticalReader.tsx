import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import type { PanelPage } from '@panel/shared';
import { ReaderImage } from './ReaderImage';
import { verticalReaderWidthPercent, type ReadingDirection } from './settings';
import { halfSideFromClientX, ratioScrollTarget } from './navigation';
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
  /**
   * Jump to a page. `ratio` (0–1) lands at the same viewport-center
   * fraction through the page instead of the page top — used for precise
   * continue-reading restores. Null/omitted = page top.
   */
  scrollToPage: (page: number, preset?: GlidePreset, ratio?: number | null) => void;
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
     * Viewport-center fraction through `initialPage` (0–1) to restore on
     * mount. Without this a refresh always lands at the top of the restored
     * page instead of the exact spot the user was reading. Read once on
     * mount; falls back to page-top when absent. Vertical-only.
     */
    initialRatio?: number | null;
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
    onChapterNavigate,
    chapterTag = null,
    direction = 'ltr',
    initialPage = 0,
    initialRatio = null,
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
  /** Jump to `initialPage` once on mount (see prop docs). */
  const restoredRef = useRef(false);
  const initialPageRef = useRef(initialPage);
  initialPageRef.current = initialPage;
  const initialRatioRef = useRef(initialRatio);
  initialRatioRef.current = initialRatio;
  /**
   * Precise-restore correction: a ratio jump computed against unloaded
   * (fallback-box) layout lands wrong — sources like `mr` serve ultra-tall
   * strips (~12x the 2/3 placeholder) with no dimensions, so every image
   * load above the target shifts it. While armed, each image load at or
   * above the target re-asserts the position against the fresh layout until
   * everything above it resolves (exact from then on), the user takes over,
   * or a timeout fires. Corrections write scrollTop directly (no glide) so
   * rapid successive loads converge without animation fighting.
   */
  const correctTargetRef = useRef<{ page: number; ratio: number } | null>(null);
  const correctTimerRef = useRef<number>(0);
  /** Page indices whose images reported loaded (drives correction disarm). */
  const loadedPagesRef = useRef<Set<number>>(new Set());

  const clearCorrection = () => {
    correctTargetRef.current = null;
    window.clearTimeout(correctTimerRef.current);
    correctTimerRef.current = 0;
  };

  /** Recompute the armed target against current layout; direct write. */
  const reassertCorrection = (): void => {
    const target = correctTargetRef.current;
    if (!target) return;
    const el = pageRefs.current[target.page];
    const scroller = el?.closest('.reader-content') as HTMLElement | null;
    if (!el || !scroller) return;
    const next = ratioScrollTarget(
      el.offsetTop - (scroller.clientTop || 0),
      el.offsetHeight,
      scroller.clientHeight,
      target.ratio,
    );
    if (next !== null) scroller.scrollTop = next;
  };

  const armCorrection = (page: number, ratio: number) => {
    correctTargetRef.current = { page, ratio };
    window.clearTimeout(correctTimerRef.current);
    // Bounded: never fight the user or loop forever.
    correctTimerRef.current = window.setTimeout(clearCorrection, 5000);
  };

  const handlePageLoad = (index: number) => {
    loadedPagesRef.current.add(index);
    const target = correctTargetRef.current;
    if (!target || index > target.page) return;
    // Layout grew as this image resolved — re-assert against fresh offsets.
    reassertCorrection();
    // Everything up to and including the target resolved: layout above the
    // target is final, so the position is exact from here on.
    let complete = true;
    for (let i = 0; i <= target.page; i++) {
      if (!loadedPagesRef.current.has(i)) {
        complete = false;
        break;
      }
    }
    if (complete) clearCorrection();
  };

  useImperativeHandle(ref, () => ({
    scrollToPage(page: number, preset: GlidePreset = 'quick', ratio?: number | null) {
      clearCorrection();
      const el = pageRefs.current[page];
      if (!el) return;
      const scroller = el.closest('.reader-content') as HTMLElement | null;
      if (scroller) {
        const top = el.offsetTop - (scroller.clientTop || 0);
        // Precise restore: invert the viewport-center tracking math (see
        // update() below) so the center sits at the same fraction through
        // the page instead of the page top. Same math as the mount restore.
        if (typeof ratio === 'number' && Number.isFinite(ratio)) {
          const clamped = Math.max(0, Math.min(1, ratio));
          // Best-effort immediate jump (layout may still be fallback
          // boxes); the armed correction converges as images load.
          const next = ratioScrollTarget(top, el.offsetHeight, scroller.clientHeight, clamped);
          if (next !== null) glideScrollTo(scroller, next, glideAnimRef, preset);
          armCorrection(page, clamped);
        } else {
          glideScrollTo(scroller, top, glideAnimRef, preset);
        }
      } else {
        el.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    },
  }));

  /* Fresh image set (chapter change): forget loaded state + disarm. Runs
     before the tracking effect below, which re-arms for the new chapter. */
  useEffect(() => {
    loadedPagesRef.current = new Set();
    correctTargetRef.current = null;
    return () => window.clearTimeout(correctTimerRef.current);
  }, [pages.length]);

  /* Keyboard scrolling bypasses scrollToPage (which disarms) — yield the
     armed correction as soon as the user drives with keys. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!correctTargetRef.current) return;
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
        const top = el.offsetTop - (scroller.clientTop || 0);
        const ratio = initialRatioRef.current;
        if (typeof ratio === 'number' && Number.isFinite(ratio)) {
          // Invert the viewport-center tracking math (see update() below) so
          // the center sits at the same fraction through the page instead of
          // the page top. Layout is usually still fallback boxes here, so
          // arm the same settle correction as scrollToPage.
          const clamped = Math.max(0, Math.min(1, ratio));
          const next = ratioScrollTarget(top, el.offsetHeight, scroller.clientHeight, clamped);
          if (next !== null) scroller.scrollTop = next;
          armCorrection(want, clamped);
        } else {
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
      onPageChangeRef.current(best);
      setCurrentIndex((prev) => (prev === best ? prev : best));

      // Calculate scroll ratio within the current page for smooth progress
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
      onWheel={clearCorrection}
      onTouchStart={clearCorrection}
      onPointerDown={clearCorrection}
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