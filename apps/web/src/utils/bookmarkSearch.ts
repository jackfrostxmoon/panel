import type { Bookmark } from '@panel/shared';

/**
 * Case-insensitive local search over a bookmark's cached metadata.
 *
 * The bookmarks shelf has a single filter box (no Title/Author/Artist
 * selector): it matches the primary title, every alternative title, and
 * every cached author/artist name at once. Credits only exist for panels
 * whose detail page has been cached, which mirrors the search page's
 * cached-credit fallback.
 *
 * An empty/whitespace query matches everything, so the same predicate can
 * stay in the filter chain unconditionally.
 */
export function bookmarkMatchesQuery(bookmark: Bookmark, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const fields = [
    bookmark.title,
    ...(bookmark.altTitles ?? []),
    ...(bookmark.authors ?? []),
    ...(bookmark.artists ?? []),
  ];
  return fields.some((field) => field.toLowerCase().includes(needle));
}
