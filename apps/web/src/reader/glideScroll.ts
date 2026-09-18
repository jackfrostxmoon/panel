/**
 * Custom rAF smooth-glide scroll (like the home-page carousel).
 * Cancels any previous animation so rapid keyboard presses never
 * conflict / ghost / jump — the new target always replaces the old one.
 */
export interface GlideAnimRef {
  current: number;
}

export type GlidePreset = 'instant' | 'quick' | 'normal' | 'smooth';

const PRESET_CONFIG: Record<
  GlidePreset,
  { min: number; max: number; scale: number }
> = {
  instant: { min: 60, max: 150, scale: 0.15 },
  quick: { min: 120, max: 350, scale: 0.35 },
  normal: { min: 240, max: 600, scale: 0.6 },
  smooth: { min: 400, max: 900, scale: 1.0 },
};

export function glideScrollTo(
  scroller: HTMLElement,
  targetTop: number,
  animRef: GlideAnimRef,
  preset: GlidePreset = 'quick',
) {
  window.cancelAnimationFrame(animRef.current);
  const start = scroller.scrollTop;
  const distance = targetTop - start;
  if (Math.abs(distance) < 1) return;

  const cfg = PRESET_CONFIG[preset];
  const duration = Math.min(cfg.max, Math.max(cfg.min, Math.abs(distance) * cfg.scale));
  const startTime = performance.now();
  const easeInOutCubic = (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  const tick = (now: number) => {
    const progress = Math.min(1, (now - startTime) / duration);
    scroller.scrollTop = start + distance * easeInOutCubic(progress);
    if (progress < 1) {
      animRef.current = window.requestAnimationFrame(tick);
    }
  };

  animRef.current = window.requestAnimationFrame(tick);
}
