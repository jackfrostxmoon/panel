import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import type { PanelPage } from '@panel/shared';
import { ReaderImage } from './ReaderImage';
import { verticalReaderWidthPercent, type ReadingDirection } from './settings';
import { halfSideFromClientX } from './navigation';
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

  useImperativeHandle(ref, () => ({
    scrollToPage(page: number, preset: GlidePreset = 'quick') {
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
      const want = Math.max(
        0,
        Math.min(initialPageRef.current, pageRefs.current.length - 1),
      );
      const el = pageRefs.current[want];
      if (el && scroller) {
        const top = el.offsetTop - (scroller.clientTop || 0);
        const ratio = initialRatioRef.current;
        if (
          typeof ratio === 'number' &&
          Number.isFinite(ratio) &&
          scroller.clientHeight > 0 &&
          el.offsetHeight > 0
        ) {
          // Invert the viewport-center tracking math (see update() below) so
          // the center sits at the same fraction through the page instead of
          // the page top.
          const clamped = Math.max(0, Math.min(1, ratio));
          scroller.scrollTop = Math.max(
            0,
            top + clamped * el.offsetHeight - scroller.clientHeight / 2,
          );
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