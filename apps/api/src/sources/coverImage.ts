import type { HTMLElement } from 'node-html-parser';

/**
 * Pick the best cover-image URL from a lazy-loaded `<img>` (or any element).
 *
 * Tries, in order:
 *   1. `data-original`, `data-src`, `data-lazy-src`, `data-lazy`
 *   2. `src` (placeholder values rejected)
 *   3. `srcset` / `data-srcset` — first candidate
 *   4. `<picture>` sibling `<source>` `srcset` — first candidate
 *   5. `style` / `data-bg` `background-image: url(...)` (or a bare URL in `data-bg`)
 *
 * Placeholder `src` values (`data:image/...`, `blank.gif`, `lazyload`)
 * are skipped so a later fallback (e.g. `og:image`) can win instead.
 * Returned values are trimmed but otherwise untouched — callers resolve
 * them against the base URL themselves.
 */
export function pickCoverSrc(el: HTMLElement | null | undefined): string | null {
  if (!el) return null;

  for (const attr of ['data-original', 'data-src', 'data-lazy-src', 'data-lazy']) {
    const value = el.getAttribute(attr)?.trim();
    if (value && !isPlaceholder(value)) return value;
  }

  const src = el.getAttribute('src')?.trim();
  if (src && !isPlaceholder(src)) return valueOrNull(src);

  for (const attr of ['srcset', 'data-srcset']) {
    const first = firstSrcsetCandidate(el.getAttribute(attr));
    if (first && !isPlaceholder(first)) return first;
  }

  for (const source of pictureSources(el)) {
    for (const attr of ['srcset', 'data-srcset']) {
      const first = firstSrcsetCandidate(source.getAttribute(attr));
      if (first && !isPlaceholder(first)) return first;
    }
  }

  return pickBackgroundUrl(el);
}

/** `data:image/...`, `blank.gif`, `lazyload` placeholders (case-insensitive). */
function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.startsWith('data:image/') || lower.includes('blank.gif') || lower.includes('lazyload')
  );
}

function valueOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** First URL of a `srcset` list (`"a.jpg 1x, b.jpg 2x"` → `"a.jpg"`). */
function firstSrcsetCandidate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const first = raw.split(',')[0]?.trim().split(/\s+/)[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/** `<source>` elements of the enclosing `<picture>`, if `el` sits in one. */
function pictureSources(el: HTMLElement): HTMLElement[] {
  if (el.tagName?.toUpperCase() === 'SOURCE') return [el];
  const parent = el.parentNode as HTMLElement | null | undefined;
  if (!parent || parent.tagName?.toUpperCase() !== 'PICTURE') return [];
  return parent.querySelectorAll('source[srcset], source[data-srcset]');
}

/**
 * `background-image: url('...')` from `style`, or a bare URL / `url(...)`
 * from `data-bg`.
 */
function pickBackgroundUrl(el: HTMLElement): string | null {
  const fromStyle = bgUrlFromCss(el.getAttribute('style'));
  if (fromStyle) return fromStyle;

  const dataBg = el.getAttribute('data-bg')?.trim();
  if (!dataBg || isPlaceholder(dataBg)) return null;
  return bgUrlFromCss(dataBg) ?? dataBg;
}

/** Extract the URL inside a CSS `url(...)` value. */
function bgUrlFromCss(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const match = /background-image\s*:\s*url\(\s*['"]?([^)'"]+)/i.exec(raw);
  const url = match?.[1]?.split(/['"]/)[0]?.trim();
  if (url && !isPlaceholder(url)) return url;
  return null;
}
