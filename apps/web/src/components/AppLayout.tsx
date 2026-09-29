import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { applyTheme, loadTheme, saveTheme, type Theme } from '../theme';
import { hideCoverPreview } from './coverPreview';

/** Scroll past this distance before the header is allowed to hide. */
const HIDE_THRESHOLD = 100;
/**
 * Minimum scroll delta between toggles. Absorbs the sub-pixel jitter that
 * mobile momentum scrolling, rubber-banding and URL-bar resizes emit —
 * without this dead-zone the header flickers show/hide on phones.
 */
const TOGGLE_DELTA = 12;
/** No scroll/pointer activity for this long → hide the header again (auto-hide routes). */
const IDLE_HIDE_MS = 1500;
/** No scroll events for this long → the user stopped scrolling → reveal. */
const SCROLL_STOP_MS = 400;

/**
 * App shell: compact header with brand + primary nav. On mobile the nav
 * collapses into the header row (icon-first, labels stay for accessibility).
 * The header auto-hides when scrolling down and returns on scroll up
 * (mobile only — the hiding is purely visual via a media-gated class).
 * On the long grid pages (Latest, Bookmarks) it behaves like the reader
 * chrome instead: hide on scroll down, reveal on scroll up /
 * mouse movement, hide again once idle — on all viewports.
 */
export function AppLayout() {
  const [headerHidden, setHeaderHidden] = useState(false);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const { pathname, search } = useLocation();

  /** Reader-style auto-hide header is active on the long grid pages. */
  const autoHideHeader = pathname === '/latest' || pathname === '/bookmarks';
  /** True while the pointer hovers the header — pins it visible. */
  const headerPinnedRef = useRef(false);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // The list-mode cover preview is an imperative DOM node outside React.
  // SPA navigation unmounts the hovered row without a mouse-leave, so clear
  // any leftover preview on every route change (and on unmount, e.g. when
  // entering the reader which renders outside this layout).
  useEffect(() => {
    hideCoverPreview();
    // A new route starts at the top with the header visible.
    setHeaderHidden(false);
    return () => hideCoverPreview();
  }, [pathname, search]);

  const toggleTheme = () => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      saveTheme(next);
      return next;
    });
  };

  useEffect(() => {
    let lastY = Math.max(0, window.scrollY);
    let ticking = false;
    let idleTimer: number | undefined;
    let stopTimer: number | undefined;
    let lastPointerShow = 0;
    /** Last scroll direction past the dead-zone — gates the scroll-stop reveal. */
    let lastDir: 'up' | 'down' | null = null;

    const clearIdleTimer = () => {
      window.clearTimeout(idleTimer);
      idleTimer = undefined;
    };

    // Reader-style: after a quiet spell, hide again when past the
    // threshold (no-op near the top). Only armed on auto-hide routes.
    const armIdleHide = () => {
      clearIdleTimer();
      if (!autoHideHeader) return;
      idleTimer = window.setTimeout(() => {
        if (!headerPinnedRef.current && Math.max(0, window.scrollY) > HIDE_THRESHOLD) {
          setHeaderHidden(true);
        }
      }, IDLE_HIDE_MS);
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        // Clamp negatives from iOS overscroll so they never read as "up".
        const y = Math.max(0, window.scrollY);

        // Always visible near the top.
        if (y <= HIDE_THRESHOLD) {
          lastY = y;
          lastDir = null;
          clearIdleTimer();
          setHeaderHidden(false);
          return;
        }

        // Only toggle once movement exceeds the dead-zone; the anchor moves
        // just as rarely, so tiny jitters can't flip the header back and forth.
        if (y - lastY > TOGGLE_DELTA) {
          lastY = y;
          lastDir = 'down';
          clearIdleTimer();
          window.clearTimeout(stopTimer);
          stopTimer = undefined;
          setHeaderHidden(true);
        } else if (lastY - y > TOGGLE_DELTA) {
          lastY = y;
          lastDir = 'up';
          setHeaderHidden(false);
          armIdleHide();
        }
      });
    };

    // Scroll stop → reveal only if the last motion was upward (an upward
    // fling already reveals via direction, so this is a no-op safety net).
    // After scrolling DOWN the header stays hidden — revealing here caused
    // the hide → show → (idle) hide flicker on every scroll stop.
    // Auto-hide routes only.
    const onScrollRaw = () => {
      onScroll();
      if (!autoHideHeader) return;
      window.clearTimeout(stopTimer);
      stopTimer = window.setTimeout(() => {
        if (lastDir === 'up' && !headerPinnedRef.current) {
          setHeaderHidden(false);
        }
        armIdleHide();
      }, SCROLL_STOP_MS);
    };

    // Any mouse movement reveals (then idle-hides). Throttled so constant
    // motion doesn't re-render every frame. Mouse only — touch drags fire
    // pointermove while scrolling and would fight the scroll-down hide.
    // Auto-hide routes only.
    const onPointerMove = (e: PointerEvent) => {
      if (!autoHideHeader || headerPinnedRef.current) return;
      if (e.pointerType && e.pointerType !== 'mouse') return;
      const now = performance.now();
      if (now - lastPointerShow < 150) return;
      lastPointerShow = now;
      setHeaderHidden(false);
      armIdleHide();
    };

    const headerEl = document.querySelector('.app-header');
    const onHeaderEnter = () => {
      headerPinnedRef.current = true;
      clearIdleTimer();
      setHeaderHidden(false);
    };
    const onHeaderLeave = () => {
      headerPinnedRef.current = false;
      armIdleHide();
    };

    window.addEventListener('scroll', onScrollRaw, { passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    headerEl?.addEventListener('pointerenter', onHeaderEnter);
    headerEl?.addEventListener('pointerleave', onHeaderLeave);
    return () => {
      window.removeEventListener('scroll', onScrollRaw);
      window.removeEventListener('pointermove', onPointerMove);
      headerEl?.removeEventListener('pointerenter', onHeaderEnter);
      headerEl?.removeEventListener('pointerleave', onHeaderLeave);
      clearIdleTimer();
      window.clearTimeout(stopTimer);
    };
  }, [autoHideHeader]);

  return (
    <div className={`app-shell app-shell--wide${autoHideHeader ? ' app-shell--auto-hide-header' : ''}`}>
      <header className={`app-header${headerHidden ? ' app-header--hidden' : ''}`}>
        <div className="app-header__inner">
          <NavLink to="/" className="app-header__brand" aria-label="Panel Reader home">
            <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="7" fill="var(--surface-2)" />
              <path d="M8 6h7v20l-3.5-2.6L8 26V6z" fill="var(--accent)" />
              <path d="M17 6h7v20l-3.5-2.6L17 26V6z" fill="currentColor" opacity="0.7" />
            </svg>
            <span className="app-header__brand-name">Panel Reader</span>
          </NavLink>

          <div className="app-header__right">
            <nav className="app-nav" aria-label="Primary">
              <NavLink to="/" end className={navClass}>
                Home
              </NavLink>
              <NavLink to="/latest" className={navClass}>
                Latest
              </NavLink>
              <NavLink to="/bookmarks" className={navClass}>
                Bookmarks
              </NavLink>
            </nav>
            <button
              type="button"
              className="btn btn--ghost theme-toggle"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>

      <footer className="app-footer">
        <p>
          Content is loaded from third-party sources at runtime. Read responsibly and support
          official releases.
        </p>
      </footer>
    </div>
  );
}

function navClass({ isActive }: { isActive: boolean }): string {
  return `app-nav__link${isActive ? ' app-nav__link--active' : ''}`;
}

function SunIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}