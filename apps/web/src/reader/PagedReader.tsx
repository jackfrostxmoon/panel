import { useCallback, useEffect, useRef } from 'react';
import type { PanelPage } from '@panel/shared';
import { ReaderImage } from './ReaderImage';
import type { ReadingDirection, SpreadOddPolicy } from './settings';
import { isOddSpread, spreadPages, halfSideFromClientX } from './navigation';
import { useZoomGesture } from './useZoomGesture';
import { proxiedPageUrl } from '../utils/format';

/**
 * Paged reader: one page at a time, fitted to the viewport.
 *
 * In **single** mode (default) the stage holds one page and the click zones
 * cover the left/right halves.
 *
 * In **double-page** mode (spread) the stage holds two pages side by side like
 * a printed book: the *current* page is the right sheet in LTR (left in RTL),
 * and its facing page sits next to it. Navigation advances one full spread
 * at a time, and the click zones move to the *outer* edges only — the spine
 * (inner seam) does nothing, which matches the feel of turning a real book.
 *
 * On an odd final spread there is no facing page; the chosen `spreadOddPolicy`
 * decides what fills the empty half. Chapter transitions at the first/last
 * spread are handled by the parent, which owns the full navigation state.
 */
export function PagedReader({
  pages,
  page,
  direction,
  doublePage,
  spreadOddPolicy = 'blank',
  autoLandscapeSingle = true,
  zoom,
  onZoomChange,
  onNavigate,
  /** Chapter global id used as the cache provenance tag. */
  chapterTag = null,
  /**
   * "All at once" mode: fetch every page in the chapter up-front at
   * `fetchpriority="high"` so page turns are instant. When false, the
   * paged reader falls back to its neighbor-spread low-priority
   * preload (the original behaviour, kept for sequential / data-saver
   * users). See the preloader effect for the full rationale.
   */
  eagerPages = false,
  /**
   * Breathing room between the two pages of a spread. When off (the
   * default) the sheets sit flush against the center seam like a
   * printed book; when on, the 2% inner padding + 3px gutter are
   * restored so the pages read as separate images. Vertical and
   * gallery modes toggle the same setting via their own modifier
   * classes — paged mode had a hardcoded gap that ignored it.
   */
  imageGap = false,
  /**
   * Image width as a percent of the reader viewport (the "Image width"
   * slider). Shrinks the stage so a page never overflows — useful for
   * narrow text pages that otherwise look tiny in the full-width stage.
   * 100 % = the old full-width behaviour. Ignored while `fitToHeight`
   * is on (the height constraint drives the layout instead).
   */
  imageWidth = 100,
  fitToHeight = false,
}: {
  pages: PanelPage[];
  page: number;
  direction: ReadingDirection;
  doublePage?: boolean;
  spreadOddPolicy?: SpreadOddPolicy;
  /**
   * T3-6: when the current page is landscape (a scanned two-page spread),
   * drop out of double-page mode so it renders full-width instead of being
   * squeezed into half the stage.
   */
  autoLandscapeSingle?: boolean;
  /** Current zoom level (T2-1). 1.0 = fit. */
  zoom?: number;
  /** Called whenever the zoom changes (pinch). */
  onZoomChange?: (zoom: number) => void;
  /** 'forward' | 'backward' in *reading* direction. */
  onNavigate: (intent: 'forward' | 'backward') => void;
  /** Chapter global id used as the cache provenance tag. */
  chapterTag?: string | null;
  /**
   * When true, the reader preloads every page of the chapter at
   * high priority as soon as the payload arrives — matches the
   * "Image loading: All at once" setting in the settings panel.
   * When false (default), only the next/previous spread is preloaded
   * at low priority, which is enough for normal reading and saves
   * data on metered connections.
   */
  eagerPages?: boolean;
  /** Add spacing between the two pages of a double-page spread. */
  imageGap?: boolean;
  /** Image width as a percent of the reader viewport (see settings). */
  imageWidth?: number;
  /**
   * Fit the page to the viewport height (paged mode only). When on, the
   * image-width slider is ignored and the page is contained vertically so
   * the whole image is visible without scrolling.
   */
  fitToHeight?: boolean;
}) {
  const touchStartX = useRef<number | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const { zoom: currentZoom, origin, handlers, isPinching } = useZoomGesture(stageRef, {
    initialZoom: zoom ?? 1,
    onZoomChange,
  });
  const spread = spreadPages(page, pages.length, direction);

  /* Preload pages so a page turn is instant.
   *
   * Paged mode renders exactly one spread at a time with `eager=true`,
   * so every page turn triggers a fresh fetch + decode. For a 300KB
   * JPEG served from the API's on-disk cache the round-trip is
   * ~150-300 ms; double-page mode decodes two at once (~300-600 ms
   * total). That's the "page turn is sluggish" feel users report
   * against MangaKatana (and any other source where pages are
   * reasonably large).
   *
   * Two preloader strategies, switched on `eagerPages`:
   *
   *  - **Sequential / data-saver** (eagerPages=false, the original
   *    behaviour): mount an off-screen `<img>` for every page of the
   *    previous AND next spreads (single-page mode = 1 page each way,
   *    double-page mode = 2 pages each way). `decoding="async"` +
   *    `fetchpriority="low"` lets the browser fetch them in parallel
   *    with the current spread's already-eager image without
   *    contending for decoder time.
   *
   *  - **Parallel / "All at once"** (eagerPages=true): mount an
   *    off-screen `<img>` for EVERY page in the chapter at
   *    `fetchpriority="high"`. Without this, the "All at once"
   *    setting in the settings panel had no effect on paged mode —
   *    the parent reader fired `new Image()` for every page but with
   *    no priority hint, so the browser dropped those requests to
   *    the bottom of the queue behind the current spread's eager
   *    `<img>`, and only the on-screen page ever finished
   *    downloading. Forcing `high` priority tells the browser these
   *    are required resources that the user has explicitly asked to
   *    be cached, so it schedules them ahead of other background
   *    work.
   *
   * The two strategies live in separate effects so their dependency
   * arrays can differ: the parallel preloader should NOT re-run on
   * every `page` change (that would cancel and re-fire 30+ in-flight
   * requests on every page turn), while the sequential one MUST
   * re-run on every `page` change to keep the neighbor-spread window
   * centred on the current page.
   *
   * Preloaders live in a ref so unmounting them (chapter switch, mode
   * change) doesn't re-trigger React renders. `chapterTag` is keyed
   * into both effects so a chapter switch drops the old preloaders.
   */
  const preloadImgsRef = useRef<HTMLImageElement[]>([]);

  // Sequential-mode preloader: next/prev spread at low priority.
  // Re-runs on every page change so the preload window follows the reader.
  useEffect(() => {
    // Skip when parallel mode owns the preload — avoids the two effects
    // stomping on each other's `preloadImgsRef` mutations.
    if (eagerPages) return;
    // Drop any preloaders from a previous chapter/spread.
    for (const img of preloadImgsRef.current) {
      img.src = '';
    }
    preloadImgsRef.current = [];
    if (!chapterTag) return;

    // Compute which page indices to preload. The current spread in LTR
    // shows `[page-1, page]` and the next is `[p+1, p+2]`; in RTL the
    // current shows `[page+1, page]` and the next is `[p-1, p-2]`.
    // `spreadPages` is the source of truth for these pairings, so we ask
    // it for the next/prev spread and preload the pages it returns.
    const indices: number[] = [];
    const pushSpread = (s: { left: number | null; right: number }) => {
      if (doublePage) {
        if (s.left !== null) indices.push(s.left);
        indices.push(s.right);
      } else {
        indices.push(s.right);
      }
    };
    const nextSpread = spreadPages(page + (direction === 'ltr' ? 2 : -2), pages.length, direction);
    if (nextSpread.right !== page) pushSpread(nextSpread);
    const prevSpread = spreadPages(page + (direction === 'ltr' ? -2 : 2), pages.length, direction);
    if (prevSpread.right !== page) pushSpread(prevSpread);

    if (indices.length === 0) return;
    const imgs: HTMLImageElement[] = [];
    for (const idx of indices) {
      const pageObj = pages[idx];
      if (!pageObj) continue;
      const img = new Image();
      img.decoding = 'async';
      img.fetchPriority = 'low';
      img.referrerPolicy = 'no-referrer';
      img.src = proxiedPageUrl(pageObj, chapterTag);
      imgs.push(img);
    }
    preloadImgsRef.current = imgs;
    return () => {
      for (const img of imgs) img.src = '';
    };
  }, [eagerPages, page, pages, direction, doublePage, chapterTag]);

  // Parallel-mode preloader: every page at high priority.
  // Does NOT depend on `page` — the whole chapter is the preload
  // window, so re-running on every page turn would just cancel and
  // re-fire dozens of in-flight requests, defeating the purpose.
  useEffect(() => {
    if (!eagerPages) return;
    // Drop any preloaders from a previous chapter (the sequential
    // effect may have left some in place if the user just flipped
    // imageLoad from "While scrolling" to "All at once").
    for (const img of preloadImgsRef.current) {
      img.src = '';
    }
    preloadImgsRef.current = [];
    if (!chapterTag) return;
    if (pages.length === 0) return;

    const imgs: HTMLImageElement[] = [];
    for (let i = 0; i < pages.length; i += 1) {
      const pageObj = pages[i];
      if (!pageObj) continue;
      const img = new Image();
      img.decoding = 'async';
      // `high` fetch priority is the whole point of this branch — it
      // tells the browser the user has explicitly opted into "fetch
      // everything", so these requests should NOT be queued behind
      // the current spread's eager `<img>`. Without it, detached
      // `new Image()` requests default to `low` and the bug recurs
      // (only the on-screen page finishes downloading before the
      // user clicks "next").
      img.fetchPriority = 'high';
      img.referrerPolicy = 'no-referrer';
      img.src = proxiedPageUrl(pageObj, chapterTag);
      imgs.push(img);
    }
    preloadImgsRef.current = imgs;
    return () => {
      for (const img of imgs) img.src = '';
    };
  }, [eagerPages, pages, chapterTag]);

  const handleZoneClick = useCallback(
    (zone: 'left' | 'right') => {
      // In LTR the right half advances; in RTL the left half advances.
      const forward =
        (direction === 'ltr' && zone === 'right') || (direction === 'rtl' && zone === 'left');
      onNavigate(forward ? 'forward' : 'backward');
    },
    [direction, onNavigate],
  );

  const onPointerDown = (event: React.PointerEvent) => {
    touchStartX.current = event.clientX;
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const startX = touchStartX.current;
    if (startX === null) return;
    touchStartX.current = null;
    // A two-finger pinch is a zoom, not a swipe — never navigate.
    if (isPinching()) return;
    const delta = event.clientX - startX;
    if (Math.abs(delta) < 48) return; // too small — treat as tap, not swipe
    const swipedTowardForward = direction === 'rtl' ? delta > 0 : delta < 0;
    onNavigate(swipedTowardForward ? 'forward' : 'backward');
  };

  const leftPage = spread.left !== null ? pages[spread.left] : null;
  const rightPage = pages[spread.right];
  if (!rightPage) return null;

  /* T3-6: a landscape page is a scanned two-page spread — render it solo at
     full stage width so it stays readable instead of being halved. */
  const landscapeSolo =
    autoLandscapeSingle &&
    typeof rightPage.width === 'number' &&
    typeof rightPage.height === 'number' &&
    rightPage.width > rightPage.height;
  const odd = isOddSpread(spread);
  const effectiveDoublePage = doublePage && !landscapeSolo && !odd;

  /* Desktop: the overlay zones are pointer-events:none (see reader.css), so
     this reproduces the original "click left/right half" behavior while the
     mousedown still reaches the <img> (native drag / copy image keep working;
     a completed drag suppresses the click, so dragging never turns the page).
     Touch keeps using the physical zone buttons.
     The handler lives on the width-limited viewport (like VerticalReader's
     container), so only clicks around the image threshold navigate — clicks
     on the empty side gutters fall on the outer reader and do nothing. */
  const handleHalfClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.nativeEvent as PointerEvent).pointerType === 'touch') return;
    if ((event.target as HTMLElement).closest('button, a')) return;
    const side = halfSideFromClientX(event.clientX, event.currentTarget.getBoundingClientRect());
    handleZoneClick(side);
  };

  return (
    <div
      className={`paged-reader${effectiveDoublePage ? ' paged-reader--double' : ''}${imageGap ? ' paged-reader--gap' : ''}${fitToHeight ? ' paged-reader--fit-height' : ''}`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      role="region"
      aria-label="Panel page viewer"
      style={{ ['--paged-stage-width' as string]: fitToHeight ? 'auto' : `${imageWidth}%` }}
    >
      <div className="paged-reader__viewport" onClick={handleHalfClick}>
        <button
          type="button"
          className={`paged-reader__zone paged-reader__zone--left${effectiveDoublePage ? ' paged-reader__zone--outer' : ''}`}
          onClick={() => handleZoneClick('left')}
          aria-label="Previous page"
        />
        <button
          type="button"
          className={`paged-reader__zone paged-reader__zone--right${effectiveDoublePage ? ' paged-reader__zone--outer' : ''}`}
          onClick={() => handleZoneClick('right')}
          aria-label="Next page"
        />

        <div
          className="paged-reader__stage"
          ref={stageRef}
          {...handlers}
        >
        {effectiveDoublePage ? (
          <div className="paged-reader__spread">
            {direction === 'ltr' ? (
              <>
                <div className="paged-reader__sheet paged-reader__sheet--left">
                  {leftPage ? (
                    <ReaderImage
                      key={`${chapterTag ?? ''}:${leftPage.index}`}
                      page={leftPage}
                      eager
                      zoom={currentZoom}
                      transformOrigin={origin}
                      chapterTag={chapterTag}
                    />
                  ) : odd && spreadOddPolicy !== 'duplicate' ? (
                    <SpreadPlaceholder policy={spreadOddPolicy} />
                  ) : null}
                </div>
                <div className="paged-reader__seam" aria-hidden="true" />
                <div className="paged-reader__sheet paged-reader__sheet--right">
                  <ReaderImage
                    key={`${chapterTag ?? ''}:${rightPage.index}`}
                    page={rightPage}
                    eager
                    zoom={currentZoom}
                    transformOrigin={origin}
                    chapterTag={chapterTag}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="paged-reader__sheet paged-reader__sheet--left">
                  <ReaderImage
                    key={`${chapterTag ?? ''}:${rightPage.index}`}
                    page={rightPage}
                    eager
                    zoom={currentZoom}
                    transformOrigin={origin}
                    chapterTag={chapterTag}
                  />
                </div>
                <div className="paged-reader__seam" aria-hidden="true" />
                <div className="paged-reader__sheet paged-reader__sheet--right">
                  {leftPage ? (
                    <ReaderImage
                      key={`${chapterTag ?? ''}:${leftPage.index}`}
                      page={leftPage}
                      eager
                      zoom={currentZoom}
                      transformOrigin={origin}
                      chapterTag={chapterTag}
                    />
                  ) : odd && spreadOddPolicy !== 'duplicate' ? (
                    <SpreadPlaceholder policy={spreadOddPolicy} />
                  ) : null}
                </div>
              </>
            )}
          </div>
        ) : (
          <ReaderImage
            key={`${chapterTag ?? ''}:${rightPage.index}`}
            page={rightPage}
            eager
            zoom={currentZoom}
            transformOrigin={origin}
            chapterTag={chapterTag}
          />
        )}
        </div>
      </div>
    </div>
  );
}

/** Fills the empty half of an odd spread. */
function SpreadPlaceholder({ policy }: { policy: SpreadOddPolicy }) {
  if (policy === 'blank') {
    return <div className="paged-reader__sheet-placeholder" aria-hidden="true" />;
  }
  // 'duplicate' and 'single' are handled by CSS modifier classes.
  return null;
}
