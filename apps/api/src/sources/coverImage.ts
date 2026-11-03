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
    const largest = largestSrcsetCandidate(el.getAttribute(attr));
    if (largest && !isPlaceholder(largest)) return stripWordPressSizeSuffix(largest);
  }

  for (const source of pictureSources(el)) {
    for (const attr of ['srcset', 'data-srcset']) {
      const largest = largestSrcsetCandidate(source.getAttribute(attr));
      if (largest && !isPlaceholder(largest)) return stripWordPressSizeSuffix(largest);
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

/**
 * Largest URL of a `srcset` list by width (`350w`) or density (`2x`)
 * descriptor, falling back to the last candidate when no descriptor parses.
 * Madara thumbs list ascending sizes (`110w, 175w, 350w`) — the first entry
 * is a 110px thumbnail that blurs when upscaled to card size, so cover
 * extraction must prefer the largest, not the first.
 */
export function largestSrcsetCandidate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let bestUrl: string | null = null;
  let bestScore = -1;
  let lastUrl: string | null = null;
  for (const part of raw.split(',')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const url = tokens[0]?.trim();
    if (!url) continue;
    lastUrl = url;
    const descriptor = tokens[1]?.trim().toLowerCase() ?? '';
    let score = -1;
    if (descriptor.endsWith('w')) {
      const width = Number.parseInt(descriptor.slice(0, -1), 10);
      if (Number.isFinite(width)) score = width;
    } else if (descriptor.endsWith('x')) {
      const density = Number.parseFloat(descriptor.slice(0, -1));
      // Scale densities into the width range so `2x` beats `1x` but a real
      // width (e.g. `350w`) still wins when both styles mix.
      if (Number.isFinite(density)) score = density * 1000;
    }
    if (score > bestScore) {
      bestScore = score;
      bestUrl = url;
    }
  }
  return bestUrl ?? lastUrl;
}

/**
 * Strip a WordPress thumbnail size suffix (`-110x150`, `-193x278`,
 * `-350x476`) before the file extension to recover the full-size original
 * (`Read-Manga-4-110x150.jpg` → `Read-Manga-4.jpg`). Query strings and
 * hashes are preserved; non-matching URLs pass through untouched.
 */
export function stripWordPressSizeSuffix(url: string): string {
  return url.replace(/-\d+x\d+(?=\.[A-Za-z0-9]+(?:[?#]|$))/, '');
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
