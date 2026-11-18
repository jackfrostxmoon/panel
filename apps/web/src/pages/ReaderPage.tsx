import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { PanelPage, SaveProgressInput } from '@panel/shared';
import { parseGlobalId, splitNativeChapterId, toGlobalId } from '@panel/shared';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys, useCacheSettings, useChapterPages, useChapters, useProgress, useSaveProgress, usePrefetchChapterPages } from '../api/hooks';
import { api } from '../api/client';
import { isIncognito } from '../utils/incognito';
import { saveLocalProgress } from '../utils/incognitoProgress';
import { useDelayedLoading } from '../hooks/useDelayedLoading';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { ErrorState } from '../components/StateView';
import { useToast } from '../components/Toast';
import { IconPause, IconPlay } from '../components/icons';
import { PagedReader } from '../reader/PagedReader';
import { GalleryReader, type GalleryReaderHandle } from '../reader/GalleryReader';
import { ReaderSettingsPanel } from '../reader/ReaderSettingsPanel';
import { ReaderToolbar, useChapterBookmarkToggle } from '../reader/ReaderToolbar';
import { nextReadingMode, resolveEffectiveReaderSettings, scrollSpeedPx, DEFAULT_READER_SETTINGS, type ReaderSettings, type ReadingMode, type GlidePreset } from '../reader/settings';
import { VerticalReader, type VerticalReaderHandle } from '../reader/VerticalReader';
import { proxiedPageUrl } from '../utils/format';
import {
  applyIntent,
  clampPage,
  intentForKey,
  isEditableKeyTarget,
  nextSpreadPage,
  prevSpreadPage,
  progressFraction,
  smoothProgressFraction,
  wheelPageStep,
} from '../reader/navigation';
import { glideScrollTo } from '../reader/glideScroll';


const EMPTY_PAGES: PanelPage[] = [];

/**
 * localStorage ping written after every reader-settings save. The `storage`
 * event fires in every *other* open tab, telling those readers to reload
 * the server file — that is the whole cross-tab sync mechanism (same
 * pattern as the display-settings hook).
 */
const READER_SETTINGS_SYNC_KEY = 'panel-reader:settings:sync';

function pingReaderSettingsSync(): void {
  try {
    localStorage.setItem(READER_SETTINGS_SYNC_KEY, String(Date.now()));
  } catch {
    // Storage blocked — other tabs just won't live-sync.
  }
}

const CHAPTER_LANDING_SESSION_KEY = 'panel-reader:chapter-landing:v1';

/** Read a string map from sessionStorage (tolerates blocked storage). */
function readSessionMap(key: string): Map<string, string> {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return new Map();
    return new Map(Object.entries(JSON.parse(raw) as Record<string, string>));
  } catch {
    return new Map();
  }
}

function writeSessionMap(key: string, map: Map<string, string>): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // Storage blocked — the hop still works, just without the landing restore.
  }
}

/** Chapter-hop handoff key. The destination chapter's landing position
 * (paged mode) is stashed in sessionStorage just before the hop — in-memory
 * refs are reset for the new chapter, and the reset effect reads the stash
 * back to mount the fresh reader at the right position even when the
 * payload is served instantly from cache. Tab-scoped, so a hop never leaks
 * position into another tab.
 */
/** Stash a paged-mode directed landing for the destination chapter. */
function stashChapterLanding(destChapterId: string, landing: 'first' | 'last'): void {
  const map = readSessionMap(CHAPTER_LANDING_SESSION_KEY);
  map.set(destChapterId, landing);
  writeSessionMap(CHAPTER_LANDING_SESSION_KEY, map);
}

/** Consume (read + delete) a stashed landing for this chapter, if any. */
function consumeChapterLanding(chapterId: string): 'first' | 'last' | null {
  const map = readSessionMap(CHAPTER_LANDING_SESSION_KEY);
  const landing = map.get(chapterId);
  if (landing === 'first' || landing === 'last') {
    map.delete(chapterId);
    writeSessionMap(CHAPTER_LANDING_SESSION_KEY, map);
    return landing;
  }
  return null;
}

/**
 * The reader — orchestrates pages, navigation (keyboard / touch / buttons),
 * chapter transitions, settings, fullscreen and progress persistence.
 */
export function ReaderPage() {
  const { chapterId = '' } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [storedSettings, setStoredSettings] = useState<ReaderSettings>(DEFAULT_READER_SETTINGS);
  const chapterPages = useChapterPages(chapterId, { mkServer: storedSettings.mkImageServer === 'default' ? undefined : storedSettings.mkImageServer });
  const showPagesLoading = useDelayedLoading(chapterPages.isLoading);
  const prefetchChapterPages = usePrefetchChapterPages();
  const queryClient = useQueryClient();
  /** Next-chapter id whose JSON prefetch is (or was) in flight — cancelled on close/hop. */
  const prefetchedNextRef = useRef<string | null>(null);
  /**
   * Abort abandoned chapter work on close/hop. Hops reuse this component
   * (only `chapterId` changes), so the cleanup runs for the OLD chapter:
   * its JSON fetch is already settled (harmless no-op cancel) or still in
   * flight (aborted — the server stops scraping it). On reader close the
   * same cleanup aborts the current chapter plus any pending next-chapter
   * prefetch, so neither keeps the server busy after the reader is gone.
   */
  useEffect(() => {
    const id = chapterId;
    return () => {
      void queryClient.cancelQueries({ queryKey: queryKeys.chapterPages(id) });
      const next = prefetchedNextRef.current;
      if (next) {
        prefetchedNextRef.current = null;
        prefetchChapterPages.cancel(next);
      }
    };
  }, [chapterId, queryClient, prefetchChapterPages]);
  const pages = chapterPages.data?.pages ?? EMPTY_PAGES;
  const pageCount = pages.length;
  const panelId = chapterPages.data?.panelId ?? '';
  /**
   * Panel id parsed from the URL chapter id (`<source>:<panel>~<token>`) so
   * the `V` bookmark shortcut works before the chapter payload arrives.
   * Used ONLY for the bookmark toggle — everything else keeps waiting for
   * the payload's canonical panelId.
   */
  const bookmarkPanelId = useMemo(() => {
    if (panelId) return panelId;
    const parsed = parseGlobalId(chapterId);
    if (!parsed) return '';
    const split = splitNativeChapterId(parsed.nativeId);
    if (!split) return '';
    return toGlobalId(parsed.source, split.panelId);
  }, [panelId, chapterId]);

  // Tab title: "Chapter 17 · Mousou Shoujo" — falls back to "Panel Reader" while loading.
  useDocumentTitle(
    chapterPages.data
      ? [chapterPages.data.chapterTitle, chapterPages.data.panelTitle]
          .filter((s): s is string => Boolean(s))
          .join(' · ') || null
      : null,
  );

  const chapters = useChapters(panelId, { enabled: panelId.length > 0 });
  const progress = useProgress(panelId, chapterId, { enabled: panelId.length > 0 });
  const saveProgress = useSaveProgress();
  /**
   * Chapter bookmark state shared with the toolbar button — the `V` shortcut
   * below runs the same toggle (same mutations, same toasts). The title
   * mirrors the toolbar's header fallback: chapter-list title first, then the
   * chapter payload's label while the list is still loading.
   */
  const bookmarkChapters = useMemo(() => chapters.data ?? [], [chapters.data]);
  const { toggleBookmark } = useChapterBookmarkToggle({
    // Falls back to the URL-derived id while the payload is still loading
    // so `V` never silently no-ops on `panelId === ''`.
    panelId: bookmarkPanelId,
    chapterTitle:
      bookmarkChapters.find((c) => c.id === chapterId)?.title
      ?? chapterPages.data?.chapterTitle
      ?? null,
    chapterId,
    chapters: bookmarkChapters,
  });
  /**
   * Stable mirror of the bookmark toggle for the keyboard handler below.
   * `toggleBookmark` is recreated whenever the bookmark query settles, and
   * the keydown effect must NOT re-subscribe its window listeners on those
   * (or any other) re-renders: during a Shift+↑/↓ hold the page re-renders
   * on every scroll frame, and per-frame listener teardown/setup is what
   * made the hold-to-scroll feel slow to react. The ref always serves the
   * latest closure without ever invalidating the effect.
   */
  const toggleBookmarkRef = useRef(toggleBookmark);
  toggleBookmarkRef.current = toggleBookmark;

  /**
   * Performance-mode override (cache-settings toggle): forces parallel
   * loading with max preload and data-saver off for max throughput. The
   * stored prefs above are never rewritten, so turning the toggle off
   * restores prior behavior automatically. Every `settings.*` use below
   * reads this effective object; `update`/`switchMode` keep writing the
   * stored one (which the settings panel edits).
   */
  const cacheSettings = useCacheSettings();
  const performanceMode = cacheSettings.data?.performanceMode ?? false;
  const settings = useMemo(
    () => resolveEffectiveReaderSettings(storedSettings, { performanceMode }),
    [storedSettings, performanceMode],
  );

  /** Reload settings from the server file (cross-tab sync target). */
  const reloadSettings = useCallback(() => {
    api.getReaderSettings()
      .then((saved) => {
        setStoredSettings(saved);
      })
      .catch(() => {
        // Keep current settings if the file is missing.
      });
  }, []);

  // Load once from server file on mount; auto-instant save on every change.
  useEffect(() => {
    reloadSettings();
  }, [reloadSettings]);

  /**
   * Cross-tab sync: when another tab saves reader settings it writes the
   * ping key below, and this tab reloads from the server file — no refresh
   * needed. The `storage` event only fires in *other* tabs, so this never
   * loops back on the tab that saved.
   */
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === READER_SETTINGS_SYNC_KEY) reloadSettings();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [reloadSettings]);

  const update = useCallback(
    (patch: Partial<ReaderSettings>) => {
      setStoredSettings((current) => {
        const next = { ...current, ...patch };
        // Auto-instant save: write to file immediately, then ping other
        // tabs so they reload (see the storage listener above).
        void api.saveReaderSettings(next).then(() => pingReaderSettingsSync());
        return next;
      });
    },
    [],
  );
  const switchMode = useCallback(
    (mode: ReadingMode) => {
      setStoredSettings((current) => {
        const next = { ...current, mode };
        // Persist like any other change so the mode survives refreshes and
        // syncs to other open tabs (previously this was session-local).
        void api.saveReaderSettings(next).then(() => pingReaderSettingsSync());
        return next;
      });
    },
    [],
  );

  const [page, setPage] = useState(0);
  const [scrollRatio, setScrollRatio] = useState(0);
  /**
   * Chapter the page state was last reset for. Guards the progress-save
   * effect below against a stale payload: never persist a page against a
   * chapter id it doesn't belong to. The reset effect re-renders with the
   * correct values right after mount, and the save fires then.
   */
  const [resetChapter, setResetChapter] = useState(chapterId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** A paged backward transition targets the previous chapter's last page, which
      is only known once that chapter's pages arrive — hold the destination id here
      until a parallel effect can jump to the final page. */
  const lastPageChapterRef = useRef<string | null>(null);
  /** The panel is heavy (shortcuts tables, dropdowns) — keep it out of the
      initial DOM so it can't drag down LCP; mount on first open and leave it
      mounted afterwards so close/reopen still animates. */
  const [settingsEverOpened, setSettingsEverOpened] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  /**
   * Pages of the current chapter that gave up loading, keyed by their
   * chapter-local index. Reported by `ReaderImage` only after its auto-retry
   * budget is exhausted, so a page that recovers clears itself.
   *
   * Used for one thing: when EVERY page in the chapter has failed, the reader
   * is showing nothing but error boxes, so the toolbar stops auto-hiding.
   * Without that, a touch user could not summon the toolbar at all — the error
   * box swallows click propagation, and the mouse-only top-edge hover reveal
   * never fires — leaving reader settings unreachable. See the capture-phase
   * reveal listener in the controls effect below.
   */
  const [failedPages, setFailedPages] = useState<ReadonlySet<number>>(() => new Set());
  /** Chapter the failed-page set was last reset for (see prop docs on resetChapter). */
  const [failedChapter, setFailedChapter] = useState(chapterId);
  /** Records a terminal page failure, ignoring repeats of the same page. */
  const handlePageError = useCallback((failed: PanelPage) => {
    setFailedPages((prev) => {
      if (prev.has(failed.index)) return prev;
      const next = new Set(prev);
      next.add(failed.index);
      return next;
    });
  }, []);
  /** A page recovered after a manual Reload — stop counting it as failed. */
  const handlePageLoad = useCallback((loaded: PanelPage) => {
    setFailedPages((prev) => {
      if (!prev.has(loaded.index)) return prev;
      const next = new Set(prev);
      next.delete(loaded.index);
      return next;
    });
  }, []);
  /**
   * True when the current chapter has pages, a payload has landed, and every
   * one of them reported a terminal failure. `failedChapter` guards against a
   * stale set from the previous chapter being read against the new page count
   * in the render before the reset effect runs.
   */
  const everyPageFailed =
    pageCount > 0 && failedChapter === chapterId && failedPages.size >= pageCount;
  const [isFullscreen, setIsFullscreen] = useState(false);
  /** Active smooth-scroll direction (Shift+W / Shift+S, or plain W/S with smooth-scroll keys); null = stopped. */
  const [scrollDir, setScrollDir] = useState<'up' | 'down' | null>(null);
  /** Hands-free auto-scroll timer (T1-2). */
  const [autoScrollActive, setAutoScrollActive] = useState(false);
  /** Paused at the last page while the toggle is still on. */
  const [autoScrollPaused, setAutoScrollPaused] = useState(false);
  /** True while auto-scroll is actually advancing pages. */
  const autoScrollRunning = autoScrollActive && !autoScrollPaused;

  useEffect(() => {
    if (settingsOpen) setSettingsEverOpened(true);
  }, [settingsOpen]);

  const containerRef = useRef<HTMLDivElement>(null);
  const verticalRef = useRef<VerticalReaderHandle>(null);
  const galleryRef = useRef<GalleryReaderHandle>(null);
  const hideTimerRef = useRef<number | undefined>(undefined);
  /**
   * Timestamp until which programmatic keyboard-nav scrolls are ignored by
   * the toolbar's scroll-hide logic. Set ONLY by upward keyboard navigation
   * (step-up / Shift+W smooth-up) and consumed by the auto-hide effect's
   * `onScroll`. Downward keyboard nav must hide the toolbar, so it clears
   * this gate and lets its scroll events reach `hideNow()` immediately —
   * gating downward scrolls is what kept the toolbar pinned on screen while
   * spamming scroll-down keys. Mouse-wheel and touch scrolls don't touch
   * this ref, so they keep the hide-on-scroll-down behavior as before.
   */
  const navScrollUntilRef = useRef<number>(0);
  // Refs keep the rAF loop current without restarting on every settings change.
  const scrollDirRef = useRef<'up' | 'down' | null>(null);
  const isScrollingRef = useRef<boolean>(false);
  const glideAnimRef = useRef<number>(0);
  const rafRef = useRef<number>(0);
  const scrollSpeedRef = useRef(scrollSpeedPx(settings.scrollSpeed));
  /** Latest page index for timers/handlers that must not re-subscribe on page change. */
  const pageRef = useRef(page);
  scrollDirRef.current = scrollDir;
  scrollSpeedRef.current = scrollSpeedPx(settings.scrollSpeed);
  pageRef.current = page;

  /* Reset on mount. Hops remount the inner reader, so this runs once per
     chapter with the landing stashed in sessionStorage just before the
     hop (see `hardHopToChapter`). A paged-mode directed transition
     chooses the landing position: the next chapter opens at its first
     page, the previous chapter at its last page. Every other open starts
     at page 0 — no resume. */
  useEffect(() => {
    const landing = consumeChapterLanding(chapterId);
    if (landing) {
      // Directed paged-mode transition — the position is decided for us.
      // The previous chapter's last page needs the payload's page count,
      // which isn't known yet; hold the destination id in
      // lastPageChapterRef and let the page-load effect apply it below.
      lastPageChapterRef.current = landing === 'last' ? chapterId : null;
      setPage(0);
    } else {
      setPage(0);
      lastPageChapterRef.current = null;
    }
    setResetChapter(chapterId);
    setScrollRatio(0);
    setSettingsOpen(false);
    // Failure bookkeeping is per chapter — a fresh chapter starts clean.
    setFailedPages(new Set());
    setFailedChapter(chapterId);
    window.scrollTo(0, 0);
    const content = containerRef.current?.querySelector('.reader-content') as HTMLElement | null;
    content?.scrollTo({ top: 0 });
    content?.focus();
  }, [chapterId]);

  /* Paged-mode backward transitions land on the previous chapter's last page.
     pageCount is 0 while the payload is loading, so wait for the pages to arrive
     (this effect re-runs once pages/pageCount are known) and jump to the final
     one. Must run after the reset effect so it sees lastPageChapterRef. */
  useEffect(() => {
    if (lastPageChapterRef.current === chapterId && pageCount > 0) {
      lastPageChapterRef.current = null;
      setPage(pageCount - 1);
    }
    // Once the new chapter's pages load, make sure the scroller is at the top.
    if (pages.length > 0 && pageCount > 0) {
      const content = containerRef.current?.querySelector('.reader-content') as HTMLElement | null;
      content?.scrollTo({ top: 0 });
      window.scrollTo(0, 0);
    }
  }, [pages, pageCount, chapterId]);

  /**
   * Toggle fullscreen on the document element (not the reader container):
   * the toast viewport renders at the app root, outside `.reader` — going
   * fullscreen on the container would hide every toast while fullscreen.
   */
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen();
    }
  }, []);

  /** Toggle paced hands-free auto-scroll (T1-2). Restarting from the last
      page begins at the first page instead of looping in place. Requires an
      interval to be configured in the settings panel. */
  const toggleAutoScroll = useCallback(() => {
    if (!autoScrollActive && !settings.autoScrollDelayMs) {
      toast('Set an auto-scroll interval in reader settings first.', 'info');
      return;
    }
    // Restarting from the last page begins at the first page. The reset is
    // performed outside the state updater (updaters must be pure and run
    // twice under StrictMode). Sync the ref immediately so the interval's
    // first tick — which reads pageRef — starts from page 0.
    if (!autoScrollActive && pageCount > 0 && pageRef.current >= pageCount - 1) {
      if (settings.mode === 'vertical') {
        verticalRef.current?.scrollToPage(0, 'instant');
      } else if (settings.mode === 'gallery') {
        galleryRef.current?.scrollToPage(0, 'instant');
      }
      pageRef.current = 0;
      setPage(0);
    }
    setAutoScrollActive((active) => !active);
  }, [autoScrollActive, pageCount, settings.autoScrollDelayMs, settings.mode, toast]);

  /* Seed `pendingSaveRef` for a fresh chapter. The unload flush
     (pagehide / unmount / chapter hop) needs a payload to send, and on a
     brand-new chapter the user can close the tab in <100ms — before the
     save effect below ever fires. Without this, the first read of a
     chapter leaves no row in `reading_progress` and the Continue button
     silently disappears after a restart. */
  useEffect(() => {
    if (!progress.isSuccess || !chapterPages.data) return;
    if (progress.data) return;
    const data = chapterPages.data;
    if (!pendingSaveRef.current || pendingSaveRef.current.chapterId !== data.chapterId) {
      pendingSaveRef.current = {
        panelId: data.panelId,
        chapterId: data.chapterId,
        panelTitle: data.panelTitle ?? undefined,
        coverUrl: data.coverUrl,
        chapterTitle: data.chapterTitle ?? undefined,
      };
    }
  }, [progress.isSuccess, progress.data, chapterPages.data]);

/* Preload every page as soon as the chapter payload arrives — parallel
      image loading only. Sequential mode lets the browser's lazy loading
      fetch pages as they approach the viewport. Data-saver (T3-2) forces
      lazy loading regardless of the image-load setting.
   *
   * `fetchpriority="high"` is load-bearing: a detached `new Image()`
   * without an explicit priority defaults to `low` in Chrome/Firefox,
   * so the browser queues the request behind the current page's eager
   * `<img>` and only the on-screen page actually downloads before the
   * user turns the page. Forcing `high` puts these requests at the top
   * of the queue, matching the user's "All at once" intent. (See the
   * paged reader's parallel preloader for the same fix applied to
   * paged mode.) */
  useEffect(() => {
    if (settings.dataSaver) return;
    if (settings.imageLoad !== 'parallel') return;
    if (pages.length === 0) return;

    const chapterTag = chapterPages.data?.chapterId ?? null;
    const preloaders = pages.map((panelPage) => {
      const img = new Image();
      img.decoding = 'async';
      img.fetchPriority = 'high';
      img.referrerPolicy = 'no-referrer';
      img.src = proxiedPageUrl(panelPage, chapterTag);
      return img;
    });

    return () => {
      // Drop the abandoned chapter's pending downloads on close/hop.
      // Clearing `src` aborts the browser request, which aborts the
      // server's upstream fetch via the connection signal — without
      // this the old chapter keeps holding proxy slots behind the one
      // the user actually navigated to. `removeAttribute` covers
      // browsers that keep loading a detached image from `src = ''`.
      for (const img of preloaders) {
        img.src = '';
        img.removeAttribute('src');
      }
    };
  }, [pages, chapterPages.data?.chapterId, settings.imageLoad, settings.dataSaver]);

  /**
   * Latest unsent progress payload. The save below fires instantly on page
   * change — this ref lets the unload flush send the freshest position even
   * when it never fired. Declared above the navigation callbacks so hops
   * can flush first thing.
   */
  const pendingSaveRef = useRef<SaveProgressInput | null>(null);

  /**
   * Best-effort flush of the pending progress save. Idempotent (nulls the
   * ref after sending) so the save effect, `pagehide`, unmount, and chapter
   * hops can all call it without double-sending. The beacon also survives
   * a tab close mid-read.
   */
  const flushProgress = useCallback(() => {
    const payload = pendingSaveRef.current;
    if (!payload) return;
    pendingSaveRef.current = null;
    // Incognito: the beacon never reaches the network — progress is
    // browser-local, same as the hook-driven saves.
    if (isIncognito()) {
      saveLocalProgress(payload);
      return;
    }
    void api.saveProgressBeacon(payload);
  }, []);

  const goToPage = useCallback(
    (target: number, preset?: GlidePreset) => {
      const clamped = clampPage(target, pageCount);
      if (settings.mode === 'vertical') {
        verticalRef.current?.scrollToPage(clamped, preset ?? settings.glidePreset);
      } else if (settings.mode === 'gallery') {
        galleryRef.current?.scrollToPage(clamped, preset ?? settings.glidePreset);
      }
      setPage(clamped);
    },
    [pageCount, settings.mode, settings.glidePreset],
  );

  /**
   * Hop to another chapter via in-app navigation — the document (and the
   * fullscreen container) stays mounted, so fullscreen survives chapter
   * changes. The inner reader is keyed by chapter (see the render below)
   * and remounts per chapter, and the `chapterTag`-keyed preloaders drop
   * the abandoned chapter's pending downloads while unmounted `<img>`s
   * abort natively — so hopping away from a half-cached chapter still
   * stops its downloads on the spot, without a document unload. Progress
   * is flushed first so the position survives even if the tab closes
   * mid-transition. Paged-mode directed landings are stashed in
   * sessionStorage because in-memory refs are reset for the new chapter.
   */
  const hardHopToChapter = useCallback(
    (id: string, landing?: 'first' | 'last') => {
      if (landing) stashChapterLanding(id, landing);
      flushProgress();
      navigate(`/read/${encodeURIComponent(id)}`);
    },
    [flushProgress, navigate],
  );

  /** Hop to an adjacent chapter. In paged mode the destination lands on a fixed
      page — the next chapter opens at its first page, the previous chapter at
      its last page. In vertical/gallery the exact page the user left off on is
      restored when they return. */
  const navigateToChapter = useCallback(
    (dir: 'next' | 'prev') => {
      const id =
        dir === 'next' ? chapterPages.data?.nextChapterId : chapterPages.data?.prevChapterId;
      if (!id) {
        toast(
          dir === 'next' ? 'This is the latest chapter.' : 'This is the first chapter.',
          'info',
        );
        return;
      }
      if (settings.mode === 'paged') {
        hardHopToChapter(id, dir === 'next' ? 'first' : 'last');
      } else {
        hardHopToChapter(id);
      }
    },
    [chapterPages.data, hardHopToChapter, toast, settings.mode],
  );

  const handleIntent = useCallback(
    (intent: 'forward' | 'backward') => {
      // Double-page mode (T1-1): turn whole spreads, not single pages —
      // stepping by one would re-show the sheet we were just looking at.
      const next =
        settings.mode === 'paged' && settings.doublePage
          ? intent === 'forward'
            ? nextSpreadPage({ page, pageCount }, settings.direction)
            : prevSpreadPage({ page, pageCount }, settings.direction)
          : applyIntent({ page, pageCount }, intent);
      if (next !== null) {
        goToPage(next);
        return;
      }
      // At the chapter boundary → hop to the adjacent chapter.
      navigateToChapter(intent === 'forward' ? 'next' : 'prev');
    },
    [page, pageCount, goToPage, navigateToChapter, settings.mode, settings.doublePage, settings.direction],
  );

  /* Jump straight to the adjacent chapter (tap zones on the page / vertical & gallery arrows). */
  const goToChapter = useCallback(
    (dir: 'next' | 'prev') => navigateToChapter(dir),
    [navigateToChapter],
  );

  /* Jump to an arbitrary chapter picked from the settings dropdown. */
  const goToChapterById = useCallback(
    (id: string) => {
      if (id && id !== chapterId) hardHopToChapter(id);
    },
    [chapterId, hardHopToChapter],
  );

  /* Persist a chapter-level read marker on open. No page position is
     stored — the reader always opens at page 0. Exits are covered
     by the explicit hop flush, the unmount flush below, and `pagehide`. */
  useEffect(() => {
    if (pageCount === 0 || !chapterPages.data) return;
    // Guard against a stale payload: never persist a marker against a
    // chapter id it doesn't belong to (see `resetChapter`). The reset
    // effect re-renders with the correct values right after, and the
    // save fires then.
    if (resetChapter !== chapterPages.data.chapterId) return;
    const data = chapterPages.data;
    pendingSaveRef.current = {
      panelId: data.panelId,
      chapterId: data.chapterId,
      panelTitle: data.panelTitle ?? undefined,
      coverUrl: data.coverUrl,
      chapterTitle: data.chapterTitle ?? undefined,
    };
    // Instant save — no debounce.
    const payload = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (payload) saveProgress.mutate(payload);
    // oxlint-disable-next-line react/exhaustive-deps -- mutate is stable; we key on chapter
  }, [pageCount, chapterPages.data, resetChapter]);

  /* Flush on the way out. React cleanups don't run when the tab itself
     closes, and `beforeunload` is unreliable on mobile — `pagehide`
     fires in both cases. Without this, closing the browser inside the
     debounce window silently drops the latest position (and for short
     reads, the ONLY position), so "Continue Reading" goes missing after
     a restart. The unmount cleanup below covers in-app navigation away
     from the reader. */
  useEffect(() => {
    window.addEventListener('pagehide', flushProgress);
    return () => window.removeEventListener('pagehide', flushProgress);
  }, [flushProgress]);
  useEffect(() => () => {
    flushProgress();
  }, [flushProgress]);

  /* Keyboard navigation. */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Typing in a text-entry control (style name, number fields, dropdowns)
      // must never trigger shortcuts — and must keep focus, so return before
      // the stale-focus blur below (blurring first would drop focus after the
      // first keystroke and route the next keys to the reader).
      if (isEditableKeyTarget(target)) return;
      // Blur any focused control inside the settings panel so stale/visible
      // range sliders don't intercept arrow keys and cause layout glitching
      // (rapid imageWidth changes) or block reader navigation.
      const active = document.activeElement as HTMLElement | null;
      if (active && document.querySelector('.reader-settings')?.contains(active)) {
        active.blur();
      }
      // Mark upcoming UPWARD programmatic scroll as keyboard-driven so
      // the toolbar's auto-hide listener ignores it. Downward nav clears
      // the gate so its scroll events hide the toolbar immediately.
      // See `navScrollUntilRef` for rationale.
      const markNavScroll = (durationMs = 500) => {
        navScrollUntilRef.current = performance.now() + durationMs;
      };
      const clearNavScroll = () => {
        navScrollUntilRef.current = 0;
      };

      // Single-letter shortcuts never fire with Ctrl/Cmd/Alt held, so
      // browser chords (find, copy, paste) keep working inside the reader.
      const systemModifier = event.ctrlKey || event.metaKey || event.altKey;
      if (!systemModifier && (event.key === 'q' || event.key === 'Q')) {
        setSettingsOpen((open) => !open);
        return;
      }
      if (!systemModifier && (event.key === 'f' || event.key === 'F')) {
        // Rotate the reading mode: vertical -> paged -> gallery -> vertical.
        // Per-mode settings memory (T2-9) restores each mode's last values.
        event.preventDefault();
        switchMode(nextReadingMode(settings.mode));
        return;
      }
      // Digit shortcuts jump straight to a reading mode (1 vertical,
      // 2 gallery, 3 pages — matching the settings-panel segment order).
      // Ctrl/Cmd/Alt stay off so browser tab chords (Ctrl+1..3) keep working.
      // No Shift guard needed: Shift+1 is '!' on common layouts. A same-mode
      // press is a quiet no-op so we don't persist a redundant save.
      const modeForDigit: ReadingMode | null =
        event.key === '1' ? 'vertical' : event.key === '2' ? 'gallery' : event.key === '3' ? 'paged' : null;
      if (!systemModifier && modeForDigit) {
        if (settings.mode === modeForDigit) return;
        event.preventDefault();
        switchMode(modeForDigit);
        return;
      }
      if (!systemModifier && (event.key === 'e' || event.key === 'E')) {
        // Toggle fullscreen — available in every reading mode.
        event.preventDefault();
        toggleFullscreen();
        return;
      }
      // Pass the event itself as the modifiers bag (`ctrlKey`/`metaKey`/
      // `altKey`) so bare-press toggles (G/V/C) can't hijack browser chords.
      const intent = intentForKey(event.key, settings.direction, event.shiftKey, settings.mode, settings.smoothScrollKeys, event);
      if (intent === 'toggleBookmark') {
        // Bookmark / unbookmark the current chapter — same toggle (and
        // toasts) as the toolbar button. Served via the ref so this hot
        // effect never re-subscribes when the toggle identity changes.
        // Incognito: the affordance is hidden, table the shortcut too.
        if (isIncognito()) return;
        event.preventDefault();
        void toggleBookmarkRef.current();
        return;
      }
      if (intent === 'toggleFitHeight') {
        // Paged mode only, mirroring the settings switch (disabled elsewhere).
        if (settings.mode !== 'paged') {
          toast('Only available in page reading mode.', 'info');
          return;
        }
        event.preventDefault();
        update({ fitToHeight: !settings.fitToHeight });
        return;
      }
      if (intent === 'toggleFitWidth') {
        // Vertical mode only, mirroring the settings switch (disabled elsewhere).
        if (settings.mode !== 'vertical') {
          toast('Only available in vertical reading mode.', 'info');
          return;
        }
        event.preventDefault();
        update({ fitToWidth: !settings.fitToWidth });
        return;
      }
      if (intent === 'toggleGap') {
        // Breathing room between pages: vertical + gallery stack pages,
        // paged pairs the two sheets of a spread. All three modes honor
        // the same toggle — paged mode used to hardcode a center gutter
        // that ignored it entirely.
        event.preventDefault();
        update({ imageGap: !settings.imageGap });
        return;
      }
      if (intent === 'exit') {
        target?.blur();
        if (panelId) navigate(`/panel/${encodeURIComponent(panelId)}`);
        return;
      }
      if (intent === 'scrollUp' || intent === 'scrollDown') {
        // Smooth continuous scroll — vertical mode only.
        if (settings.mode !== 'vertical') return;
        event.preventDefault();
        if (intent === 'scrollUp') markNavScroll(50);
        else clearNavScroll();
        // Instant first response: a tap (or a press killed by an early
        // keyup) never survives to the loop's first rAF tick, so move one
        // frame's worth synchronously — every press visibly moves in the
        // same task. Skipped while the loop already runs so key repeats
        // can't inflate the speed.
        if (!isScrollingRef.current) {
          const scroller = containerRef.current?.querySelector(
            '.reader-content',
          ) as HTMLElement | null;
          if (scroller) {
            const max = scroller.scrollHeight - scroller.clientHeight;
            if (max > 0) {
              // Read via the ref (synced every render) so this handler needs
              // no scrollSpeed dependency of its own.
              const step = scrollSpeedRef.current / 60;
              const target = intent === 'scrollUp'
                ? scroller.scrollTop - step
                : scroller.scrollTop + step;
              scroller.scrollTop = Math.max(0, Math.min(max, target));
            }
          }
        }
        setScrollDir(intent === 'scrollUp' ? 'up' : 'down');
        return;
      }
      if (intent === 'stepUp' || intent === 'stepDown') {
        // Vertical: mirror the mouse-wheel behavior (T1-3) — one keypress is
        // `keyPagesPress` whole pages, using the same goToPage/scrollToPage
        // ('smooth') path the wheel uses, so keys and wheel land on identical
        // positions. 0 = native: smooth viewport scroll (80% of viewport).
        if (settings.mode === 'vertical') {
          event.preventDefault();
          if (intent === 'stepUp') markNavScroll();
          else clearNavScroll();
          const content = containerRef.current?.querySelector(
            '.reader-content',
          ) as HTMLElement | null;
          if (!content) return;

          if (settings.keyPagesPress <= 0) {
            // Native: smooth viewport scroll (80% of viewport height).
            // Use scrollTo with behavior: 'smooth' for consistency with
            // scrollToPage and to avoid conflicting rAF loops.
            const step = content.clientHeight * 0.8;
            const targetScrollTop = Math.max(
              0,
              Math.min(
                content.scrollHeight - content.clientHeight,
                content.scrollTop + (intent === 'stepUp' ? -step : step),
              ),
            );
            glideScrollTo(content, targetScrollTop, glideAnimRef, settings.glidePreset);
            return;
          }
          goToPage(
            page +
              (intent === 'stepUp'
                ? -settings.keyPagesPress
                : settings.keyPagesPress),
            settings.glidePreset,
          );
          return;
        }
        // Gallery: smooth step scroll with native smooth scroll.
        if (settings.mode !== 'gallery') return;
        event.preventDefault();
        if (intent === 'stepUp') markNavScroll();
        else clearNavScroll();
        const content = containerRef.current?.querySelector(
          '.reader-content',
        ) as HTMLElement | null;
        if (content) {
          const step = window.innerHeight * 0.8;
          const targetScrollTop = Math.max(
            0,
            Math.min(
              content.scrollHeight - content.clientHeight,
              content.scrollTop + (intent === 'stepUp' ? -step : step),
            ),
          );
          glideScrollTo(content, targetScrollTop, glideAnimRef, settings.glidePreset);
        }
        return;
      }
      // Vertical/gallery: ←/A and →/D hop between chapters.
      if (intent === 'chapterForward' || intent === 'chapterBackward') {
        event.preventDefault();
        target?.blur();
        goToChapter(intent === 'chapterForward' ? 'next' : 'prev');
        return;
      }
      // Paged: ←/A/→/D and Space turn pages within the chapter.
      if (intent) {
        event.preventDefault();
        // Blur any element that gained focus via mouse click (e.g. the paged
        // reader zone buttons or footer nav buttons) so the focus-visible
        // ring doesn't linger once keyboard navigation begins.
        target?.blur();
        handleIntent(intent);
      }
    };
    window.addEventListener('keydown', handler);

    // Release-to-stop: letting go of the smooth-scroll keys halts the scroll.
    const stopScroll = () => setScrollDir(null);
    window.addEventListener('keyup', stopScroll);

    // Cancel any in-flight keyboard scroll when the viewport changes
    // size (e.g. DevTools opening/shrinking the viewport), so the old
    // rAF loop — computed with the previous clientHeight / innerHeight
    // — doesn't keep writing scrollTop with outdated metrics.
    const onResize = () => {
      // Native smooth scroll (scrollTo with behavior: 'smooth') handles
      // resize gracefully; no rAF loop to cancel.
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('keyup', stopScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [settings.direction, settings.mode, settings.imageGap, settings.fitToHeight, settings.fitToWidth, settings.keyPagesPress, settings.glidePreset, settings.smoothScrollKeys, page, goToPage, handleIntent, goToChapter, toggleFullscreen, panelId, navigate, update, switchMode, toast]);

  /* Auto-hide controls: hide on scroll down, reveal on scroll up, hide after
     idle, and stay visible while hovering the toolbar. Pointer movement
     anywhere else on the page (or outside it) never reveals the toolbar. */
  useEffect(() => {
    const clearHideTimer = () => {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = undefined;
    };

    const reader = containerRef.current;
    const content = reader?.querySelector('.reader-content') as HTMLElement | null;
    const toolbar = reader?.querySelector('.reader-toolbar') as HTMLElement | null;

    /* Keep the toolbar pinned while a panel is open. */
    if (settingsOpen) {
      setControlsVisible(true);
      clearHideTimer();
      return;
    }
    /* Every page in the chapter failed to load. The reader is nothing but
       error boxes, so there is no reading to get out of the way of: pin the
       toolbar permanently. This is what keeps the settings button reachable
       on a fully-broken chapter (see `failedPages`). */
    if (everyPageFailed) {
      setControlsVisible(true);
      clearHideTimer();
      return;
    }
    if (!content) return;

    const showTemporarily = () => {
      setControlsVisible(true);
      clearHideTimer();
      hideTimerRef.current = window.setTimeout(() => setControlsVisible(false), 2500);
    };
    const hideNow = () => {
      setControlsVisible(false);
      clearHideTimer();
    };

    let lastScrollY = content.scrollTop;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const scrollY = content.scrollTop;
        const delta = scrollY - lastScrollY;
        lastScrollY = scrollY;
        // Skip the hide-on-scroll-down branch only for upward keyboard
        // nav (see `navScrollUntilRef`): downward keyboard scrolls clear
        // the gate so they hide immediately. Mouse-wheel and touch scrolls
        // never set the flag, so they keep the hide-on-scroll-down behavior.
        if (delta > 10 && performance.now() >= navScrollUntilRef.current) {
          hideNow();
        } else if (delta < -10) {
          showTemporarily();
        }
        ticking = false;
      });
    };

    /* Hovering the toolbar keeps it visible; tapping the content (e.g. page
       turns) reveals it briefly. Pointer moves elsewhere are ignored — except
       on mouse/pen: moving into the top edge zone reveals the toolbar (the
       hidden toolbar is translated off-screen, so it can never receive a
       pointermove itself; hover-to-reveal must come from the container).
       Touch devices keep the existing tap/scroll reveal. */
    const TOP_REVEAL_PX = 64;
    const onToolbarMove = showTemporarily;
    const onContainerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
      if (event.clientY <= TOP_REVEAL_PX) showTemporarily();
    };
    /**
     * Reveal-on-tap, registered in the CAPTURE phase so it still runs when a
     * child swallows the click. A failed page renders an error box that calls
     * `stopPropagation()` (deliberately — a tap on a broken page must not turn
     * pages), which would otherwise suppress the bubble-phase
     * `onContentClick` below and leave the toolbar unsummonable on a chapter
     * where nothing loads. Capture on an ancestor runs before the target's own
     * handler, so the reveal happens regardless.
     *
     * Deliberately separate from `onContentClick` rather than flipping that one
     * to capture: it calls `event.stopPropagation()` itself when auto-scroll is
     * running, and in the capture phase that would cancel the click before it
     * reached the Reload button inside the error box.
     */
    const onCaptureClick = () => {
      showTemporarily();
    };
    const onContentClick = (event: MouseEvent) => {
      // Clicking anywhere on the image/content stops both smooth scroll
      // (Shift+W/S) and paced hands-free auto-scroll. When auto-scroll is
      // active, the click must not propagate to child reader components so
      // it doesn't also turn pages or hop chapters.
      // N.B. read smooth-scroll state via scrollDirRef (mirrored every
      // render): depending on the scrollDir *state* here would re-run this
      // whole effect on every Shift+W/S press AND release — and each run
      // ends in showTemporarily(), so releasing the keys would pop the
      // toolbar up even though the user never asked for it.
      const wasAutoScolling = scrollDirRef.current !== null || autoScrollActive;
      setScrollDir(null);
      setAutoScrollActive(false);
      showTemporarily();
      if (wasAutoScolling) {
        event.stopPropagation();
        event.preventDefault();
      }
    };
    // Keyboard nav mirrors the scroll-direction rule: moving up/backward
    // reveals the toolbar, moving down/forward hides it. The old code showed
    // the bar on EVERY nav key, so spamming scroll-down (S / ArrowDown /
    // Space) in vertical mode — or turning pages forward in fullscreen —
    // pinned the toolbar on screen even though the user never scrolled up.
    // Exception: paged mode has no scroll direction — page turns (A/D,
    // arrows) hide in BOTH directions, so backward (A) behaves exactly
    // like forward (D) and never pops the toolbar up while reading.
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (isEditableKeyTarget(target)) return;
      const intent = intentForKey(event.key, settings.direction, event.shiftKey, settings.mode, settings.smoothScrollKeys, event);
      if (settings.mode === 'paged' && (intent === 'forward' || intent === 'backward')) {
        hideNow();
        return;
      }
      if (
        intent === 'stepUp' ||
        intent === 'scrollUp' ||
        intent === 'backward' ||
        intent === 'chapterBackward'
      ) {
        showTemporarily();
        return;
      }
      if (
        intent === 'stepDown' ||
        intent === 'scrollDown' ||
        intent === 'forward' ||
        intent === 'chapterForward'
      ) {
        hideNow();
        return;
      }
      // intentForKey doesn't cover these — map them by scroll direction.
      if (event.key === 'PageUp' || event.key === 'Home') showTemporarily();
      else if (event.key === 'PageDown' || event.key === 'End') hideNow();
    };

    content.addEventListener('scroll', onScroll, { passive: true });
    content.addEventListener('click', onContentClick);
    content.addEventListener('click', onCaptureClick, true);
    toolbar?.addEventListener('pointermove', onToolbarMove);
    reader?.addEventListener('pointermove', onContainerMove);
    window.addEventListener('keydown', onKeyDown);

    showTemporarily();

    // This effect mounts during the loading state, before the toolbar/scroll
    // container exist, so re-run once the chapter payload arrives. It must
    // ALSO re-run when showPagesLoading flips back to false: on slow loads
    // (typical on mobile) the payload arrives while the spinner is still up,
    // and useDelayedLoading clears its flag one render later — so at the time
    // the payload-triggered run executes, .reader-content doesn't exist yet.
    // Without this key, the listeners never attach after a chapter transition
    // and the toolbar stops hiding on scroll until settings is opened/closed.
    return () => {
      clearHideTimer();
      content.removeEventListener('scroll', onScroll);
      content.removeEventListener('click', onContentClick);
      content.removeEventListener('click', onCaptureClick, true);
      toolbar?.removeEventListener('pointermove', onToolbarMove);
      reader?.removeEventListener('pointermove', onContainerMove);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    settingsOpen,
    chapterPages.data,
    showPagesLoading,
    settings.direction,
    settings.mode,
    settings.smoothScrollKeys,
    autoScrollActive,
    everyPageFailed,
  ]);

  /* Fullscreen state tracking. */
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  /**
   * Smooth continuous scroll (Shift+W / Shift+S, or plain W/S with smooth-scroll keys) — vertical mode only.
   *
   * A requestAnimationFrame loop nudges `.reader-content`'s scrollTop by
   * `scrollSpeedPx × elapsedSeconds` each frame, so it stays smooth and
   * framerate-independent. The loop self-terminates at the top/bottom
   * boundary; releasing the key (keyup) also stops it. Speed changes take
   * effect mid-scroll via the ref.
   */
  useEffect(() => {
    // Start the scroll loop on first press, keep running until key release
    // or boundary hit. Use isScrollingRef to avoid restarting on key repeat.
    if (scrollDir !== null && !isScrollingRef.current) {
      isScrollingRef.current = true;
      navScrollUntilRef.current = performance.now() + 50;
    }
    if (scrollDir === null) {
      isScrollingRef.current = false;
      cancelAnimationFrame(rafRef.current);
      return;
    }

    const content = containerRef.current?.querySelector('.reader-content') as HTMLElement | null;
    if (!content) {
      setScrollDir(null);
      isScrollingRef.current = false;
      return;
    }

    // Anchor the first frame to effect time: rAF timestamps lag
    // performance.now(), so without this the first frame always computes a
    // negative dt and is skipped.
    const effectAt = performance.now();
    let last = effectAt;
    let raf = 0;

    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const dir = scrollDirRef.current;
      const speed = scrollSpeedRef.current;
      if (dir === null) {
        setScrollDir(null);
        isScrollingRef.current = false;
        cancelAnimationFrame(raf);
        return;
      }

      const delta = dir === 'up' ? -speed * dt : speed * dt;
      if (dt <= 0) {
        raf = requestAnimationFrame(tick);
        return;
      }

      const max = content.scrollHeight - content.clientHeight;
      if (max <= 0) {
        setScrollDir(null);
        isScrollingRef.current = false;
        cancelAnimationFrame(raf);
        return;
      }

      const next = content.scrollTop + delta;
      if (next <= 0) {
        content.scrollTop = 0;
        setScrollDir(null);
        isScrollingRef.current = false;
        cancelAnimationFrame(raf);
        return;
      }
      if (next >= max) {
        content.scrollTop = max;
        setScrollDir(null);
        isScrollingRef.current = false;
        cancelAnimationFrame(raf);
        return;
      }
      content.scrollTop = next;
      raf = requestAnimationFrame(tick);
    };

    rafRef.current = raf;
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      isScrollingRef.current = false;
    };
  }, [scrollDir, settings.scrollSpeed, containerRef]);

  /**
   * Hands-free auto-scroll (T1-2): paced advancing while the setting is on,
   * stopping at the last page (where it pauses rather than looping — the
   * user re-enables it to restart). Pause when the panel opens.
   *
   * Vertical mode glides CONTINUOUSLY instead of page-hopping: a rAF loop
   * advances the scroller at (one page-height ÷ autoScrollDelayMs) px/s, so
   * the average pace is exactly "one page per interval" but the motion is a
   * smooth glide — the old `goToPage(next, 'smooth')` per tick visibly
   * jumped page to page (and its animation raced the next tick). Paged and
   * gallery modes keep the discrete page-turn interval.
   *
   * The interval/rAF is created ONCE per activation: the current position is
   * read from the live scroller instead of being a dependency, so scroll
   * events (which update `page` many times) can never tear down and restart
   * the timer before it elapses.
   */
  useEffect(() => {
    if (!autoScrollActive) return;
    if (!settings.autoScrollDelayMs) return;
    if (!pages.length) return;
    if (settingsOpen) return;

    if (settings.mode === 'vertical') {
      const content = containerRef.current?.querySelector(
        '.reader-content',
      ) as HTMLElement | null;
      if (!content) return;
      const delaySec = settings.autoScrollDelayMs / 1000;
      let last = performance.now();
      let raf = 0;
      setAutoScrollPaused(false);
      const tick = (now: number) => {
        // Recompute per tick: scrollHeight grows as lazy pages load, so the
        // glide speed stays "one page per interval" even mid-load.
        const perPage = content.scrollHeight / Math.max(pageCount, 1);
        const pxPerSec = perPage / delaySec;
        const dt = Math.max((now - last) / 1000, 0);
        last = now;
        const max = content.scrollHeight - content.clientHeight;
        const target = content.scrollTop + pxPerSec * dt;
        if (max <= 0 || target >= max) {
          content.scrollTop = Math.max(max, 0);
          // At the last page: pause instead of looping. The toggle stays on
          // so re-tapping restarts from the beginning without a detour.
          setAutoScrollPaused(true);
          return;
        }
        content.scrollTop = target;
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }

    const id = window.setInterval(() => {
      const current = pageRef.current;
      // Double-page paged mode turns whole spreads (T1-1).
      const next =
        settings.mode === 'paged' && settings.doublePage
          ? nextSpreadPage({ page: current, pageCount }, settings.direction)
          : applyIntent({ page: current, pageCount }, 'forward');
      if (next !== null) {
        goToPage(next, 'smooth');
        setAutoScrollPaused(false);
        return;
      }
      // At the last page: pause instead of looping. The toggle stays on so
      // re-tapping restarts from the beginning without a settings detour.
      setAutoScrollPaused(true);
    }, settings.autoScrollDelayMs);

    setAutoScrollPaused(false);
    return () => window.clearInterval(id);
  }, [
    autoScrollActive,
    settings.autoScrollDelayMs,
    settings.mode,
    settings.direction,
    settings.doublePage,
    settingsOpen,
    pages.length,
    pageCount,
    goToPage,
  ]);

  /**
   * Mouse-wheel smooth scroll (T1-3), vertical mode only. When
   * `wheelPagesPerNotch` is non-zero the wheel is quantised to whole pages
   * so a flick never lands mid-page; 0 = native behaviour.
   *
   * We attach to the scroller (not the window) so the wheel only acts while
   * over the reader — scrolling elsewhere (the settings panel, the page
   * outside) is untouched.
   */
  useEffect(() => {
    if (settings.mode !== 'vertical' || settings.wheelPagesPerNotch <= 0) return;
    const content = containerRef.current?.querySelector('.reader-content') as HTMLElement | null;
    if (!content) return;

    const onWheel = (event: WheelEvent) => {
      const step = wheelPageStep(event.deltaY, settings.wheelPagesPerNotch);
      if (step === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const next = clampPage(page + step, pageCount);
      if (next === page) return;
      verticalRef.current?.scrollToPage(next, 'smooth');
      setPage(next);
    };

    content.addEventListener('wheel', onWheel, { passive: false });
    return () => content.removeEventListener('wheel', onWheel);
  }, [settings.mode, settings.wheelPagesPerNotch, page, pageCount]);

  /**
   * Mouse wheel page-turning — paged mode. Accumulates wheel deltas so one
   * notch (~120 px) — or a trackpad flick — turns exactly one page, without
   * double-firing on inertial events. While a scrollable stage (e.g. a page
   * taller than the viewport) can still be panned natively and is not at its
   * edge in the wheel direction, the wheel pans it instead of turning.
   */
  useEffect(() => {
    if (settings.mode !== 'paged') return;
    const content = containerRef.current?.querySelector('.reader-content') as HTMLElement | null;
    if (!content) return;

    let accumulated = 0;
    const NOTCH_PX = 120;
    const onWheel = (event: WheelEvent) => {
      const stage = content.querySelector('.paged-reader__stage') as HTMLElement | null;
      if (stage) {
        const scrollable = stage.scrollHeight > stage.clientHeight + 1;
        const atTop = stage.scrollTop <= 0;
        const atBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 1;
        if (scrollable && !((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom))) {
          accumulated = 0; // let the browser pan the scrollable page
          return;
        }
      }
      accumulated += event.deltaY;
      event.preventDefault();
      event.stopPropagation();
      if (Math.abs(accumulated) < NOTCH_PX) return;
      const steps = Math.trunc(accumulated / NOTCH_PX);
      accumulated -= steps * NOTCH_PX;
      handleIntent(steps < 0 ? 'backward' : 'forward');
    };

    content.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      content.removeEventListener('wheel', onWheel);
      accumulated = 0;
    };
  }, [settings.mode, handleIntent]);

  /**
   * Background prefetch of the next chapter (T3-1). Fires once, a couple of
   * seconds after the current chapter's pages arrive — long enough that the
   * reader's own image fetches go first. Disabled entirely in data-saver
   * mode (T3-2).
   */
  useEffect(() => {
    if (settings.dataSaver) return;
    const nextId = chapterPages.data?.nextChapterId;
    if (!nextId) return;
    const timer = window.setTimeout(() => {
      prefetchedNextRef.current = nextId;
      prefetchChapterPages(nextId);
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [chapterPages.data?.nextChapterId, settings.dataSaver, prefetchChapterPages]);

  /* ---- render ---------------------------------------------------------- */

  // An actual failure gets the error screen immediately. A query that is
  // still in flight (no data yet, no error) must never look like a failure:
  // during the pre-grace window we render nothing (so fast/cached chapters
  // don't flash a spinner), and only show the delayed spinner once the grace
  // period expires. This avoids the "need to reload" flash on open.
  //
  // The container div is ALWAYS rendered with the same ref: fullscreen is
  // requested on it, and browsers exit fullscreen as soon as that element
  // leaves the DOM. Swapping it out for a loading/error wrapper would kick
  // the user out of fullscreen mid-chapter-transition (most visible on
  // mobile, where chapter loads are slow enough to show the spinner).
  let body: ReactNode = null;
  if (chapterPages.isError) {
    body = (
      <>
        <ErrorState
          title="Unable to load this chapter."
          message={chapterPages.error?.message}
          onRetry={() => chapterPages.refetch()}
        />
        <div className="reader-error-actions">
          {panelId && (
            <Link to={`/panel/${encodeURIComponent(panelId)}`} className="btn btn--ghost">
              Back to panel
            </Link>
          )}
        </div>
      </>
    );
  } else if (showPagesLoading) {
    body = null;
  } else if (chapterPages.data) {
    const data = chapterPages.data;
    /**
     * Mount position for a fresh chapter hop. Right after navigation the
     * reset effect below hasn't run yet, so `page` still holds the old
     * chapter's position — mounting the new reader at it would jump to the
     * wrong spot when the payload is served instantly from cache (the
     * restore gate only fires once per mount). Mount at 0 instead; once
     * the reset effect runs, `page` agrees and this is a no-op. After a
     * mode switch (same chapter) keep the current page.
     */
    const hopInitialPage = chapterId !== resetChapter ? 0 : page;

    const currentChapter = chapters.data?.find((c) => c.id === data.chapterId);
    // Prefer the chapter-list title, but never blank the header: while the
    // list is loading (or holds a stale partial cache) the source label
    // ("Chapter 3") is the only current-chapter signal we have.
    const enhancedChapterTitle = currentChapter?.title ?? data.chapterTitle;

    body = (
      <>
        <ReaderToolbar
          panelId={data.panelId}
          panelTitle={data.panelTitle}
          chapterTitle={enhancedChapterTitle}
          chapterId={data.chapterId}
          chapters={chapters.data ?? []}
          visible={controlsVisible}
          isFullscreen={isFullscreen}
          settingsOpen={settingsOpen}
          autoScrollActive={autoScrollActive}
          autoScrollRunning={autoScrollRunning}
          showAutoScrollButton={settings.showAutoScrollButton}
          onToggleFullscreen={toggleFullscreen}
          onToggleAutoScroll={toggleAutoScroll}
          onOpenSettings={() => setSettingsOpen((open) => !open)}
        />

        {autoScrollActive && settings.autoScrollDelayMs && (
          <div
            className="reader-auto-scroll reader-auto-scroll--paced"
            role="status"
            aria-live="polite"
            aria-label={autoScrollRunning ? 'Auto-scrolling' : 'Auto-scroll paused at last page'}
          >
            <span className="reader-auto-scroll__glyph" aria-hidden="true">
              {autoScrollRunning ? <IconPlay size={14} /> : <IconPause size={14} />}
            </span>
            <span className="reader-auto-scroll__text">
              Auto · {(settings.autoScrollDelayMs / 1000).toFixed(1)}s ·{' '}
              {autoScrollRunning ? 'running' : 'paused at end'}
            </span>
          </div>
        )}

        {settingsEverOpened && (
          <ReaderSettingsPanel
            settings={storedSettings}
            performanceMode={performanceMode}
            onUpdate={update}
            onClose={() => setSettingsOpen(false)}
            open={settingsOpen}
            page={page}
            pageCount={pageCount}
            onPageSelect={(target) => goToPage(target, 'instant')}
            chapters={chapters.data ?? []}
            currentChapterId={data.chapterId}
            onChapterSelect={goToChapterById}
          />
        )}

        <main
          className={`reader-content${settings.showScrollbar ? ' reader-content--scrollbar-visible' : ''}`}
          tabIndex={-1}
          style={{ '--page-brightness': `${settings.imageBrightness}%` } as CSSProperties}
        >
          {settings.mode === 'vertical' ? (
            <VerticalReader
              /* Fresh mount per chapter (same semantics as the old full-load
                 hop, minus the document unload that killed fullscreen). */
              key={chapterId}
              ref={verticalRef}
              pages={pages}
              imageWidth={settings.imageWidth}
              imageWidthPx={settings.imageWidthPx}
              imageHeightPx={settings.imageHeightPx}
              imageGap={settings.imageGap}
              fitToWidth={settings.fitToWidth}
              direction={settings.direction}
              eagerPages={settings.imageLoad === 'parallel' && !settings.dataSaver}
              preloadAhead={settings.dataSaver ? 1 : settings.preloadAhead}
              onPageChange={setPage}
              onProgress={(p, ratio) => {
                setPage(p);
                setScrollRatio(ratio);
              }}
              onChapterNavigate={goToChapter}
              chapterTag={chapterId}
              /* Preserve the reading position across mode switches: the
                 parent keeps `page` while the newly mounted reader starts
                 at scrollTop 0 — it jumps back here before tracking.
                 On a fresh chapter hop this is the stashed position (see
                 hopInitialPage above) so cached payloads restore correctly. */
              initialPage={hopInitialPage}
              onPageError={handlePageError}
              onPageLoad={handlePageLoad}
            />
          ) : settings.mode === 'gallery' ? (
            <GalleryReader
              /* Fresh mount per chapter (see above). */
              key={chapterId}
              ref={galleryRef}
              pages={pages}
              imageWidth={settings.imageWidth}
              imageWidthPx={settings.imageWidthPx}
              imageHeightPx={settings.imageHeightPx}
              imageGap={settings.imageGap}
              direction={settings.direction}
              onPageChange={setPage}
              onProgress={(p, ratio) => {
                setPage(p);
                setScrollRatio(ratio);
              }}
              onChapterNavigate={goToChapter}
              chapterTag={chapterId}
              /* Preserve the reading position across mode switches (see above). */
              initialPage={hopInitialPage}
              onPageError={handlePageError}
              onPageLoad={handlePageLoad}
            />
          ) : (
            <PagedReader
              /* Fresh mount per chapter (see above). Paged mode is fully
                 controlled by the parent `page` state, so directed landings
                 keep working through the page-load effect. */
              key={chapterId}
              pages={pages}
              page={page}
              direction={settings.direction}
              doublePage={settings.doublePage}
              spreadOddPolicy={settings.spreadOddPolicy}
              autoLandscapeSingle={settings.autoLandscapeSingle}
              onNavigate={handleIntent}
              chapterTag={chapterId}
              /* Forward the "Image loading: All at once" setting so paged
                 mode preloads every page at high priority. Without this,
                 only the on-screen page finished downloading because the
                 detached `new Image()` requests were deprioritized behind
                 the current spread's eager `<img>`. */
              eagerPages={settings.imageLoad === 'parallel' && !settings.dataSaver}
              /* Forward the "Image gap" toggle so the center gutter of a
                 double-page spread can be closed — paged mode used to
                 hardcode a 2% sheet pad + 3px seam that ignored it. */
              imageGap={settings.imageGap}
              /* Narrow the stage so a page never overflows — the same
                 "Image width" slider as vertical/gallery modes. Ignored
                 while fit-to-height is on. */
              imageWidth={settings.imageWidth}
              fitToHeight={settings.fitToHeight}
              onPageError={handlePageError}
              onPageLoad={handlePageLoad}
            />
          )}
        </main>

        {/* Bottom bar: progress + mobile-friendly page buttons */}
        <footer
          className={`reader-footer${settings.showProgressBar ? '' : ' reader-footer--hidden'}`}
        >
          <div
            className="reader-progress"
            role="progressbar"
            aria-valuenow={page + 1}
            aria-valuemin={1}
            aria-valuemax={pageCount}
            aria-label="Reading progress"
          >
            <div
              className="reader-progress__fill"
              style={{
                transform: `scaleX(${
                  settings.mode === 'paged'
                    ? progressFraction(page, pageCount)
                    : smoothProgressFraction(page, pageCount, scrollRatio)
                })`,
              }}
            />
          </div>
        </footer>
      </>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`reader reader--${settings.background}${controlsVisible ? '' : ' reader--controls-hidden'}${settingsOpen ? ' reader--sidebar-open' : ''}${scrollDir ? ' reader--auto-scroll' : ''}${autoScrollActive ? ' reader--auto-scroll-paced' : ''}${settings.doublePage ? ' reader--double-page' : ''}${settings.clearToolbarSpace ? ' reader--toolbar-clear' : ''}`}
    >
      {body}
    </div>
  );
}
