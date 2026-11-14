import type { Bookmark, SourceSearchResult } from '@panel/shared';

/**
 * Sort bookmarks so freshly-released chapters bubble a panel to the top.
 * Prefers the source's `publishedAt` for the latest chapter so that merely
 * opening a detail page (which re-caches chapters and rewrites `cachedAt`)
 * does NOT reorder the shelf. Falls back to `cachedAt`, then `updatedAt`.
 */
export function sortBookmarks(bookmarks: Bookmark[]): Bookmark[] {
  return [...bookmarks].sort((a, b) => {
    const aKey = a.latestChapterPublishedAt ?? a.latestChapterCachedAt ?? a.updatedAt;
    const bKey = b.latestChapterPublishedAt ?? b.latestChapterCachedAt ?? b.updatedAt;
    return bKey.localeCompare(aKey);
  });
}

/**
 * Sort bookmarks by when they were added, newest first. Used when the user
 * turns off "Sort by latest update" — chapter-cache timestamps are ignored
 * entirely.
 */
export function sortByCreatedAt(bookmarks: Bookmark[]): Bookmark[] {
  return [...bookmarks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Reorder `bookmarks` to match a source's latest-updates feed (pages in order).
 *
 * Titles present in the feed come first, in feed position; everything else
 * keeps the legacy recency sort (`sortBookmarks`) behind them. The feed is
 * the source site's own "recently updated" list, so the order mirrors what
 * the site shows. Matching is by global panel id; ids repeated across
 * pages keep their earliest (best) position.
 *
 * Pure: callers pass the raw pages they fetched (any may be undefined —
 * failed or still-loading pages are simply skipped). An empty feed degrades
 * to `sortBookmarks`.
 */
export function rankByLatestFeed(
  bookmarks: Bookmark[],
  pages: readonly (SourceSearchResult | undefined)[],
): Bookmark[] {
  const rank = new Map<string, number>();
  let position = 0;
  for (const page of pages) {
    for (const item of page?.results ?? []) {
      if (rank.has(item.id)) continue;
      rank.set(item.id, position);
      position += 1;
    }
  }
  if (rank.size === 0) return sortBookmarks(bookmarks);
  const matched: Bookmark[] = [];
  const rest: Bookmark[] = [];
  for (const bookmark of bookmarks) {
    if (rank.has(bookmark.panelId)) matched.push(bookmark);
    else rest.push(bookmark);
  }
  matched.sort((a, b) => rank.get(a.panelId)! - rank.get(b.panelId)!);
  return [...matched, ...sortBookmarks(rest)];
}
