import { useEffect, useRef } from 'react';

/** Glide speed in px/sec — matches the reader's normal smooth-scroll pace. */
const SPEED_PX_PER_SEC = 3000;

/**
 * Fast hold-to-scroll for long grid pages (Latest, Bookmarks).
 *
 * Hold `W` to glide up, `S` to glide down — no Shift needed
 * (`Shift+W`/`Shift+S` and `Shift+↑`/`Shift+↓` glide too; plain arrows
 * keep their native scroll). Release the key to stop; the glide also
 * stops at the top/bottom edge. Skipped while typing in an input and
 * with Ctrl/Cmd/Alt held.
 */
export function useFastScrollKeys(): void {
  const dirRef = useRef<'up' | 'down' | null>(null);
  const rafRef = useRef(0);
  const lastRef = useRef(0);

  useEffect(() => {
    function stopGlide() {
      dirRef.current = null;
      cancelAnimationFrame(rafRef.current);
    }

    function tick(now: number) {
      const dir = dirRef.current;
      if (dir === null) return;
      const dt = Math.max((now - lastRef.current) / 1000, 0);
      lastRef.current = now;
      if (dt > 0) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        const next = window.scrollY + (dir === 'up' ? -SPEED_PX_PER_SEC * dt : SPEED_PX_PER_SEC * dt);
        if (next <= 0) {
          window.scrollTo(0, 0);
          stopGlide();
          return;
        }
        if (next >= max) {
          window.scrollTo(0, Math.max(max, 0));
          stopGlide();
          return;
        }
        window.scrollBy(0, dir === 'up' ? -SPEED_PX_PER_SEC * dt : SPEED_PX_PER_SEC * dt);
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    function startGlide(dir: 'up' | 'down') {
      if (dirRef.current === dir) return;
      dirRef.current = dir;
      cancelAnimationFrame(rafRef.current);
      lastRef.current = performance.now();
      rafRef.current = requestAnimationFrame(tick);
    }

    function isTypingTarget(target: HTMLElement | null) {
      return (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      );
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (isTypingTarget(event.target as HTMLElement | null)) return;
      const key = event.key;
      if (key === 'w' || key === 'W') {
        event.preventDefault();
        startGlide('up');
      } else if (key === 's' || key === 'S') {
        event.preventDefault();
        startGlide('down');
      } else if (event.shiftKey && key === 'ArrowUp') {
        event.preventDefault();
        startGlide('up');
      } else if (event.shiftKey && key === 'ArrowDown') {
        event.preventDefault();
        startGlide('down');
      }
    }

    function onKeyUp(event: KeyboardEvent) {
      const key = event.key;
      // Releasing a glide key — or Shift itself — halts the glide.
      if (
        key === 'Shift' ||
        key === 'ArrowUp' ||
        key === 'ArrowDown' ||
        key === 'w' ||
        key === 'W' ||
        key === 's' ||
        key === 'S'
      ) {
        stopGlide();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', stopGlide);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', stopGlide);
      cancelAnimationFrame(rafRef.current);
      dirRef.current = null;
    };
  }, []);
}
