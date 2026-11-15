/**
 * Cover-image guard — the one place that decides "this URL is a chapter
 * page, never a valid cover".
 *
 * Historical context: the legacy `manga_viewer_export.sql` import wrote the
 * *first chapter page* into `panel.cover_url` for a handful of rows (e.g.
 * `https://<cdn>/storage/chapters/<chapter-id>/001.webp` on RoliaScan). The
 * value is a perfectly valid image — which is why none of the existing
 * retry/backoff machinery ever noticed — but a watermarked reader page is
 * not a poster. This guard exists so that fact can never reach a user again:
 *
 *   - persistence refuses to write chapter-like covers (upsertPanel /
 *     upsertList drop them to null),
 *   - every API payload that carries a cover sanitizes it (safeCoverUrl),
 *   - `PanelService.getPanel` self-heals a stale bad row by refetching the
 *     poster from the source on the spot.
 *
 * The rule is deliberately narrow: it flags URLs whose *path* contains a
 * chapter-content segment. It never looks at filenames, query strings or
 * hosts, so a legitimate poster such as `manga-123-cover.jpg` (or a
 * `…/cover/…` path containing the word "chapter" in a title slug) is never
 * touched. If a source ever starts serving posters under a segment like
 * `/chapters/`, this list is the one place to revisit — not the code paths.
 */

/** Path segments that mean "this file lives inside a chapter". */
const CHAPTER_PATH = /(^|\/)(storage\/chapters|chapter|chapters)(\/|$)/i;

/**
 * True when `url` points at an image stored inside a chapter (a page, a
 * scanlation bundle, an in-chapter asset) — never a valid poster/cover.
 * Falsy input returns false (the absence of a cover is its own case).
 */
export function isChapterImageLikeCover(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    // parse failures are not this rule's job to reject — leave them to the
    // callers' own shape handling instead of hiding them here.
    return CHAPTER_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Cover URL for API payloads: the URL unchanged when it is a plausible
 * poster, otherwise `null` (the web renders the initials fallback for null
 * covers, which is always preferable to showing a chapter page).
 */
export function safeCoverUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return isChapterImageLikeCover(url) ? null : url;
}

/**
 * Pick the cover for a persistence write. Incoming chapter-like covers are
 * never written: fall back to the stored value when that is a plausible
 * poster, otherwise `null`. A missing/empty incoming value behaves as
 * before (keep the stored cover when present).
 */
export function pickStoredCoverUrl(
  incoming: string | null | undefined,
  existing: string | null | undefined,
): string | null {
  const next = incoming?.trim() ? incoming : undefined;
  if (next && !isChapterImageLikeCover(next)) return next;
  if (existing && !isChapterImageLikeCover(existing)) return existing;
  return null;
}
