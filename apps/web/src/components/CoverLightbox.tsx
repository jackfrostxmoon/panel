import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconX, IconZoomIn, IconZoomOut } from './icons';

/** Fit view is scale 1; zoom goes up to MAX_SCALE. */
const MIN_SCALE = 1;
const MAX_SCALE = 6;
const ZOOM_STEP = 1.4;

interface Point {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

/**
 * Full-viewport lightbox for the details-page cover image.
 *
 * Zooming enlarges the image's actual layout box (not a clipped transform):
 * the stage is sized `fit × scale`, the overlay becomes a native scrollport,
 * and the pointer drag pans by scrolling it. So a bigger zoom means a
 * genuinely bigger image — you scroll to see the rest of it. Range is
 * 100%–600%.
 *
 * Interactions: wheel zooms toward the cursor, the −/+ buttons (and the
 * percentage button to reset) zoom around the center, double-click toggles
 * fit ↔ 250%, and dragging pans while zoomed in. The ✕ button, Escape, or
 * clicking the padding outside the image close the lightbox.
 */
export function CoverLightbox({
  title,
  src,
  onClose,
}: {
  title: string;
  src: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [natural, setNatural] = useState<Size | null>(null);
  const [viewport, setViewport] = useState<Size>(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ pointer: Point; scroll: Point } | null>(null);
  /** Set during a zoom gesture; consumed in useLayoutEffect to keep the image point under the cursor stationary. */
  const anchorRef = useRef<{ ix: number; iy: number; clientX: number; clientY: number } | null>(null);
  /** Controls auto-hide: visible until IDLE_MS pass without pointer movement. */
  const IDLE_MS = 2500;
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef<number | null>(null);
  const lastMoveRef = useRef(0);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setControlsVisible(false), IDLE_MS);
  }, []);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  // Start the idle countdown on mount; clear it on unmount.
  useEffect(() => {
    scheduleHide();
    return () => {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    };
  }, [scheduleHide]);

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /** Size of the stage at 100% — the largest box with the cover's aspect ratio that fits the viewport. */
  const fit = useMemo(() => {
    if (!natural) return null;
    const maxWidth = Math.min(viewport.width * 0.94, 1100);
    const maxHeight = Math.min(viewport.height * 0.86, 1100);
    const s = Math.min(maxWidth / natural.width, maxHeight / natural.height);
    return {
      width: Math.max(1, Math.floor(natural.width * s)),
      height: Math.max(1, Math.floor(natural.height * s)),
    };
  }, [natural, viewport]);

  const stageSize = fit
    ? { width: Math.floor(fit.width * scale), height: Math.floor(fit.height * scale) }
    : null;

  // Move focus into the dialog on open, close on Escape.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // After a zoom re-render, scroll the overlay so the image point under the
  // cursor (ix/iy within the image) lands back under the cursor.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || !fit) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const newWidth = fit.width * scale;
    const newHeight = fit.height * scale;
    overlay.scrollLeft = anchor.ix * newWidth - anchor.clientX;
    overlay.scrollTop = anchor.iy * newHeight - anchor.clientY;
    anchorRef.current = null;
  }, [scale, fit]);

  /** Zoom toward `nextRaw`. `clientPoint` is the viewport point to anchor on (defaults to image center). */
  const zoomTo = useCallback(
    (nextRaw: number, clientPoint?: Point) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextRaw));
      if (next === scale) return;
      const stage = stageRef.current;
      const rect = stage?.getBoundingClientRect();
      const fallback = rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      const point = clientPoint ?? fallback;
      const ix = rect && rect.width > 0 ? Math.min(1, Math.max(0, (point.x - rect.left) / rect.width)) : 0.5;
      const iy = rect && rect.height > 0 ? Math.min(1, Math.max(0, (point.y - rect.top) / rect.height)) : 0.5;
      anchorRef.current = { ix, iy, clientX: point.x, clientY: point.y };
      setScale(next);
    },
    [scale],
  );

  // Wheel zoom needs a non-passive listener so the page behind doesn't scroll.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      showControls();
      const factor = Math.exp(-event.deltaY * 0.0018);
      zoomTo(scale * factor, { x: event.clientX, y: event.clientY });
    };
    overlay.addEventListener('wheel', onWheel, { passive: false });
    return () => overlay.removeEventListener('wheel', onWheel);
  }, [scale, zoomTo, showControls]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    showControls();
    if (event.button !== 0 || scale <= 1) return;
    if ((event.target as HTMLElement).closest('button')) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.setPointerCapture(event.pointerId);
    panRef.current = {
      pointer: { x: event.clientX, y: event.clientY },
      scroll: { x: overlay.scrollLeft, y: overlay.scrollTop },
    };
    setPanning(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    // Throttled: any mouse movement reveals the controls and resets the idle timer.
    const now = performance.now();
    if (now - lastMoveRef.current > 120) {
      lastMoveRef.current = now;
      showControls();
    }
    const pan = panRef.current;
    const overlay = overlayRef.current;
    if (!pan || !overlay) return;
    overlay.scrollLeft = pan.scroll.x - (event.clientX - pan.pointer.x);
    overlay.scrollTop = pan.scroll.y - (event.clientY - pan.pointer.y);
  };

  const endPan = () => {
    panRef.current = null;
    setPanning(false);
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    zoomTo(scale > 1 ? 1 : 2.5, { x: event.clientX, y: event.clientY });
  };

  const zoomed = scale > 1;

  return (
    <>
      <div
        ref={overlayRef}
        className={`cover-lightbox__overlay${zoomed ? ' cover-lightbox__overlay--zoomed' : ''}${panning ? ' cover-lightbox__overlay--panning' : ''}${controlsVisible ? '' : ' cover-lightbox__overlay--idle'}`}
        role="dialog"
        aria-modal="true"
        aria-label={`Cover image for ${title}`}
        onClick={(event) => {
          // While zoomed the pointer is captured for panning, so every
          // release lands on the overlay — don't treat that as a backdrop
          // click. Close via the ✕ button or Escape instead.
          if (scale > 1) return;
          if (event.target === event.currentTarget) onClose();
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onDoubleClick={handleDoubleClick}
      >
        <div
          ref={stageRef}
          className="cover-lightbox__stage"
          style={stageSize ?? undefined}
        >
          <img
            src={src}
            alt={`Cover of ${title}`}
            className="cover-lightbox__img"
            draggable={false}
            onLoad={(event) =>
              setNatural({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
          />
        </div>
      </div>
      <div
        className={`cover-lightbox__controls${controlsVisible ? '' : ' cover-lightbox__controls--hidden'}`}
        onFocusCapture={showControls}
        onBlurCapture={scheduleHide}
      >
        <button
          ref={closeRef}
          type="button"
          className="cover-lightbox__close"
          aria-label="Close cover view"
          onClick={onClose}
        >
          <IconX size={18} />
        </button>
        <div className="cover-lightbox__toolbar" role="toolbar" aria-label="Zoom controls">
          <button
            type="button"
            className="cover-lightbox__zoom-btn"
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => zoomTo(scale / ZOOM_STEP)}
            disabled={scale <= MIN_SCALE}
          >
            <IconZoomOut size={16} />
          </button>
          <button
            type="button"
            className="cover-lightbox__zoom-value"
            aria-label="Reset zoom to fit"
            title="Reset zoom to fit"
            onClick={() => setScale(1)}
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            className="cover-lightbox__zoom-btn"
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => zoomTo(scale * ZOOM_STEP)}
            disabled={scale >= MAX_SCALE}
          >
            <IconZoomIn size={16} />
          </button>
        </div>
        <p className="cover-lightbox__hint" aria-hidden="true">
          Scroll to zoom · Drag to pan · Double-click toggles
        </p>
      </div>
    </>
  );
}
