import type { SourceSearchResult } from '@panel/shared';

/**
 * OR-union of per-genre listing fetches, for sites whose archives filter a
 * single genre: one fetch per include genre, merged with dedupe by id
 * (first-seen wins) and `hasMore` true when any page has more. Failed
 * fetches are skipped (a failing genre must not break the others).
 *
 * Federated paging is approximate by nature — page N of the union is built
 * from page N of each archive, so later pages can repeat or miss items —
 * but no wrong items can appear: every contributor was already filtered
 * to its genre server-side.
 */
export function unionSearchResults(
  settled: PromiseSettledResult<SourceSearchResult>[],
  page: number,
): SourceSearchResult {
  const seen = new Set<string>();
  const results: SourceSearchResult['results'] = [];
  let hasMore = false;
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    hasMore = hasMore || result.value.hasMore;
    for (const item of result.value.results) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      results.push(item);
    }
  }
  return { results, page, hasMore };
}
