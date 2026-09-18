import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { PanelPage } from '@panel/shared';
import { proxiedPageUrl } from '../utils/format';

/**
 * Reserved box for pages whose real dimensions are unknown (some sources
 * don't report them). Without this every wrapper collapses to ~0px tall, so
 * ALL pages sit "near" the viewport and native lazy loading fetches the
 * whole chapter even in sequential mode.
 */
const FALLBACK_ASPECT_RATIO = '2 / 3';

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
  onLoad?: () => void;
}) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [retryKey, setRetryKey] = useState(0);
  const [measuredRatio, setMeasuredRatio] = useState<string | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  const aspectRatio = page.width && page.height
    ? `${page.width} / ${page.height}`
    : measuredRatio ?? FALLBACK_ASPECT_RATIO;

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

  return (
    <div ref={wrapRef} className="reader-image" style={style}>
      {status === 'error' ? (
        <div className="reader-image__error" role="alert">
          <p>Page {page.index + 1} failed to load.</p>
          <button type="button" className="btn btn--ghost btn--sm" onClick={reload}>
            Reload
          </button>
        </div>
      ) : (
        <>
          <img
            key={retryKey}
            src={src}
            alt={`Page ${page.index + 1}`}
            decoding="async"
            referrerPolicy="no-referrer"
            style={imgStyle}
            className={`reader-image__img${isLoaded ? ' reader-image__img--loaded' : ''}`}
            onLoad={(e) => {
              const el = e.currentTarget;
              if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                setMeasuredRatio(`${el.naturalWidth} / ${el.naturalHeight}`);
              }
              setStatus('loaded');
              onLoad?.();
            }}
            onError={handleError}
          />
        </>
      )}
    </div>
  );
}
