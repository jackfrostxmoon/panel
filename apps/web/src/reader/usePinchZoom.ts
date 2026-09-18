/**
 * Pinch-to-zoom (T2-1).
 *
 * Pure gesture logic extracted from the readers so the math is trivially
 * unit-testable without a DOM. Two-finger pinch scales the image around the
 * midpoint of the two pointers; a single-finger tap does nothing.
 *
 * The hook is intentionally gesture-only — it reports deltas and lets the
 * caller clamp/persist the result. The readers call it from their
 * `pointerdown/move/up` handlers.
 *
 * Uses a structural pointer type (just clientX/clientY) so it works with
 * both React's `PointerEvent` and the DOM `PointerEvent` without the
 * React/DOM generic mismatch.
 */

const PINCH_MIN = 0.5;
const PINCH_MAX = 4;
/** Per-pinch-delta sensitivity so a normal pinch isn't jumpy. */
const PINCH_SENSITIVITY = 0.002;

/** The only fields the pinch math needs from a pointer event. */
export interface PointerSample {
  clientX: number;
  clientY: number;
  pointerId: number;
}

export interface PinchState {
  /** Distance between the two pointers at pinch start. */
  startDistance: number;
  /** Running zoom multiplier at pinch start. */
  startZoom: number;
  /** Midpoint x in client coords at pinch start. */
  midX: number;
  /** Midpoint y in client coords at pinch start. */
  midY: number;
}

export interface PinchDelta {
  /** New absolute zoom (clamped to [PINCH_MIN, PINCH_MAX]). */
  zoom: number;
  /** Midpoint x in client coords for this sample. */
  midX: number;
  /** Midpoint y in client coords for this sample. */
  midY: number;
}

function toSample(p: { clientX: number; clientY: number; pointerId: number }): PointerSample {
  return { clientX: p.clientX, clientY: p.clientY, pointerId: p.pointerId };
}

/**
 * Distance between two pointer events.
 */
export function pointerDistance(a: PointerSample, b: PointerSample): number {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

/**
 * Midpoint of two pointer events.
 */
export function pointerMidpoint(a: PointerSample, b: PointerSample): { x: number; y: number } {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

/**
 * Start a pinch from the first two pointer-down events. Accepts any
 * object with `clientX/clientY/pointerId` (React or DOM PointerEvent).
 */
export function startPinch(
  a: { clientX: number; clientY: number; pointerId: number },
  b: { clientX: number; clientY: number; pointerId: number },
  currentZoom: number,
): PinchState {
  const sa = toSample(a);
  const sb = toSample(b);
  const mid = pointerMidpoint(sa, sb);
  return {
    startDistance: pointerDistance(sa, sb),
    startZoom: currentZoom,
    midX: mid.x,
    midY: mid.y,
  };
}

/**
 * While a pinch is in progress, compute the new zoom from a pair of
 * pointer-move events. Returns null when the pinch has collapsed (the two
 * pointers merged) so the caller can fall back to a tap.
 */
export function updatePinch(
  state: PinchState,
  a: { clientX: number; clientY: number; pointerId: number },
  b: { clientX: number; clientY: number; pointerId: number },
): PinchDelta | null {
  const sa = toSample(a);
  const sb = toSample(b);
  const distance = pointerDistance(sa, sb);
  if (distance < 2) return null; // collapsed — not a pinch anymore
  const ratio = distance / Math.max(1, state.startDistance);
  const zoom = clampZoom(state.startZoom * (1 + (ratio - 1) * (1 / PINCH_SENSITIVITY)));
  const mid = pointerMidpoint(sa, sb);
  return { zoom, midX: mid.x, midY: mid.y };
}

/**
 * Convert a client-coordinate midpoint into a CSS transform-origin
 * relative to the target element. Returns "center center" when the
 * element has no size (e.g. before layout).
 */
export function transformOriginFor(midX: number, midY: number, rect: DOMRect): string {
  if (rect.width <= 0 || rect.height <= 0) return 'center center';
  const x = ((midX - rect.left) / rect.width) * 100;
  const y = ((midY - rect.top) / rect.height) * 100;
  return `${Math.max(0, Math.min(100, x))}% ${Math.max(0, Math.min(100, y))}%`;
}

export function clampZoom(zoom: number): number {
  return Math.max(PINCH_MIN, Math.min(PINCH_MAX, zoom));
}

export const PINCH_ZOOM_MIN = PINCH_MIN;
export const PINCH_ZOOM_MAX = PINCH_MAX;