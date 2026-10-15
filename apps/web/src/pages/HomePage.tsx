import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { SearchBar } from '../components/SearchBar';
import { api } from '../api/client';
import { useClearRecentlyViewed, useRecentlyViewed, useSourceOrder } from '../api/hooks';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { PanelCard } from '../components/PanelCard';
import { IconChevronLeft, IconChevronRight, IconArrowRight } from '../components/icons';
import { useDisplaySettings } from '../hooks/useDisplaySettings';

import { effectiveHiddenSources, formatBytes } from '../utils/format';
import { loadRecentlyViewed, clearRecentlyViewed, replaceRecentlyViewed, type RecentlyViewedEntry } from '../utils/recentlyViewed';

/** Base cadence for the cache-size badge re-read. The badge is
 *  informational, so a slow poll is fine — and the poll stops entirely
 *  once the size settles (see SIZE_SETTLE_READS), resuming on focus. */
const SIZE_POLL_MS = 15_000;
/** Consecutive identical size reads after which polling stops (warm-up
 *  done — nothing is being cached anymore). A focus/visibility return
 *  re-reads once and restarts the poll if the size moved again. */
const SIZE_SETTLE_READS = 2;

/**
 * Home: search-engine-style landing — a badge, oversized wordmark, quiet
 * tagline and one prominent search bar centered in the viewport over an
 * ambient glow, with quick links beneath.
 */

interface ServerHistoryEntry {
  id: string;
  title: string;
  coverUrl: string | null;
  source: string;
  sourceUrl: string;
  status: RecentlyViewedEntry['status'];
  latestChapter: string | null;
  viewedAt: string;
}

function fromServerEntries(server: readonly ServerHistoryEntry[]): RecentlyViewedEntry[] {
  return server.map((entry) => ({
    id: entry.id,
    title: entry.title,
    coverUrl: entry.coverUrl,
    source: entry.source,
    sourceUrl: entry.sourceUrl,
    status: entry.status,
    latestChapter: entry.latestChapter,
    updatedAt: null,
    viewedAt: entry.viewedAt,
  }));
}

function seenIds(server: readonly ServerHistoryEntry[]): Set<string> {
  return new Set(server.map((entry) => entry.id));
}
export function HomePage() {
  useDocumentTitle(null);
  const { settings } = useDisplaySettings();
  const [cacheSize, setCacheSize] = useState<number | null>(null);
  const [capBytes, setCapBytes] = useState<number | null>(null);
  /** Server-side history — the persistent rail. Survives browser clears,
      incognito sessions, and device switches (same LAN server). */
  const historyQuery = useRecentlyViewed();
  const clearHistory = useClearRecentlyViewed();
  /** Local rail — instant fallback while the server history loads, and the
      offline copy when the API is unreachable. */
  const [localRecent, setLocalRecent] = useState<RecentlyViewedEntry[]>(() => loadRecentlyViewed());
  /** Sources hidden via the Sources page toggle — their cards are dropped
      from the rail below. */
  const sourceOrder = useSourceOrder();
  const hiddenSources = useMemo(
    () => effectiveHiddenSources(sourceOrder.data?.hidden),
    [sourceOrder.data?.hidden],
  );

  /** Server wins when present; local-only entries (recorded while offline)
      are appended so they stay visible until the server confirms them.
      Cards from hidden sources are dropped. */
  const recent = useMemo<RecentlyViewedEntry[]>(() => {
    const server = historyQuery.data;
    const merged = !server
      ? localRecent
      : localRecent.length === 0
        ? fromServerEntries(server)
        : [...fromServerEntries(server), ...localRecent.filter((entry) => !seenIds(server).has(entry.id))].slice(0, 10);
    if (hiddenSources.size === 0) return merged;
    return merged.filter((entry) => !hiddenSources.has(entry.source));
  }, [historyQuery.data, localRecent, hiddenSources]);

  // Mirror the server list into localStorage so the rail still renders on
  // a cold offline load. Never shrinks the local rail on an empty server
  // response — a fresh/failed fetch must not wipe the offline copy.
  useEffect(() => {
    if (historyQuery.data && historyQuery.data.length > 0) {
      replaceRecentlyViewed(
        historyQuery.data.map((entry) => ({
          id: entry.id,
          title: entry.title,
          coverUrl: entry.coverUrl,
          source: entry.source,
          sourceUrl: entry.sourceUrl,
          status: entry.status,
          latestChapter: entry.latestChapter,
          updatedAt: null,
          viewedAt: entry.viewedAt,
        })),
      );
    }
  }, [historyQuery.data]);
  // Carousel behaviour for the recently-viewed rail (single scrolling row).
  const railRef = useRef<HTMLDivElement>(null);
  /** Hover/focus/interaction pauses the auto-advance so cards stay readable. */
  const [autoPaused, setAutoPaused] = useState(false);
  /** True while the user is grab-dragging the rail with the mouse. */
  const [dragging, setDragging] = useState(false);
  /** Drag bookkeeping: pointer start position, scroll start, and whether the
      pointer moved far enough that a mouseup should NOT count as a click. */
  const dragState = useRef({ startX: 0, startScroll: 0, moved: false, pointerId: -1 });

  const onDragStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    // Only left-button mouse drags; touch already scrolls natively.
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    // A grab takes over scrolling — stop any running slide animation.
    window.cancelAnimationFrame(railAnimRef.current);
    railRef.current?.style.setProperty('scroll-behavior', '');
    railRef.current?.style.setProperty('scroll-snap-type', '');
    dragState.current = {
      startX: event.clientX,
      startScroll: railRef.current?.scrollLeft ?? 0,
      moved: false,
      pointerId: event.pointerId,
    };
    setAutoPaused(true);
    // NOTE: no setPointerCapture here. Capturing on pointer-down retargets the
    // resulting click event to the rail, so clicks never reach the card links.
    // Capture is deferred until the drag threshold is crossed in onDragMove.
  }, []);

  const onDragMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragState.current.pointerId !== event.pointerId) return;
    const rail = railRef.current;
    if (!rail) return;
    const delta = event.clientX - dragState.current.startX;
    if (Math.abs(delta) <= 5) return;
    if (!dragState.current.moved) {
      // Drag is real now: grab the pointer so the scroll keeps tracking even
      // when the cursor leaves the rail. This retargets the click that ends
      // the drag to the rail — which onClickCapture swallows on purpose.
      dragState.current.moved = true;
      setDragging(true);
      rail.setPointerCapture(event.pointerId);
    }
    rail.scrollLeft = dragState.current.startScroll - delta;
  }, []);

  const onDragEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragState.current.pointerId !== event.pointerId) return;
    const rail = railRef.current;
    if (rail?.hasPointerCapture(event.pointerId)) {
      rail.releasePointerCapture(event.pointerId);
    }
    dragState.current.pointerId = -1;
    setDragging(false);
  }, []);

  // Stop any rail animation and restore scroll behavior when leaving the page.
  useEffect(
    () => () => {
      window.cancelAnimationFrame(railAnimRef.current);
      railRef.current?.style.setProperty('scroll-behavior', '');
      railRef.current?.style.setProperty('scroll-snap-type', '');
    },
    [],
  );

  // After a drag, swallow the click that lands on a card so grabbing the rail
  // doesn't accidentally navigate to the details page.
  const onRailClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!dragState.current.moved) return;
    dragState.current.moved = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  // Width of one card step: the first card's width plus the rail's column gap.
  const getCardStep = useCallback((rail: HTMLDivElement): number => {
    const first = rail.firstElementChild as HTMLElement | null;
    const cardWidth = first?.getBoundingClientRect().width ?? rail.clientWidth;
    const gap = parseFloat(getComputedStyle(rail).columnGap || '0') || 0;
    return cardWidth + gap;
  }, []);

  // Handle of the running rail animation, so a new scroll (or a user grab)
  // can cancel the previous one mid-flight.
  const railAnimRef = useRef(0);

  /** Animate the rail to `target` with an ease-in-out curve. Custom rAF
      animation instead of native `behavior: 'smooth'` so the motion has a
      consistent, softer feel and can be cancelled mid-flight. */
  const animateRailTo = useCallback((rail: HTMLDivElement, target: number) => {
    window.cancelAnimationFrame(railAnimRef.current);
    const start = rail.scrollLeft;
    const distance = target - start;
    if (Math.abs(distance) < 1) return;
    // CSS `scroll-behavior: smooth` would animate our per-frame scrollLeft
    // assignments too, and `scroll-snap-type: x mandatory` would force-snap
    // every frame (making the card teleport instead of glide). Disable both
    // while we drive the frames, restore them when the slide finishes.
    rail.style.scrollBehavior = 'auto';
    rail.style.scrollSnapType = 'none';
    const finish = () => {
      rail.style.scrollBehavior = '';
      rail.style.scrollSnapType = '';
    };
    const duration = Math.min(600, Math.max(280, Math.abs(distance) * 0.7));
    const startTime = performance.now();
    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startTime) / duration);
      rail.scrollLeft = start + distance * easeInOutCubic(progress);
      if (progress < 1) {
        railAnimRef.current = window.requestAnimationFrame(tick);
      } else {
        finish();
      }
    };
    railAnimRef.current = window.requestAnimationFrame(tick);
  }, []);

  // Edge tracking for the arrow buttons: each arrow disables once the rail
  // can't scroll any further in its direction.
  const [railEdges, setRailEdges] = useState({ atStart: true, atEnd: true });
  const updateRailEdges = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const max = rail.scrollWidth - rail.clientWidth;
    setRailEdges({ atStart: rail.scrollLeft <= 1, atEnd: rail.scrollLeft >= max - 1 });
  }, []);

  // Scroll by a single card (clamped to the scrollable range), so the arrows
  // step card by card instead of jumping a whole page.
  const scrollRail = useCallback(
    (direction: 1 | -1) => {
      const rail = railRef.current;
      if (!rail) return;
      const max = rail.scrollWidth - rail.clientWidth;
      const target = Math.max(0, Math.min(rail.scrollLeft + direction * getCardStep(rail), max));
      animateRailTo(rail, target);
    },
    [getCardStep, animateRailTo],
  );

  // Auto-advance: every few seconds slide one card forward; when the last card
  // is reached, slide back to the first. Disabled while hovered/focused and
  // for users who prefer reduced motion.
  useEffect(() => {
    if (recent.length <= 1 || autoPaused) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setInterval(() => {
      const rail = railRef.current;
      if (!rail) return;
      const max = rail.scrollWidth - rail.clientWidth;
      const atEnd = rail.scrollLeft >= max - 1;
      animateRailTo(rail, atEnd ? 0 : rail.scrollLeft + getCardStep(rail));
    }, 4000);
    return () => window.clearInterval(id);
  }, [recent.length, autoPaused, getCardStep, animateRailTo]);

  // Track rail scroll edges for the arrows (re-checks on scroll, resize and
  // whenever the recently-viewed list changes).
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    updateRailEdges();
    rail.addEventListener('scroll', updateRailEdges, { passive: true });
    window.addEventListener('resize', updateRailEdges);
    return () => {
      rail.removeEventListener('scroll', updateRailEdges);
      window.removeEventListener('resize', updateRailEdges);
    };
  }, [recent.length, updateRailEdges]);

  // Cache-size badge (best-effort; never blocks the page). Polls slowly
  // while the tab is visible, then stops once the size settles — a settled
  // cache means no background warm-up is running, so further polls just
  // burn requests. Returning to the tab (focus/visible) re-reads once and
  // restarts the poll if the size moved again.
  useEffect(() => {
    let alive = true;
    let timer = 0;
    let sameCount = 0;
    let lastBytes: number | null = null;
    const controller = new AbortController();

    const read = () =>
      api
        .getImageCacheSize('both', controller.signal)
        .then((info) => {
          if (!alive) return;
          setCacheSize(info.totalBytes);
          setCapBytes(info.capBytes);
          if (info.totalBytes === lastBytes) {
            sameCount += 1;
            if (sameCount >= SIZE_SETTLE_READS && timer !== 0) {
              window.clearInterval(timer);
              timer = 0;
            }
          } else {
            sameCount = 0;
            lastBytes = info.totalBytes;
          }
        })
        .catch(() => {
          // The size endpoint is best-effort — a failure just hides the badge.
        });

    const start = () => {
      if (!alive || timer !== 0 || document.hidden) return;
      timer = window.setInterval(() => {
        if (document.hidden) return;
        void read();
      }, SIZE_POLL_MS);
    };

    void read();
    start();
    const onReturn = () => {
      if (!alive || document.hidden) return;
      void read();
      start();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, []);

  const usedPercent =
    cacheSize !== null && capBytes && capBytes > 0
      ? Math.min(100, Math.round((cacheSize / capBytes) * 100))
      : null;

  return (
    <div className="page home-page">
      <section className="home-hero">
        <span className="home-hero__glow" aria-hidden="true" />

        <span className="home-hero__badge">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8L12 2z" />
          </svg>
          No ads. No accounts. Just panel.
        </span>

        <h1 className="home-hero__title">
          Read panel.
          <br />
          <span className="home-hero__title-accent">Beautifully.</span>
        </h1>

        <p className="home-hero__subtitle">
          Search thousands of titles, pick up where you left off, and keep your library in one place
          — in a reader that respects your time.
        </p>

        <SearchBar large showPasteButton />

        <div className="home-hero__actions">
          <Link to="/latest" className="btn btn--primary btn--lg">
            Browse latest
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
              <path d="M5 12h14" />
              <path d="m12 5 7 7-7 7" />
            </svg>
          </Link>
          <Link to="/bookmarks" className="btn btn--ghost btn--lg">
            My bookmarks
          </Link>
        </div>

        {/* Recently-viewed rail (T2-4): the last few panel taps, surfaced on the
            home page so the user can jump straight back in. */}
        {recent.length > 0 && (
          <section className="home-recent" aria-label="Recently viewed">
            <div className="home-recent__head">
              <h2 className="home-recent__title">Recently viewed</h2>
              <div className="home-recent__controls">
                <button
                  type="button"
                  className="home-recent__clear btn btn--ghost btn--sm"
                  onClick={() => {
                    clearRecentlyViewed();
                    setLocalRecent([]);
                    clearHistory.mutate();
                  }}
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="home-recent__arrow"
                  aria-label="Scroll recently viewed back"
                  disabled={railEdges.atStart}
                  onClick={() => scrollRail(-1)}
                >
                  <IconChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  className="home-recent__arrow"
                  aria-label="Scroll recently viewed forward"
                  disabled={railEdges.atEnd}
                  onClick={() => scrollRail(1)}
                >
                  <IconChevronRight size={16} />
                </button>
              </div>
            </div>
            <div
              className={`home-recent__rail${dragging ? ' home-recent__rail--dragging' : ''}`}
              ref={railRef}
              tabIndex={0}
              role="region"
              aria-label="Recently viewed carousel"
              onPointerDown={onDragStart}
              onPointerMove={onDragMove}
              onPointerUp={onDragEnd}
              onPointerCancel={onDragEnd}
              onDragStart={(event) => {
                // Cards are links, so the browser tries to start a native
                // link drag when grabbed — that cancels pointer events and
                // kills our grab-to-slide. Suppress it; the rail handles
                // dragging itself.
                event.preventDefault();
              }}
              onWheel={() => {
                // Manual wheel/trackpad scrolling takes over from animations.
                window.cancelAnimationFrame(railAnimRef.current);
                railRef.current?.style.setProperty('scroll-behavior', '');
                railRef.current?.style.setProperty('scroll-snap-type', '');
              }}
              onClickCapture={onRailClickCapture}
              onPointerEnter={() => setAutoPaused(true)}
              onPointerLeave={() => setAutoPaused(false)}
              onFocus={() => setAutoPaused(true)}
              onBlur={() => setAutoPaused(false)}
              onTouchStart={() => setAutoPaused(true)}
            >
              {recent.map((entry) => (
                <PanelCard
                  key={entry.id}
                  panel={{
                    id: entry.id,
                    title: entry.title,
                    coverUrl: entry.coverUrl,
                    status: entry.status ?? 'unknown',
                    latestChapter: entry.latestChapter ?? null,
                    source: entry.source,
                  }}
                  from="home"
                  hideBadges={settings.hideCoverBadges}
                />
              ))}
            </div>
          </section>
        )}

        {/* Local image cache: covers + chapter images are pre-warmed to the
            server-side disk cache on load and persisted in the Docker
            volume until the user clears them. Quick-glance badge here;
            the dedicated /settings/cache page is where the controls live. */}
        <div className="home-hero__cache" role="region" aria-label="Image cache">
          <div className="home-hero__cache-summary">
            <span className="home-hero__cache-label">
              Local image cache
              {cacheSize !== null && (
                <>
                  {' · '}
                  <span className="home-hero__cache-size">{formatBytes(cacheSize)}</span>
                  {capBytes ? (
                    <>
                      {' / '}
                      <span className="home-hero__cache-cap">{formatBytes(capBytes)}</span>
                    </>
                  ) : null}
                </>
              )}
            </span>
            {usedPercent !== null && (
              <div
                className="home-hero__cache-bar"
                role="progressbar"
                aria-valuenow={usedPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Cache usage: ${usedPercent}% of ${formatBytes(capBytes!)}`}
              >
                <div
                  className="home-hero__cache-bar__fill"
                  style={{ width: `${usedPercent}%` }}
                />
              </div>
            )}
            <div className="home-hero__cache-links">
              <Link to="/settings/cache" className="home-hero__cache-manage">
                Open cache settings
                <IconArrowRight size={14} aria-hidden="true" />
              </Link>
              <Link to="/sources" className="home-hero__cache-manage">
                Check source status
                <IconArrowRight size={14} aria-hidden="true" />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
