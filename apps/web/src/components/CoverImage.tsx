import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { getProxiedImageUrl } from '../utils/format';

/** Silent automatic retries before giving up and showing the initials fallback. */
const MAX_AUTO_RETRIES = 4;
/** Base backoff delay (ms) between retries, scaled up on each attempt. */
const BASE_DELAY_MS = 900;
/** Random spread (ms) added to each backoff step so a CDN hiccup doesn't
 *  refire every cover on a grid in lockstep. */
const JITTER_MS = 400;
/** Last-chance background re-attempt after exhaustion (a cold-cache
 *  stampede can 429 every attempt in the first window; upstream usually
 *  recovers within seconds, so one delayed try heals without a reload). */
const LAST_CHANCE_DELAY_MS = 30_000;

/** Append a unique query param so each retry bypasses the browser's cache. */
function withCacheBuster(url: string, stamp: number): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}_retry=${stamp}`;
}

/** Skeleton wash shown while the cover loads (no initials until retries exhaust). */
const SHIMMER_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'linear-gradient(135deg, var(--surface-2), var(--surface-3))',
};

/**
 * Cover image with silent background retry, modelled on `ReaderImage`:
 *  - shimmer/skeleton while loading (no initials)
 *  - automatic retry with backoff + `_retry` cache-buster on error
 *  - title-initials fallback only after all retries are exhausted, plus
 *    one last-chance attempt 30s later (cold-cache stampedes can fail
 *    every try in the first window); tapping the fallback retries again
 *
 * The parent must reserve the box (`position: relative` + `aspect-ratio`,
 * which all cover wrappers already do). The `<img>` itself is left
 * statically positioned so each caller's own CSS (`panel-card__cover img`,
 * `bookmark-card__cover img`, `panel-details__cover .cover-image`) keeps
 * controlling size/position; only its opacity is toggled inline so a
 * failed attempt never flashes a broken-image icon.
 */
export function CoverImage({
  source,
  coverUrl,
  panelId,
  title,
  eager = false,
  className,
  imgClassName,
  fallbackClassName,
}: {
  /** Source id (e.g. `mk`), forwarded to the image proxy. */
  source: string;
  /** Upstream cover URL (may be null when the source reports none). */
  coverUrl: string | null;
  /** Panel global id, used as the cache provenance tag. */
  panelId: string | null;
  /** Panel title — used for the alt text and the initials fallback. */
  title: string;
  /** Use eager loading (hero covers); defaults to lazy. */
  eager?: boolean;
  /** Extra class for the loading shimmer. */
  className?: string;
  /** Extra class for the `<img>` (e.g. `cover-image` on the details hero). */
  imgClassName?: string;
  /** Class for the exhausted initials fallback. */
  fallbackClassName?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [retryKey, setRetryKey] = useState(0);
  const timerRef = useRef<number | undefined>(undefined);
  const lastChanceUsedRef = useRef(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const baseUrl = useMemo(
    () => getProxiedImageUrl(source, coverUrl, 'cover', panelId),
    [source, coverUrl, panelId],
  );

  /* Fresh cover: drop any pending retry timer from the previous URL and
     start over in the loading state. */
  useEffect(() => {
    window.clearTimeout(timerRef.current);
    lastChanceUsedRef.current = false;
    setLoaded(false);
    setExhausted(false);
    setAttempt(0);
    setRetryKey(0);
  }, [baseUrl]);

  /* Clear any pending retry timer when the component unmounts. */
  useEffect(() => {
    return () => {
      window.clearTimeout(timerRef.current);
    };
  }, []);

  const src = useMemo(
    () =>
      baseUrl && retryKey > 0
        ? withCacheBuster(baseUrl, Date.now() + retryKey)
        : baseUrl,
    [baseUrl, retryKey],
  );

  const retry = useCallback(() => {
    window.clearTimeout(timerRef.current);
    setExhausted(false);
    setLoaded(false);
    setAttempt((a) => a + 1);
    setRetryKey((k) => k + 1);
  }, []);

  const handleError = useCallback(() => {
    if (attempt < MAX_AUTO_RETRIES) {
      // Transient failure (CDN hiccup / throttling) — try again shortly,
      // waiting longer on each attempt. `key={retryKey}` remounts the
      // <img> so the new (cache-busted) src actually refires.
      timerRef.current = window.setTimeout(
        retry,
        BASE_DELAY_MS * (attempt + 1) + Math.random() * JITTER_MS,
      );
    } else if (!lastChanceUsedRef.current) {
      // Give up for now, but schedule one last-chance attempt: a full-grid
      // cold-cache stampede can fail every try inside the first window.
      lastChanceUsedRef.current = true;
      setExhausted(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(retry, LAST_CHANCE_DELAY_MS);
    } else {
      setExhausted(true);
    }
  }, [attempt, retry]);

  // If the cover was already in the browser cache before React attached
  // onLoad, the load event never fires and the image would stay hidden.
  // Detect that case and reveal it.
  useEffect(() => {
    if (src) {
      const img = imgRef.current;
      if (img && img.complete && img.naturalWidth > 0) {
        setLoaded(true);
      }
    }
  }, [src]);

  // Manual escape hatch: tapping the initials retries the full cycle
  // (resets the last-chance flag too). Silent otherwise.
  const retryFromExhausted = useCallback(() => {
    window.clearTimeout(timerRef.current);
    lastChanceUsedRef.current = false;
    setExhausted(false);
    setLoaded(false);
    setAttempt(0);
    setRetryKey((k) => k + 1);
  }, []);

  const fallback = (
    <button
      type="button"
      className={fallbackClassName ?? 'panel-card__cover-fallback'}
      onClick={retryFromExhausted}
      title={`Retry loading cover of ${title}`}
      aria-label={`Retry loading cover of ${title}`}
      style={{ cursor: 'pointer', border: 0, padding: 0, font: 'inherit', width: '100%', height: '100%' }}
    >
      {title.slice(0, 2).toUpperCase()}
    </button>
  );

  if (!src) return fallback;

  return (
    <>
      {!exhausted && (
        <img
          key={retryKey}
          ref={imgRef}
          src={src}
          alt={`Cover of ${title}`}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          className={imgClassName}
          style={{ opacity: loaded ? 1 : 0 }}
          onLoad={() => setLoaded(true)}
          onError={handleError}
        />
      )}
      {!loaded && !exhausted && (
        <div
          className={className}
          style={SHIMMER_STYLE}
          aria-hidden="true"
        />
      )}
      {exhausted && fallback}
    </>
  );
}
