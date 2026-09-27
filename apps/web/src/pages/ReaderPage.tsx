import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { PanelPage, SaveProgressInput } from '@panel/shared';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useChapterPages, useChapters, useProgress, useSaveProgress, usePrefetchChapterPages } from '../api/hooks';
import { api } from '../api/client';
import { useDelayedLoading } from '../hooks/useDelayedLoading';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { ErrorState } from '../components/StateView';
import { useToast } from '../components/Toast';
import { IconPause, IconPlay } from '../components/icons';
import { PagedReader } from '../reader/PagedReader';
import { GalleryReader, type GalleryReaderHandle } from '../reader/GalleryReader';
import { ReaderSettingsPanel } from '../reader/ReaderSettingsPanel';
import { ReaderToolbar } from '../reader/ReaderToolbar';
import { nextReadingMode, scrollSpeedPx, DEFAULT_READER_SETTINGS, type ReaderSettings, type ReadingMode, type GlidePreset } from '../reader/settings';
import { VerticalReader, type VerticalReaderHandle } from '../reader/VerticalReader';
import { proxiedPageUrl } from '../utils/format';
import {
  applyIntent,
  clampPage,
  cleanRatio,
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

/**
 * Chapter-hop handoff keys plus the live session position. Hops are full
 * document loads, so in-memory refs can't carry intent across — the
 * destination chapter's landing position (paged mode) and the abandoned
 * chapter's exact scroll position (vertical, as an overall chapter fraction)
 * are stashed in sessionStorage just before the unload. The page memory is
 * additionally rewritten on every page change, so a soft refresh (same tab)
 * restores the exact position instead of restarting at the first image.
 * Tab-scoped, so a position never leaks into another tab. No server
 * progress involved.
 *
 * Fraction memory lives under a v2 key: v1 stored a per-page intra-page
 * ratio (`{p, r}`), which the chapter-fraction scheme must never misread.
 */
const CHAPTER_LANDING_SESSION_KEY = 'panel-reader:chapter-landing:v1';
const CHAPTER_PAGE_MEMORY_SESSION_KEY = 'panel-reader:page-memory:v2';

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
    // Storage blocked — the hop still works, just without the landing/memory restore.
  }
}

/** Stash a paged-mode directed landing for the destination chapter. */
function stashChapterLanding(destChapterId: string, landing: 'first' | 'last'): void {
  const map = readSessionMap(CHAPTER_LANDING_SESSION_KEY);
  map.set(destChapterId, landing);
  writeSessionMap(CHAPTER_LANDING_SESSION_KEY, map);
}

/** Peek (read without deleting) a stashed landing for this chapter, if any. */
function peekChapterLanding(chapterId: string): 'first' | 'last' | null {
  const landing = readSessionMap(CHAPTER_LANDING_SESSION_KEY).get(chapterId);
  return landing === 'first' || landing === 'last' ? landing : null;
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

/** Remember the current position so a soft refresh or a later hop back
 * restores the exact scroll spot (rewritten live — session only). In
 * vertical mode the overall chapter fraction, the page anchor (viewport-
 * center page + intra-page ratio) and the exact horizontal pan are stored
 * alongside (`{p, f, x, a}` JSON); other modes store the plain page
 * index. */
function stashPageMemory(chapterId: string, page: number, fraction?: number, scrollX?: number, anchorRatio?: number): void {
  const map = readSessionMap(CHAPTER_PAGE_MEMORY_SESSION_KEY);
  if (typeof fraction === 'number' && Number.isFinite(fraction)) {
    const clamped = Math.max(0, Math.min(1, fraction));
    const entry: { p: number; f: number; x?: number; a?: number } = {
      p: page,
      f: Math.round(clamped * 1000) / 1000,
    };
    if (typeof scrollX === 'number' && Number.isFinite(scrollX) && scrollX !== 0) {
      entry.x = Math.round(scrollX * 10) / 10;
    }
    const anchor = cleanRatio(anchorRatio);
    if (anchor !== null) {
      entry.a = Math.round(anchor * 1000) / 1000;
    }
    map.set(chapterId, JSON.stringify(entry));
  } else {
    map.set(chapterId, String(page));
  }
  // Bound the memory: a long hopping session must not grow storage unbounded.
  while (map.size > 100) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
  writeSessionMap(CHAPTER_PAGE_MEMORY_SESSION_KEY, map);
}

/** Page + chapter fraction + page anchor + horizontal pan previously left on
 * this chapter in this tab session, if any. Reads both the current
 * `{p, f, x, a}` JSON entries and legacy plain-number entries. (The v1
 * `{p, r}` per-page ratios live under a different key and are never read
 * here.) */
function readPageMemory(chapterId: string): { page: number; fraction?: number; scrollX?: number; anchorRatio?: number } | undefined {
  const raw = readSessionMap(CHAPTER_PAGE_MEMORY_SESSION_KEY).get(chapterId);
  if (raw === undefined) return undefined;
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { p?: unknown; f?: unknown; x?: unknown; a?: unknown };
      if (typeof parsed.p !== 'number' || !Number.isInteger(parsed.p) || parsed.p < 0) {
        return undefined;
      }
      if (parsed.f === undefined) return { page: parsed.p };
      if (typeof parsed.f !== 'number' || !Number.isFinite(parsed.f)) return { page: parsed.p };
      const out: { page: number; fraction?: number; scrollX?: number; anchorRatio?: number } = {
        page: parsed.p,
        fraction: Math.max(0, Math.min(1, parsed.f)),
      };
      if (typeof parsed.x === 'number' && Number.isFinite(parsed.x)) out.scrollX = parsed.x;
      const anchor = cleanRatio(typeof parsed.a === 'number' ? parsed.a : null);
      if (anchor !== null) out.anchorRatio = anchor;
      return out;
    } catch {
      return undefined;
    }
  }
  const page = Number(raw);
  return Number.isInteger(page) && page >= 0 ? { page } : undefined;
}

/** Clamp a chapter fraction for persistence (finite 0–1, else null). */
function cleanFraction(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : null;
}

/**
 * The reader — orchestrates pages, navigation (keyboard / touch / buttons),
 * chapter transitions, settings, fullscreen and progress persistence.
 */
export function ReaderPage() {
  const { chapterId = '' } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const chapterPages = useChapterPages(chapterId);
  const showPagesLoading = useDelayedLoading(chapterPages.isLoading);
  const prefetchChapterPages = usePrefetchChapterPages();
  const pages = chapterPages.data?.pages ?? EMPTY_PAGES;
  const pageCount = pages.length;
  const panelId = chapterPages.data?.panelId ?? '';

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
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_READER_SETTINGS);

  /** Reload settings from the server file (cross-tab sync target). */
  const reloadSettings = useCallback(() => {
    api.getReaderSettings()
      .then((saved) => {
        setSettings(saved);
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
      setSettings((current) => {
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
      setSettings((current) => {
        const next = { ...current, mode };
        // Persist like any other change so the mode survives refreshes and
        // syncs to other open tabs (previously this was session-local).
        void api.saveReaderSettings(next).then(() => pingReaderSettingsSync());
        return next;
      });
    },
    [],
  );

  /* Session-only position: lazy-init from sessionStorage so the first render
     already starts at the live page — a soft refresh never flashes page 1.
     A directed hop landing wins over the memory (peeked, not consumed). */
  const [page, setPage] = useState(() => {
    if (peekChapterLanding(chapterId) !== null) return 0;
    return readPageMemory(chapterId)?.page ?? 0;
  });
  /* Live intra-page fraction driving the footer progress bar (display only —
     continue-reading uses the chapter fraction below). Always starts fresh. */
  const [scrollRatio, setScrollRatio] = useState(0);
  /* Overall chapter fraction (0–1) in vertical mode — the continue-reading
     position. Seeded from session memory so a soft refresh remounts at the
     same relative content. */
  const [scrollFraction, setScrollFraction] = useState(() => {
    if (peekChapterLanding(chapterId) !== null) return 0;
    return readPageMemory(chapterId)?.fraction ?? 0;
  });
  /* Page-anchored position (0–1 ratio through `page`) in vertical mode —
     the precise continue-reading position for long-strip chapters, where
     the overall fraction drifts with non-uniform image growth. Seeded from
     session memory; falls back to the fraction when absent. */
  const [anchorRatio, setAnchorRatio] = useState(() => {
    if (peekChapterLanding(chapterId) !== null) return 0;
    return readPageMemory(chapterId)?.anchorRatio ?? 0;
  });
  /* Exact horizontal pan (CSS px) in vertical mode — the precision
     complement to the fraction (nonzero while pinch-zoomed). Reported live
     from the scroller every scroll frame; seeded from session memory. */
  const [scrollX, setScrollX] = useState(() => {
    if (peekChapterLanding(chapterId) !== null) return 0;
    return readPageMemory(chapterId)?.scrollX ?? 0;
  });
  /** False until the user picks "continue" / "start over" (or nothing to resume). */
  const [resumeResolved, setResumeResolved] = useState(false);
  /**
   * Chapter the page/resume state was last reset for. Guards the progress-save
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
  /** Session page restored for this chapter mount (>0 means "don't scroll to
      top on pages-load" — the child reader jumps via `initialPage`). */
  const restoredMemoryRef = useRef<number | null>(null);
  /** Session/server fraction restore in flight (non-null means "don't scroll
      to top on pages-load" even when the restored page is 0 — the child
      reader jumps via `initialFraction`). Consumed by the page-load effect. */
  const restoredFractionRef = useRef<number | null>(null);
  /** The panel is heavy (shortcuts tables, dropdowns) — keep it out of the
      initial DOM so it can't drag down LCP; mount on first open and leave it
      mounted afterwards so close/reopen still animates. */
  const [settingsEverOpened, setSettingsEverOpened] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
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
  /** Latest intra-page fraction for throttled session writes (updates every scroll frame). */
  const scrollRatioRef = useRef(scrollRatio);
  /** Latest chapter fraction for progress saves (updates every scroll frame). */
  const scrollFractionRef = useRef(scrollFraction);
   /** Latest horizontal pan in vertical mode (updates every scroll frame). */
   const scrollXRef = useRef(scrollX);
   /** Latest anchor ratio for progress saves (updates every scroll frame). */
   const anchorRatioRef = useRef(anchorRatio);
   /** Last fraction+page actually sent to the server (dedupes scroll saves). */
   const lastSavedFractionRef = useRef<number | null>(null);
   const lastSavedPageRef = useRef<number | null>(null);
  /** Current reading mode for session-write handlers that must not re-subscribe. */
  const readerModeRef = useRef(settings.mode);
  /** Latest chapter payload for unload-flush handlers (see flushProgress). */
  const chapterPagesRef = useRef(chapterPages.data);
  /** Mirrors of resume/reset state for the stable flush callbacks. */
  const resumeResolvedRef = useRef(resumeResolved);
  const resetChapterRef = useRef(resetChapter);
  scrollDirRef.current = scrollDir;
  scrollSpeedRef.current = scrollSpeedPx(settings.scrollSpeed);
  pageRef.current = page;
  scrollRatioRef.current = scrollRatio;
  scrollFractionRef.current = scrollFraction;
  anchorRatioRef.current = anchorRatio;
  readerModeRef.current = settings.mode;
  chapterPagesRef.current = chapterPages.data;
  resumeResolvedRef.current = resumeResolved;
  resetChapterRef.current = resetChapter;

  /* Reset on mount. Hops and soft refreshes are full document loads, so this
     runs once per chapter with the landing/page-memory stashed in
     sessionStorage (see `hardHopToChapter` + the live write below). A
     paged-mode directed transition chooses the landing position: the next
     chapter opens at its first page, the previous chapter at its last page.
     Otherwise, if we have a live session page for this chapter (previous
     chapter navigation OR a soft refresh of this same chapter), restore it
     instead of starting from page 0. */
  useEffect(() => {
    const landing = consumeChapterLanding(chapterId);
    if (landing) {
      // Directed paged-mode transition — the position is decided for us, so
      // suppress the resume prompt. The previous chapter's last page needs the
      // payload's page count, which isn't known yet; hold the destination id in
      // lastPageChapterRef and let the page-load effect apply it below.
      lastPageChapterRef.current = landing === 'last' ? chapterId : null;
      restoredMemoryRef.current = null;
      restoredFractionRef.current = null;
      setResumeResolved(true);
      setPage(0);
      setScrollRatio(0);
      scrollFractionRef.current = 0;
      setScrollFraction(0);
      scrollXRef.current = 0;
      setScrollX(0);
      lastSavedFractionRef.current = null;
      lastSavedPageRef.current = null;
    } else {
      const saved = readPageMemory(chapterId);
      restoredMemoryRef.current = saved?.page ?? null;
      restoredFractionRef.current = saved?.fraction ?? null;
      setPage(saved?.page ?? 0);
      scrollFractionRef.current = saved?.fraction ?? 0;
      setScrollFraction(saved?.fraction ?? 0);
      scrollXRef.current = saved?.scrollX ?? 0;
      setScrollX(saved?.scrollX ?? 0);
      anchorRatioRef.current = saved?.anchorRatio ?? 0;
      setAnchorRatio(saved?.anchorRatio ?? 0);
      setResumeResolved(saved !== undefined); // Skip resume prompt if restoring a position
      lastPageChapterRef.current = null;
    }
    setResetChapter(chapterId);
    setSettingsOpen(false);
    const content = containerRef.current?.querySelector('.reader-content') as HTMLElement | null;
    if (restoredMemoryRef.current == null || restoredMemoryRef.current <= 0) {
      window.scrollTo(0, 0);
      content?.scrollTo({ top: 0 });
    }
    // Focus without moving the scroll when restoring, so keyboard nav works
    // immediately but the restored position is kept.
    if (restoredMemoryRef.current != null && restoredMemoryRef.current > 0) {
      content?.focus({ preventScroll: true });
    } else {
      content?.focus();
    }
  }, [chapterId]);

  /* Keep the live session position in sync — every page turn rewrites it
     immediately (with the current chapter fraction in vertical mode), so
     a soft refresh restores the exact spot (session only, no server
     progress involved). */
  useEffect(() => {
    stashPageMemory(
      chapterId,
      page,
      settings.mode === 'vertical' ? scrollFractionRef.current : undefined,
      settings.mode === 'vertical' ? scrollXRef.current : undefined,
    );
  }, [chapterId, page, settings.mode]);

  /* Throttled fraction write (vertical only): the fraction updates every
     scroll frame, so persist it 800ms after scrolling pauses instead of per
     frame. Page turns are already covered by the immediate write above;
     exits are covered by the unmount/pagehide flush below. */
  useEffect(() => {
    if (settings.mode !== 'vertical') return;
    const timer = window.setTimeout(() => {
      stashPageMemory(chapterId, pageRef.current, scrollFractionRef.current, scrollXRef.current);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [chapterId, page, scrollFraction, settings.mode]);

  /* Paged-mode backward transitions land on the previous chapter's last page.
     pageCount is 0 while the payload is loading, so wait for the pages to arrive
     (this effect re-runs once pages/pageCount are known) and jump to the final
     one. Must run after the reset effect so it sees lastPageChapterRef. */
  useEffect(() => {
    if (lastPageChapterRef.current === chapterId && pageCount > 0) {
      lastPageChapterRef.current = null;
      restoredMemoryRef.current = null;
      setPage(pageCount - 1);
      return;
    }
    // Once the new chapter's pages load, make sure the scroller is at the top
    // — unless we just restored a live session position (soft refresh), which
    // the child reader already jumped to via `initialPage`/`initialFraction`.
    // The fraction half matters: fraction restores typically sit on page 0,
    // where the page-only guard below would clobber the mount jump back to
    // top (and a warm cache fires no later image loads to recover it).
    if (pages.length > 0 && pageCount > 0) {
      if (restoredMemoryRef.current != null && restoredMemoryRef.current > 0) {
        restoredMemoryRef.current = null;
        restoredFractionRef.current = null;
        return;
      }
      if (restoredFractionRef.current != null) {
        restoredMemoryRef.current = null;
        restoredFractionRef.current = null;
        return;
      }
      restoredMemoryRef.current = null;
      const content = containerRef.current?.querySelector('.reader-content') as HTMLElement | null;
      content?.scrollTo({ top: 0 });
      window.scrollTo(0, 0);
    }
  }, [pages, pageCount, chapterId]);

  /** Toggle fullscreen on the reader container. */
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void containerRef.current?.requestFullscreen();
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

  /* Resume decision: no saved page → start at the beginning immediately.
     When the chapter is fresh, also seed `pendingSaveRef` at page 0 and
     resolve resume at the same time. The unload flush (pagehide / unmount /
     chapter hop) needs a payload to send, and on a brand-new chapter the
     user can close the tab in <100ms — well before the save effect's 800ms
     debounce ever fires. Without this, the first read of a chapter leaves
     no row in `reading_progress` and the Continue button silently
     disappears after a restart. */
  useEffect(() => {
    if (!progress.isSuccess || !chapterPages.data) return;
    if (progress.data && (progress.data.page > 0 || progress.data.scrollFraction != null)) return;
    const data = chapterPages.data;
    // Saved mid-first-page in vertical mode (page 0 + fraction): restore the
    // exact relative spot silently. The ref is synced too so a persist that
    // fires before tracking catches up keeps the restored fraction.
    if (progress.data && progress.data.page === 0 && progress.data.scrollFraction != null) {
      const fraction = cleanFraction(progress.data.scrollFraction) ?? 0;
      const panX = progress.data.scrollX ?? 0;
      scrollFractionRef.current = fraction;
      setScrollFraction(fraction);
      scrollXRef.current = panX;
      setScrollX(panX);
      restoredFractionRef.current = fraction;
      verticalRef.current?.scrollToFraction(fraction, 'instant', panX);
      setResumeResolved(true);
      return;
    }
    if (!pendingSaveRef.current || pendingSaveRef.current.chapterId !== data.chapterId) {
      pendingSaveRef.current = {
        panelId: data.panelId,
        chapterId: data.chapterId,
        page: 0,
        scrollFraction: null,
        scrollX: null,
        panelTitle: data.panelTitle ?? undefined,
        coverUrl: data.coverUrl,
        chapterTitle: data.chapterTitle ?? undefined,
      };
    }
    setResumeResolved(true);
  }, [progress.isSuccess, progress.data, chapterPages.data]);

  /* Resume decision: the user scrolled past the saved position on their own —
     the prompt is moot, so dismiss it (and start persisting progress). */
  useEffect(() => {
    const savedPage = progress.data?.page ?? 0;
    const hasSavedPosition = savedPage > 0 || progress.data?.scrollFraction != null;
    if (!resumeResolved && hasSavedPosition && page >= savedPage) {
      setResumeResolved(true);
    }
  }, [page, resumeResolved, progress.data]);

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
      for (const img of preloaders) {
        img.src = '';
      }
    };
  }, [pages, chapterPages.data?.chapterId, settings.imageLoad, settings.dataSaver]);

  /**
   * Latest unsent progress payload. The save below fires instantly on page
   * change — this ref lets the unload flush send the freshest position even
   * when it never fired. Declared above the navigation callbacks so hops
   * can flush via beacon before the full reload.
   */
  const pendingSaveRef = useRef<SaveProgressInput | null>(null);

  /**
   * Session-only flush: persist the freshest page + chapter fraction refs so
   * a later remount in this tab restores the exact spot. SPA navigation away
   * fires no `pagehide`, so the unmount cleanup below must call this — the
   * throttled session write alone can lag the close spot (it starves under
   * continuous scrolling and is cancelled on unmount).
   */
  const flushSessionPage = useCallback(() => {
    stashPageMemory(
      chapterId,
      pageRef.current,
      readerModeRef.current === 'vertical' ? scrollFractionRef.current : undefined,
      readerModeRef.current === 'vertical' ? scrollXRef.current : undefined,
    );
  }, [chapterId]);

  /**
   * Best-effort flush of the progress save. Refreshes the payload from the
   * live position first, so an exit without a recent page turn (the norm on
   * ultra-tall single-page chapters) still persists the exact fraction — the
   * instant save below only fires on page changes. Guarded like the instant
   * save: never persist before the resume decision, and never against a
   * stale chapter id. Idempotent (nulls the ref after sending) so the save
   * effect, `pagehide`, unmount, and chapter hops can all call it without
   * double-sending. Beacon survives the document unload of a hard hop.
   */
  const flushProgress = useCallback(() => {
    const data = chapterPagesRef.current;
    if (data && resumeResolvedRef.current && resetChapterRef.current === data.chapterId) {
      const vertical = readerModeRef.current === 'vertical';
      const fraction = vertical ? cleanFraction(scrollFractionRef.current) : null;
      const x = vertical ? scrollXRef.current : null;
      pendingSaveRef.current = {
        panelId: data.panelId,
        chapterId: data.chapterId,
        page: pageRef.current,
        scrollFraction: fraction,
        scrollX: typeof x === 'number' && Number.isFinite(x) ? x : null,
        panelTitle: data.panelTitle ?? undefined,
        coverUrl: data.coverUrl,
        chapterTitle: data.chapterTitle ?? undefined,
      };
      if (fraction !== null) lastSavedFractionRef.current = fraction;
      lastSavedPageRef.current = pageRef.current;
    }
    const payload = pendingSaveRef.current;
    if (!payload) {
      return;
    }
    pendingSaveRef.current = null;
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
   * Hop to another chapter via a full document load — always refreshes,
   * whether the destination is cached or not. Unloading the document aborts
   * every in-flight image and payload request, so the abandoned chapter
   * stops caching immediately: hopping from a half-cached chapter back to a
   * cached one kills the half-cached chapter's pending downloads on the
   * spot. Progress is flushed via beacon first so the position survives the
   * unload. Paged-mode directed landings are stashed in sessionStorage
   * because in-memory refs don't survive the reload.
   */
  const hardHopToChapter = useCallback(
    (id: string, landing?: 'first' | 'last') => {
      if (landing) stashChapterLanding(id, landing);
      flushProgress();
      window.location.assign(`/read/${encodeURIComponent(id)}`);
    },
    [flushProgress],
  );

  /** Hop to an adjacent chapter. In paged mode the destination lands on a fixed
      page — the next chapter opens at its first page, the previous chapter at
      its last page. In vertical/gallery the exact position the user left off
      on is restored when they return (vertical keeps the intra-page spot). */
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
        // Remember the current position for this chapter so a later hop back restores it.
        stashPageMemory(
          chapterId,
          page,
          settings.mode === 'vertical' ? scrollFractionRef.current : undefined,
          settings.mode === 'vertical' ? scrollXRef.current : undefined,
        );
        hardHopToChapter(id);
      }
    },
    [chapterPages.data, chapterId, hardHopToChapter, page, toast, settings.mode],
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

  /* Jump to an arbitrary chapter picked from the settings dropdown (full refresh, like all hops). */
  const goToChapterById = useCallback(
    (id: string) => {
      if (id && id !== chapterId) hardHopToChapter(id);
    },
    [chapterId, hardHopToChapter],
  );

  /* Persist progress once the resume decision was made. Exits are covered
     by the explicit hop flush, the unmount flush below, and `pagehide`. */
  useEffect(() => {
    if (!resumeResolved || pageCount === 0 || !chapterPages.data) return;
    // Guard against a stale payload: never persist a page against a chapter
    // id it doesn't belong to (see `resetChapter`). The reset effect
    // re-renders with the correct values right after, and the save fires then.
    if (resetChapter !== chapterPages.data.chapterId) return;
    const data = chapterPages.data;
    // Vertical mode persists the overall chapter fraction alongside the page
    // so Continue restores the same relative content; other modes stay
    // page-granular. Read via ref (mirrored every render) so fraction updates
    // don't retrigger this effect — page turns carry the latest fraction,
    // intra-page scrolls are covered by the debounced save below, and exits
    // are covered by the flush above.
    const vertical = readerModeRef.current === 'vertical';
    const fraction = vertical ? cleanFraction(scrollFractionRef.current) : null;
    pendingSaveRef.current = {
      panelId: data.panelId,
      chapterId: data.chapterId,
      page,
      scrollFraction: fraction,
      scrollX: vertical ? scrollXRef.current : null,
      panelTitle: data.panelTitle ?? undefined,
      coverUrl: data.coverUrl,
      chapterTitle: data.chapterTitle ?? undefined,
    };
    if (fraction !== null) lastSavedFractionRef.current = fraction;
    lastSavedPageRef.current = page;
    // Instant save — no debounce.
    const payload = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (payload) saveProgress.mutate(payload);
    // oxlint-disable-next-line react/exhaustive-deps -- mutate is stable; we key on page
  }, [page, resumeResolved, pageCount, chapterPages.data, resetChapter]);

  /* Precise scroll-position save (vertical only): the fraction updates every
     scroll frame, so persist the latest position 800ms after scrolling
     pauses instead of only on page-boundary changes. Deduped by epsilon so
     tiny jitters don't spam the API; the exit flush covers closes
     mid-debounce. */
  useEffect(() => {
    if (settings.mode !== 'vertical') return;
    if (!resumeResolved || pageCount === 0 || !chapterPages.data) return;
    if (resetChapter !== chapterPages.data.chapterId) return;
    const data = chapterPages.data;
    const timer = window.setTimeout(() => {
      const fraction = cleanFraction(scrollFractionRef.current);
      if (fraction === null) return;
      const lastFraction = lastSavedFractionRef.current;
      const lastPage = lastSavedPageRef.current;
      const moved =
        lastFraction === null ||
        Math.abs(fraction - lastFraction) > 0.001 ||
        lastPage !== pageRef.current;
      if (!moved) return;
      const x = scrollXRef.current;
      const payload: SaveProgressInput = {
        panelId: data.panelId,
        chapterId: data.chapterId,
        page: pageRef.current,
        scrollFraction: fraction,
        scrollX: typeof x === 'number' && Number.isFinite(x) ? x : null,
        panelTitle: data.panelTitle ?? undefined,
        coverUrl: data.coverUrl,
        chapterTitle: data.chapterTitle ?? undefined,
      };
      lastSavedFractionRef.current = fraction;
      lastSavedPageRef.current = pageRef.current;
      setScrollX(payload.scrollX ?? 0);
      saveProgress.mutate(payload);
    }, 800);
    return () => window.clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-deps -- mutate is stable; we key on scrollFraction
  }, [scrollFraction, settings.mode, resumeResolved, pageCount, chapterPages.data, resetChapter]);

  /* Flush on the way out. React cleanups don't run when the tab itself
     closes, and `beforeunload` is unreliable on mobile — `pagehide`
     fires in both cases. Without this, closing the browser inside the
     debounce window silently drops the latest position (and for short
     reads, the ONLY position), so "Continue Reading" goes missing after
     a restart. The unmount cleanup below covers in-app navigation away
     from the reader. */
  useEffect(() => {
    // A refresh can land before React's write effects run, so persist the
    // freshest refs on unload too (in addition to the unmount flush below).
    window.addEventListener('pagehide', flushProgress);
    window.addEventListener('pagehide', flushSessionPage);
    return () => {
      window.removeEventListener('pagehide', flushProgress);
      window.removeEventListener('pagehide', flushSessionPage);
    };
  }, [flushProgress, flushSessionPage]);
  useEffect(() => () => {
    // SPA navigation away fires no pagehide — flush both stores from the
    // same live refs so session and server can't diverge.
    flushSessionPage();
    flushProgress();
  }, [flushProgress, flushSessionPage]);

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

      if (event.key === 'q' || event.key === 'Q') {
        setSettingsOpen((open) => !open);
        return;
      }
      if (event.key === 'f' || event.key === 'F') {
        // Rotate the reading mode: vertical -> paged -> gallery -> vertical.
        // Per-mode settings memory (T2-9) restores each mode's last values.
        event.preventDefault();
        switchMode(nextReadingMode(settings.mode));
        return;
      }
      if (event.key === 'e' || event.key === 'E') {
        // Toggle fullscreen — available in every reading mode.
        event.preventDefault();
        toggleFullscreen();
        return;
      }
      const intent = intentForKey(event.key, settings.direction, event.shiftKey, settings.mode, settings.smoothScrollKeys);
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
  }, [settings.direction, settings.mode, settings.imageGap, settings.keyPagesPress, settings.glidePreset, settings.smoothScrollKeys, page, goToPage, handleIntent, goToChapter, toggleFullscreen, panelId, navigate, update, switchMode, toast]);

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
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (isEditableKeyTarget(target)) return;
      const intent = intentForKey(event.key, settings.direction, event.shiftKey, settings.mode, settings.smoothScrollKeys);
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
      toolbar?.removeEventListener('pointermove', onToolbarMove);
      reader?.removeEventListener('pointermove', onContainerMove);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [settingsOpen, chapterPages.data, showPagesLoading, settings.direction, settings.mode, settings.smoothScrollKeys, autoScrollActive]);

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

    let last = performance.now();
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
   * double-firing on inertial events. While a zoomed page can still be panned
   * natively (the stage is scrollable and not at its edge in the wheel
   * direction), the wheel pans the zoomed page instead of turning.
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
          accumulated = 0; // let the browser pan the zoomed page
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
    const timer = window.setTimeout(() => prefetchChapterPages(nextId), 2_000);
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
    const savedPage = progress.data?.page ?? 0;
    const savedFraction = progress.data?.scrollFraction ?? null;
    // No banner if the user already finished the chapter (saved page is the
    // last one) — resuming there is pointless, and a 0/1-page chapter has
    // nothing to resume from either.
    const showResumeBanner =
      !resumeResolved &&
      (savedPage > 0 || savedFraction != null) &&
      pageCount > 1 &&
      savedPage < pageCount - 1;

    const currentChapter = chapters.data?.find((c) => c.id === data.chapterId);
    const sourceTitle = data.chapterTitle?.trim() ?? '';
    const isGeneric = /^chapter\s+\d+(\.\d+)?\s*$/i.test(sourceTitle);
    const enhancedChapterTitle = currentChapter?.title ?? (isGeneric ? '' : data.chapterTitle);

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
            settings={settings}
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

        {showResumeBanner && (
          <div className="reader-resume" role="dialog" aria-label="Resume reading">
            <p>
              Continue from page <strong>{savedPage + 1}</strong>?
            </p>
            <div className="reader-resume__actions">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => {
                  setResumeResolved(true);
                  // In vertical mode the saved chapter fraction restores the
                  // same relative content; other modes jump to the page top.
                  const fraction = cleanFraction(progress.data?.scrollFraction);
                  const panX = progress.data?.scrollX ?? 0;
                  if (settings.mode === 'vertical' && fraction !== null) {
                    setPage(savedPage);
                    scrollFractionRef.current = fraction;
                    setScrollFraction(fraction);
                    scrollXRef.current = panX;
                    setScrollX(panX);
                    restoredFractionRef.current = fraction;
                    verticalRef.current?.scrollToFraction(fraction, 'instant', panX);
                  } else {
                    goToPage(savedPage, 'instant');
                  }
                }}
              >
                Continue
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setResumeResolved(true);
                  goToPage(0, 'instant');
                }}
              >
                Start over
              </button>
            </div>
          </div>
        )}

        <main
          className={`reader-content${settings.showScrollbar ? ' reader-content--scrollbar-visible' : ''}`}
          tabIndex={-1}
          style={{ '--page-brightness': `${settings.imageBrightness}%` } as CSSProperties}
        >
          {settings.mode === 'vertical' ? (
            <VerticalReader
              ref={verticalRef}
              pages={pages}
              imageWidth={settings.imageWidth}
              imageWidthPx={settings.imageWidthPx}
              imageHeightPx={settings.imageHeightPx}
              imageGap={settings.imageGap}
              direction={settings.direction}
              eagerPages={settings.imageLoad === 'parallel' && !settings.dataSaver}
              preloadAhead={settings.dataSaver ? 1 : settings.preloadAhead}
              zoom={settings.zoomLevel}
              onZoomChange={(z) => update({ zoomLevel: z })}
              onPageChange={setPage}
              onProgress={(p, ratio) => {
                setPage(p);
                setScrollRatio(ratio);
              }}
              onScrollFraction={(fraction, x) => {
                scrollFractionRef.current = fraction;
                setScrollFraction(fraction);
                if (typeof x === 'number' && Number.isFinite(x)) {
                  scrollXRef.current = x;
                }
              }}
              onChapterNavigate={goToChapter}
              chapterTag={chapterId}
              /* Preserve the reading position across mode switches: the
                 parent keeps `page` while the newly mounted reader starts
                 at scrollTop 0 — it jumps back here before tracking.
                 `initialFraction` restores the same relative content (soft
                 refresh or mode switch) instead of the chapter top, and
                 `initialScrollX` restores the exact horizontal pan. */
              initialPage={page}
              initialFraction={scrollFraction}
              initialScrollX={scrollX}
            />
          ) : settings.mode === 'gallery' ? (
            <GalleryReader
              ref={galleryRef}
              pages={pages}
              imageWidth={settings.imageWidth}
              imageWidthPx={settings.imageWidthPx}
              imageHeightPx={settings.imageHeightPx}
              imageGap={settings.imageGap}
              direction={settings.direction}
              zoom={settings.zoomLevel}
              onZoomChange={(z) => update({ zoomLevel: z })}
              onPageChange={setPage}
              onProgress={(p, ratio) => {
                setPage(p);
                setScrollRatio(ratio);
              }}
              onChapterNavigate={goToChapter}
              chapterTag={chapterId}
              /* Preserve the reading position across mode switches (see above). */
              initialPage={page}
            />
          ) : (
            <PagedReader
              pages={pages}
              page={page}
              direction={settings.direction}
              doublePage={settings.doublePage}
              spreadOddPolicy={settings.spreadOddPolicy}
              autoLandscapeSingle={settings.autoLandscapeSingle}
              zoom={settings.zoomLevel}
              onZoomChange={(z) => update({ zoomLevel: z })}
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
            />
          )}
        </main>

        {/* Bottom bar: progress + mobile-friendly page buttons */}
        <footer
          className={`reader-footer${settings.showProgressBar ? '' : ' reader-footer--hidden'}`}
        >
          {settings.mode === 'paged' && (
            <button
              type="button"
              className="reader-toolbar__btn"
              onClick={() => handleIntent('backward')}
              aria-label="Previous page"
            >
              ‹
            </button>
          )}
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
          {settings.mode === 'paged' && (
            <button
              type="button"
              className="reader-toolbar__btn"
              onClick={() => handleIntent('forward')}
              aria-label="Next page"
            >
              ›
            </button>
          )}
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
