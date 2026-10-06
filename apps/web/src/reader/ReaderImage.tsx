import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { PanelPage } from '@panel/shared';
import { proxiedPageUrl } from '../utils/format';
import { getCachedAspectRatio, getCachedDimensions, setCachedDimensions } from './dimensions';

/**
 * Reserved box for pages whose real dimensions are unknown (some sources
 * don't report them). Without a reserve every wrapper collapses to ~0px
 * tall, so ALL pages sit "near" the viewport and native lazy loading fetches
 * the whole chapter even in sequential mode.
 *
 * Tall default: unmeasured pages in the wild are ~900x6000 (ratio ~0.15),
 * so a 2/3 portrait box reserves ~4x too little height and every load shifts
 * the pages below it (CLS). 3/20 matches the observed average; repeat visits
 * do better still via the measured-dimension cache below.
 */
const FALLBACK_ASPECT_RATIO = '3 / 20';

/** Number of automatic retries before surfacing the manual reload control. */
const MAX_AUTO_RETRIES = 5;
/** Base delay (ms) between auto-retries, scaled up on each attempt. */
const RETRY_DELAY_MS = 1200;

/** Append a unique query param so a reload bypasses the browser's cache. */
function withCacheBuster(url: string, stamp: number): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}_retry=${stamp}`;
}

/**
 * One panel page image with:
 *  - reserved aspect-ratio box (no layout jump while loading)
 *  - loading shimmer
 *  - automatic retry + manual reload when the image fails to load
 *  - no-referrer policy (the CDN serves images without a referer)
 */
export function ReaderImage({
  page,
  eager = false,
  widthPx,
  heightPx,
  /** Zoom multiplier (T2-1). 1.0 = fit to stage; > 1.0 magnifies. */
  zoom = 1,
  /** Where to anchor the zoom (0..1 of the box). Default is the center. */
  transformOrigin = 'center center',
  /** Chapter global id (e.g. `mk:solo-leveling.21708~c200`), used as the
   *  cache provenance tag so chapter pages can be cleared selectively. */
  chapterTag = null,
  onLoad,
  onError,
}: {
  page: PanelPage;
  eager?: boolean;
  /** User-set fixed width in px; `null`/`undefined` uses the auto layout preset. */
  widthPx?: number | null;
  /** User-set fixed height in px; `null`/`undefined` uses the auto layout preset. */
  heightPx?: number | null;
  /** Zoom multiplier (T2-1). 1.0 = fit to stage; > 1.0 magnifies. */
  zoom?: number;
  /** CSS `transform-origin` for the zoom, e.g. "center center" or "50% 50%". */
  transformOrigin?: string;
  /** Chapter global id used as the cache provenance tag. */
  chapterTag?: string | null;
  /**
   * Called when the image is displayed. Carries the page so a consumer can
   * pair it with `onError` (a page that recovers after a manual Reload stops
   * counting as failed).
   */
  onLoad?: (page: PanelPage) => void;
  /**
   * Called once per page when the image gives up: the auto-retry budget is
   * exhausted and the error box is about to render. NOT called per retry
   * attempt — consumers use it to count terminally-failed pages.
   */
  onError?: (page: PanelPage) => void;
}) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [retryKey, setRetryKey] = useState(0);
  const [measuredRatio, setMeasuredRatio] = useState<string | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const imgRef = useRef<HTMLImageElement>(null);
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const cachedRatio = useMemo(() => getCachedAspectRatio(page.url), [page.url]);
  const cachedDims = useMemo(() => getCachedDimensions(page.url), [page.url]);

  const aspectRatio = page.width && page.height
    ? `${page.width} / ${page.height}`
    : measuredRatio ?? cachedRatio ?? FALLBACK_ASPECT_RATIO;

  /** Numeric dims for the <img> width/height attrs (unsized-image CLS fix).
   *  Prefer source dims, fall back to dims measured on a previous visit. */
  const resolvedDims =
    page.width && page.height ? { width: page.width, height: page.height } : cachedDims;

  const hasWidth = typeof widthPx === 'number';
  const hasHeight = typeof heightPx === 'number';

  /* A user-set pixel width and/or height overrides the auto layout preset. When only
     one dimension is set, the combined aspect-ratio keeps the other proportional (no
     distortion); when both are set the image is contained inside the pixel box. Capped
     at the container so a too-large value never causes overflow. */
  const style: CSSProperties = {
    marginLeft: 'auto',
    marginRight: 'auto',
    aspectRatio,
    /* reader.css sets `content-visibility: auto` on .reader-image, and skipped
       (offscreen) subtrees defer fetching their images until near the viewport.
       That silently defeats the sequential-mode preload-ahead preset: the src
       is set early but the browser won't start the request. Pages chosen for
       preload (eager) must opt out so the fetch actually begins ahead of time. */
    ...(eager ? { contentVisibility: 'visible' } : {}),
    ...(hasWidth ? { width: `${widthPx}px`, maxWidth: '100%' } : {}),
    ...(hasHeight ? { height: `${heightPx}px`, maxHeight: '100%' } : {}),
    ...(!hasWidth && hasHeight ? { width: 'auto' } : {}),
    /* Pinch-to-zoom (T2-1): scale the image beyond its "fit" box. The parent
       sets transformOrigin to the pinch point so the zoom feels anchored. */
    ...(zoom !== 1 ? { transform: `scale(${zoom})`, transformOrigin } : {}),
  };

  /* When both dimensions are user-set the wrappper box shape may not match the image,
     so draw the image to fill the box without stretching (contain). */
  const imgStyle =
    hasWidth && hasHeight
      ? { width: '100%', height: '100%', objectFit: 'contain' as const }
      : undefined;

/* Clear any pending timers when the component unmounts. */
  useEffect(() => {
    return () => {
      window.clearTimeout(timerRef.current);
    };
  }, []);

const isLoaded = status === 'loaded';

  const targetSrc = useMemo(() => {
    const base = proxiedPageUrl(page, chapterTag);
    return retryKey > 0 ? withCacheBuster(base, Date.now() + retryKey) : base;
  }, [page, chapterTag, retryKey]);

  /* Sequential mode: hold the real src back until the page is within one
     viewport of the screen, then fetch. Native `loading="lazy"` has no
     configurable margin and its default reach (2-3 screens on fast
     connections) downloads far more than needed. */
  const wrapRef = useRef<HTMLDivElement>(null);
  const [inRange, setInRange] = useState(false);

  /* Chapter hops (and page swaps) must never paint the previous image while
     the new one downloads: a reused instance would otherwise keep
     `status === 'loaded'` and the old `<img>` bitmap until the new `src`
     fires `onLoad`. Reset to a blank shimmer box on every new page, and
     re-arm the retry budget for the fresh URL. The chapter-scoped `key`
     in the readers already forces a remount in the common case — this
     covers any path where the instance is reused. */
  useEffect(() => {
    window.clearTimeout(timerRef.current);
    setStatus('loading');
    setAttempt(0);
    setRetryKey(0);
    setMeasuredRatio(null);
    setInRange(false);
  }, [page.url, page.index, chapterTag]);

  useEffect(() => {
    if (eager || inRange) return;
    const el = wrapRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInRange(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInRange(true);
          observer.disconnect();
        }
      },
      // 100% viewport height ahead/behind ≈ "one screen away".
      { rootMargin: '100% 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [eager, inRange]);

  const src = eager || inRange ? targetSrc : undefined;

  /* Disk-cached images load synchronously and fire `load` before React's
     synthetic event listener is attached — the event is lost and the page
     stays invisible. Check `img.complete` after mount and recover. */
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !img.complete) return;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setMeasuredRatio(`${img.naturalWidth} / ${img.naturalHeight}`);
      setCachedDimensions(page.url, img.naturalWidth, img.naturalHeight);
    }
    // Report outside the state updater: updaters must stay pure (StrictMode
    // invokes them twice, which would fire the load report twice).
    if (status !== 'loaded') {
      setStatus('loaded');
      onLoadRef.current?.(page);
    }
    // `src` is the trigger (a new URL may have resolved from cache without
    // firing `load`); `status`/`page` are read, not triggers — the
    // `status !== 'loaded'` guard makes a re-run a no-op, and the img is
    // unmounted while status is 'error' so the null check bails first.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const reload = useCallback(() => {
    window.clearTimeout(timerRef.current);
    setStatus('loading');
    setAttempt((a) => a + 1);
    setRetryKey((k) => k + 1);
  }, []);

  const handleError = useCallback(() => {
    if (attempt < MAX_AUTO_RETRIES) {
      // Transient failure (CDN hiccup / throttling) — try again shortly.
      timerRef.current = window.setTimeout(reload, RETRY_DELAY_MS * (attempt + 1));
    } else {
      setStatus('error');
    }
  }, [attempt, reload]);

  /* Report the terminal failure upward. Driven by `status` rather than by
     `handleError` so it fires exactly once per give-up, including a manual
     Reload that fails again (status cycles error -> loading -> error). The
     reader counts these to detect a fully-unreadable chapter; a page that
     later recovers is dropped from that count by its own load report. */
  useEffect(() => {
    if (status !== 'error') return;
    onErrorRef.current?.(page);
  }, [status, page]);

  return (
    <div ref={wrapRef} className="reader-image" style={style}>
      {status === 'error' ? (
        /* Swallow clicks: tapping the error box must do nothing (no chapter
           hop, no page turn). The readers navigate on container clicks and
           their tap zones sit under this box — without this, a tap on the
           error background bubbles up and changes chapters. The Reload
           button stops propagation explicitly below so it always retries. */
        <div
          className="reader-image__error"
          role="alert"
          onClick={(event) => event.stopPropagation()}
        >
          <p>Page {page.index + 1} failed to load.</p>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={(event) => {
              event.stopPropagation();
              reload();
            }}
          >
            Reload
          </button>
        </div>
      ) : (
        <>
          <img
            key={`${chapterTag ?? ''}:${page.index}:${retryKey}`}
            src={src}
            alt={`Page ${page.index + 1}`}
            decoding="async"
            loading={eager ? 'eager' : 'lazy'}
            fetchPriority={eager ? 'high' : 'low'}
            width={resolvedDims?.width}
            height={resolvedDims?.height}
            referrerPolicy="no-referrer"
            style={imgStyle}
            className={`reader-image__img${isLoaded ? ' reader-image__img--loaded' : ''}`}
            ref={(el) => { imgRef.current = el; }}
            onLoad={(e) => {
              const el = e.currentTarget;
              if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                setMeasuredRatio(`${el.naturalWidth} / ${el.naturalHeight}`);
                setCachedDimensions(page.url, el.naturalWidth, el.naturalHeight);
              }
              setStatus('loaded');
              onLoadRef.current?.(page);
            }}
            onError={handleError}
          />
        </>
      )}
    </div>
  );
}
