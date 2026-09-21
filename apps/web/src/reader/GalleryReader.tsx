import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import type { PanelPage } from '@panel/shared';
import { ReaderImage } from './ReaderImage';
import { galleryColumnMinMax, type ReadingDirection } from './settings';
import type { GlidePreset } from './settings';
import { halfSideFromClientX } from './navigation';
import { useZoomGesture } from './useZoomGesture';
import { glideScrollTo } from './glideScroll';

/**
 * Gallery reader: all pages laid out in a responsive CSS grid, with
 * scroll-position tracking for the page closest to the viewport center.
 *
 * The parent controls page changes; scrolling reports progress upward via
 * onPageChange, and scrollToPage() jumps to a page (continue-reading).
 */
export interface GalleryReaderHandle {
  scrollToPage: (page: number, preset?: GlidePreset) => void;
}

export const GalleryReader = forwardRef<
  GalleryReaderHandle,
  {
    pages: PanelPage[];
    /** Image width as a percent of the reader viewport (see settings). */
    imageWidth: number;
    imageWidthPx: number | null;
    imageHeightPx: number | null;
    imageGap: boolean;
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
  }
>(function GalleryReader(
  {
    pages,
    imageWidth,
    imageWidthPx,
    imageHeightPx,
    imageGap,
    zoom,
    onZoomChange,
    onPageChange,
    onProgress,
    onChapterNavigate,
    chapterTag = null,
    direction = 'ltr',
    initialPage = 0,
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
  const onPageChangeRef = useRef(onPageChange);
  onPageChangeRef.current = onPageChange;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  /** Jump to `initialPage` once on mount (see prop docs). */
  const restoredRef = useRef(false);
  const initialPageRef = useRef(initialPage);
  initialPageRef.current = initialPage;

  useImperativeHandle(ref, () => ({
    scrollToPage(page: number, preset: GlidePreset = 'quick') {
      const el = pageRefs.current[page];
      if (!el) return;
      // Custom rAF glide on .reader-content avoids conflicting native
      // smooth-scroll animations on rapid keyboard presses.
      const scroller = el.closest('.reader-content') as HTMLElement | null;
      if (scroller) {
        const rect = el.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        const currentScroll = scroller.scrollTop;
        // Center the element in the scroller viewport
        const targetTop = currentScroll + rect.top - scrollerRect.top - scroller.clientHeight / 2 + rect.height / 2;
        glideScrollTo(scroller, Math.max(0, targetTop), glideAnimRef, preset);
      } else {
        el.scrollIntoView({ behavior: 'auto', block: 'center' });
      }
    },
  }));

  // Track the page at the viewport center. Uses scroll-position math rather
  // than intersection-ratio thresholds so tracking stays correct for any page
  // size (tall pages may never reach an intersection-ratio threshold).
  useEffect(() => {
    const scroller =
      containerRef.current?.closest('.reader-content') as HTMLElement | null;
    const target: HTMLElement | Window = scroller ?? window;
    let ticking = false;

    // A mode switch mounts this reader at scrollTop 0 while the parent still
    // holds the current page. Jump back there BEFORE the first tracking
    // update — otherwise update() sees the top and reports page 0, wiping
    // the preserved position. Centers the page, mirroring scrollToPage.
    // Runs once; aspect-ratio boxes keep offsets stable even before images
    // finish loading.
    if (!restoredRef.current) {
      const want = Math.max(
        0,
        Math.min(initialPageRef.current, pageRefs.current.length - 1),
      );
      const el = pageRefs.current[want];
      if (el && scroller) {
        const rect = el.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        const targetTop =
          scroller.scrollTop +
          rect.top -
          scrollerRect.top -
          scroller.clientHeight / 2 +
          rect.height / 2;
        scroller.scrollTop = Math.max(0, targetTop);
        restoredRef.current = true;
      } else if (pageRefs.current.length > 0) {
        restoredRef.current = true;
      }
    }

    const update = () => {
      ticking = false;
      const refs = pageRefs.current;
      if (refs.length === 0) return;

      const centerY = window.innerHeight / 2;
      let best = refs.length - 1;
      for (let i = 0; i < refs.length; i++) {
        const el = refs[i];
        if (!el) continue;
        const top = el.getBoundingClientRect().top;
        if (top <= centerY) best = i;
        else break;
      }
      onPageChangeRef.current(best);

      // Calculate scroll ratio within the current page for smooth progress
      const currentEl = refs[best];
      if (currentEl && onProgressRef.current) {
        const rect = currentEl.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const pageTop = rect.top;
        const pageBottom = rect.bottom;
        const pageHeight = pageBottom - pageTop;

        if (pageHeight > 0) {
          // Ratio of how far the viewport center has progressed through this page
          const progressThroughPage = Math.max(
            0,
            Math.min(1, (viewportHeight / 2 - pageTop) / pageHeight),
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

/* A user-set pixel width also drives the grid: each column becomes that wide, so
      the number of images per row shrinks as the size grows. When blank, the
      width percent slider sets the column floor (fit 200px ↔ full 480px). */
  const columnsStyle =
    typeof imageWidthPx === 'number' && imageWidthPx > 0
      ? { gridTemplateColumns: `repeat(auto-fill, minmax(${imageWidthPx}px, 1fr))` }
      : { gridTemplateColumns: `repeat(auto-fill, minmax(${galleryColumnMinMax(imageWidth)}px, 1fr))` };

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
      className={`gallery-reader${imageGap ? ' gallery-reader--gap' : ''}${
        currentZoom !== 1 ? ' gallery-reader--zoomed' : ''
      }`}
      style={{
        ...columnsStyle,
        ...handlers,
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
          key={page.index}
          data-page-index={index}
          ref={(el) => {
            pageRefs.current[index] = el;
          }}
          className="gallery-reader__page"
        >
          <ReaderImage
            page={page}
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