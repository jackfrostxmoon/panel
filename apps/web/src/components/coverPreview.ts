import { getProxiedImageUrl } from '../utils/format';

/** Minimum data needed to show a floating cover preview for a list row. */
export interface PreviewCover {
  source: string;
  coverUrl: string | null;
  panelId: string | null;
  title: string;
}

const OFFSET_X = 20;
const OFFSET_Y = 16;
const MARGIN = 8;

/**
 * Imperative floating cover preview — deliberately NOT React state.
 *
 * The previous implementation kept the preview in page-level `useState`,
 * so every title hover enter/leave re-rendered the whole page (toolbar,
 * filters, every card, pagination) and mounted/unmounted a `CoverImage`.
 * That full-page reconcile per hover is what made showing/hiding laggy.
 *
 * This manager owns one persistent DOM node (reused across hovers, so no
 * DOM churn and no image refetch — the browser cache serves repeat
 * covers) and moves it with write-only transform updates. Hovering never
 * triggers a React render.
 */
let box: HTMLDivElement | null = null;
let img: HTMLImageElement | null = null;
let currentSrc: string | null = null;
let raf = 0;
let pos = { x: 0, y: 0 };
/** Measured once — the box is a fixed 200px × 2/3, so no per-frame reads. */
let size: { w: number; h: number } | null = null;
let listening = false;

/** Hover previews only make sense with a fine pointer — touch gets plain rows. */
function canHoverPreview(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches;
}

function ensure(): boolean {
  if (box && img) return true;
  if (typeof document === 'undefined') return false;
  box = document.createElement('div');
  box.className = 'cover-preview';
  box.setAttribute('aria-hidden', 'true');
  box.style.display = 'none';
  img = document.createElement('img');
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.draggable = false;
  img.alt = '';
  box.appendChild(img);
  document.body.appendChild(box);
  return true;
}

function place(): void {
  raf = 0;
  if (!box) return;
  if (!size) {
    const rect = box.getBoundingClientRect();
    size = { w: rect.width || 200, h: rect.height || 300 };
  }
  const { x, y } = pos;
  const { w, h } = size;
  let left = x + OFFSET_X;
  if (left + w > window.innerWidth - MARGIN) left = x - w - OFFSET_X;
  let top = y + OFFSET_Y;
  if (top + h > window.innerHeight - MARGIN) {
    top = Math.max(MARGIN, window.innerHeight - h - MARGIN);
  }
  box.style.transform = `translate(${Math.max(MARGIN, left)}px, ${Math.max(MARGIN, top)}px)`;
}

function onMove(event: MouseEvent): void {
  pos = { x: event.clientX, y: event.clientY };
  if (!raf) raf = requestAnimationFrame(place);
}

function onScroll(): void {
  hideCoverPreview();
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') hideCoverPreview();
}

/** Show the floating cover at the cursor. Safe to call on every mouse-enter. */
export function showCoverPreview(cover: PreviewCover, clientX: number, clientY: number): void {
  if (!canHoverPreview()) return;
  const src = getProxiedImageUrl(cover.source, cover.coverUrl, 'cover', cover.panelId);
  if (!src) return;
  if (!ensure() || !box || !img) return;
  if (src !== currentSrc) {
    currentSrc = src;
    img.src = src;
  }
  img.alt = `Cover of ${cover.title}`;
  pos = { x: clientX, y: clientY };
  box.style.display = 'block';
  box.style.transform = `translate(${clientX}px, ${clientY}px)`;
  if (!listening) {
    listening = true;
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('keydown', onKey);
  }
  if (!raf) raf = requestAnimationFrame(place);
}

/** Hide the floating cover. Safe to call on every mouse-leave. */
export function hideCoverPreview(): void {
  if (raf) {
    window.cancelAnimationFrame(raf);
    raf = 0;
  }
  if (box) box.style.display = 'none';
  if (listening) {
    listening = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('scroll', onScroll, { capture: true });
    window.removeEventListener('keydown', onKey);
  }
}
