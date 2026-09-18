import { useEffect, useRef, useState, useCallback, type RefObject } from 'react';
import {
  PINCH_ZOOM_MAX,
  PINCH_ZOOM_MIN,
  startPinch,
  transformOriginFor,
  updatePinch,
  type PinchState,
} from './usePinchZoom';

/** Convert a React/DOM pointer event into the structural sample the pinch
 * math consumes (clientX/clientY/pointerId only). */
function toPointerSample(event: {
  clientX: number;
  clientY: number;
  pointerId: number;
}) {
  return { clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId };
}

export interface ZoomGestureOptions {
  /** The persisted zoom level (e.g. from settings). Gesture changes are
   * reported back through `onZoomChange` so the parent can persist them. */
  initialZoom?: number;
  onZoomChange?: (zoom: number) => void;
}

/**
 * Pinch-to-zoom gesture driver (T2-1).
 *
 * Attach the returned handlers to a scroll container. Two-finger pinch
 * zooms the content around the pinch midpoint; releasing resets the
 * tracking state. The hook owns the zoom value: it starts at `initialZoom`
 * (the persisted setting) and reports every gesture change via
 * `onZoomChange`, so the parent persists it while the hook's `zoom` is the
 * single source of truth for rendering.
 *
 * Usage:
 *   const { zoom, origin, handlers, isPinching } = useZoomGesture(containerRef, {
 *     initialZoom: settings.zoomLevel,
 *     onZoomChange: (z) => update({ zoomLevel: z }),
 *   });
 *   <div ref={containerRef} {...handlers}>
 *     <img style={{ transform: `scale(${zoom})`, transformOrigin: origin }} />
 *   </div>
 */
export function useZoomGesture(
  containerRef: RefObject<HTMLElement | null>,
  { initialZoom = 1, onZoomChange }: ZoomGestureOptions = {},
) {
  const [zoom, setZoom] = useState(initialZoom);
  const [origin, setOrigin] = useState('center center');
  const pinchRef = useRef<PinchState | null>(null);
  const activePointers = useRef<Map<number, { clientX: number; clientY: number; pointerId: number }>>(new Map());
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;

  // Follow external zoom changes (settings panel, persisted restore) but
  // never clobber an in-flight gesture.
  useEffect(() => {
    if (!pinchRef.current) setZoom(initialZoom);
  }, [initialZoom]);

  // Report gesture-driven zoom changes so the parent can persist them.
  const lastReportedRef = useRef(initialZoom);
  useEffect(() => {
    if (zoom !== lastReportedRef.current) {
      lastReportedRef.current = zoom;
      onZoomChangeRef.current?.(zoom);
    }
  }, [zoom]);

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const map = activePointers.current;
    map.set(event.pointerId, toPointerSample(event));
    // Two pointers down = pinch start.
    if (map.size >= 2) {
      const [a, b] = Array.from(map.values()) as [
        { clientX: number; clientY: number; pointerId: number },
        { clientX: number; clientY: number; pointerId: number },
      ];
      pinchRef.current = startPinch(a, b, zoom);
      // Capture both pointers on the container so every move/up reaches us
      // during the pinch. Capture must NOT happen on plain single-pointer
      // down: an active pointer capture suppresses the browser's native
      // drag-and-drop, which would make reader images un-draggable (no
      // drag-out / copy image) on desktop.
      const el = containerRef.current;
      for (const pointerId of map.keys()) el?.setPointerCapture?.(pointerId);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const map = activePointers.current;
    if (!pinchRef.current || map.size < 2) return;
    map.set(event.pointerId, toPointerSample(event));
    const [a, b] = Array.from(map.values()) as [
      { clientX: number; clientY: number; pointerId: number },
      { clientX: number; clientY: number; pointerId: number },
    ];
    const result = updatePinch(pinchRef.current, a, b);
    if (!result) return;
    setZoom(result.zoom);
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) setOrigin(transformOriginFor(result.midX, result.midY, rect));
  };

  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    activePointers.current.delete(event.pointerId);
    if (activePointers.current.size < 2) {
      // Pinch over (or a single pointer lifted): release the captures taken
      // at pinch start. Releasing a pointer that was never captured is a
      // harmless no-op per the spec.
      containerRef.current?.releasePointerCapture?.(event.pointerId);
      pinchRef.current = null;
    }
  };

  /** True while a two-finger pinch is in progress (call in swipe handlers). */
  const isPinching = useCallback(() => pinchRef.current !== null, []);

  // Keep the container from scrolling while two fingers are down.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const prevent = (event: WheelEvent) => {
      if (activePointers.current.size >= 2) event.preventDefault();
    };
    el.addEventListener('wheel', prevent, { passive: false });
    return () => el.removeEventListener('wheel', prevent);
  }, [containerRef]);

  return {
    zoom,
    origin,
    setZoom,
    isPinching,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
    },
    PINCH_MIN: PINCH_ZOOM_MIN,
    PINCH_MAX: PINCH_ZOOM_MAX,
  };
}