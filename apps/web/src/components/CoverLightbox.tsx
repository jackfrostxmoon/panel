import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
 * The proxied cover is the only resolution we get from the source, so once
 * the image loads the stage is sized to the cover's aspect ratio (upscaled
 * as far as the viewport allows) — there are no letterbox bars. The user can
 * inspect it interactively: wheel / buttons / double-click to zoom, drag to
 * pan while zoomed, and a percentage button to reset to fit. Zoom range is
 * 100%–600%.
 *
 * Closes on the backdrop (padding area outside the stage), the ✕ button,
 * or Escape.
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
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointer: Point; offset: Point } | null>(null);
  /** Intrinsic image size, learned on load — used to size the stage to the
      cover's aspect ratio so there are no empty letterbox bars. */
  const [natural, setNatural] = useState<Size | null>(null);
  const [viewport, setViewport] = useState<Size>(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /** Stage dimensions: the largest box with the cover's aspect ratio that
      fits the viewport (upscales small covers). Null until the image loads —
      the CSS fallback keeps a sensible default size in the meantime. */
  const stageSize = useMemo(() => {
    if (!natural) return null;
    const maxWidth = Math.min(viewport.width * 0.94, 1100);
    const maxHeight = Math.min(viewport.height * 0.86, 1100);
    const fit = Math.min(maxWidth / natural.width, maxHeight / natural.height);
    return {
      width: Math.max(1, Math.floor(natural.width * fit)),
      height: Math.max(1, Math.floor(natural.height * fit)),
    };
  }, [natural, viewport]);

  /** Keep the pan offset inside a sane range for the current zoom level. */
  const clampOffset = useCallback((value: Point, s: number): Point => {
    const rect = stageRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 0;
    const h = rect?.height ?? 0;
    const slack = s > 1 ? 80 : 0;
    const maxX = Math.max(0, (w * (s - 1)) / 2) + slack;
    const maxY = Math.max(0, (h * (s - 1)) / 2) + slack;
    return {
      x: Math.min(maxX, Math.max(-maxX, value.x)),
      y: Math.min(maxY, Math.max(-maxY, value.y)),
    };
  }, []);

  /** Zoom to `nextRaw`, keeping the stage point `focus` (defaults to the stage center) fixed. */
  const zoomTo = useCallback(
    (nextRaw: number, focus?: Point) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextRaw));
      if (next === 1) {
        setScale(1);
        setOffset({ x: 0, y: 0 });
        return;
      }
      const rect = stageRef.current?.getBoundingClientRect();
      const center = rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      const p = focus ?? center;
      // Keep the point under the cursor stationary: solve for the offset
      // that maps the same pre-scale point onto the same screen position.
      const q = {
        x: (p.x - center.x - offset.x) / scale,
        y: (p.y - center.y - offset.y) / scale,
      };
      setScale(next);
      setOffset(
        clampOffset(
          {
            x: p.x - center.x - q.x * next,
            y: p.y - center.y - q.y * next,
          },
          next,
        ),
      );
    },
    [scale, offset, clampOffset],
  );

  // Move focus into the dialog on open, close on Escape.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Wheel zoom needs a non-passive listener so the page behind doesn't scroll.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0018);
      zoomTo(scale * factor, { x: event.clientX, y: event.clientY });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [scale, zoomTo]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || scale <= 1) return;
    // A second simultaneous pointer (e.g. pinch) must not steal the drag.
    if (dragRef.current) return;
    // Let the close/zoom buttons handle their own presses — capturing the
    // pointer on the stage would swallow their click events.
    if ((event.target as HTMLElement).closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointer: { x: event.clientX, y: event.clientY },
      offset,
    };
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setOffset(
      clampOffset(
        {
          x: drag.offset.x + (event.clientX - drag.pointer.x),
          y: drag.offset.y + (event.clientY - drag.pointer.y),
        },
        scale,
      ),
    );
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    zoomTo(scale > 1 ? 1 : 2.5, { x: event.clientX, y: event.clientY });
  };

  const zoomed = scale > 1;

  return (
    <div
      className="cover-lightbox__overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={stageRef}
        className={`cover-lightbox__stage${zoomed ? ' cover-lightbox__stage--zoomed' : ''}${dragging ? ' cover-lightbox__stage--dragging' : ''}`}
        style={stageSize ?? undefined}
        role="dialog"
        aria-modal="true"
        aria-label={`Cover image for ${title}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={handleDoubleClick}
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
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        />
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
            onClick={() => {
              setScale(1);
              setOffset({ x: 0, y: 0 });
            }}
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
    </div>
  );
}
