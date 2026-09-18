import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { applyTheme, loadTheme, saveTheme, type Theme } from '../theme';

/** Scroll past this distance before the header is allowed to hide. */
const HIDE_THRESHOLD = 100;
/**
 * Minimum scroll delta between toggles. Absorbs the sub-pixel jitter that
 * mobile momentum scrolling, rubber-banding and URL-bar resizes emit —
 * without this dead-zone the header flickers show/hide on phones.
 */
const TOGGLE_DELTA = 12;

/**
 * App shell: compact header with brand + primary nav. On mobile the nav
 * collapses into the header row (icon-first, labels stay for accessibility).
 * The header also auto-hides when scrolling down and returns on scroll up
 * (mobile only — the hiding is purely visual via a media-gated class).
 */
export function AppLayout() {
  const [headerHidden, setHeaderHidden] = useState(false);
  const [theme, setTheme] = useState<Theme>(loadTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

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
          setHeaderHidden(false);
          return;
        }

        // Only toggle once movement exceeds the dead-zone; the anchor moves
        // just as rarely, so tiny jitters can't flip the header back and forth.
        if (y - lastY > TOGGLE_DELTA) {
          lastY = y;
          setHeaderHidden(true);
        } else if (lastY - y > TOGGLE_DELTA) {
          lastY = y;
          setHeaderHidden(false);
        }
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="app-shell app-shell--wide">
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