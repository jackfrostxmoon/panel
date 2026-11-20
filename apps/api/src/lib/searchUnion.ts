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

/**
 * AND-intersection of per-genre listing fetches, for sites whose archives
 * filter a single genre: one fetch per include genre, then only titles
 * present in EVERY fetched page are kept (dedupe by id, first-seen order).
 *
 * This is the only accurate server-side AND for sites whose cards carry no
 * genre markup — the union's superset would leak titles that matched just
 * one of the requested genres. A failed fetch makes membership
 * unverifiable: such runs return nothing rather than leak one-sided
 * matches (the service's offline fallback may serve its last good row).
 *
 * Federated paging is approximate like the union: page N of the
 * intersection is built from page N of each archive, so later pages can
 * repeat or miss items, but every returned title matched every requested
 * genre on the source.
 */
export function intersectSearchResults(
  settled: PromiseSettledResult<SourceSearchResult>[],
  page: number,
): SourceSearchResult {
  if (settled.length === 0 || settled.some((result) => result.status !== 'fulfilled')) {
    return { results: [], page, hasMore: false };
  }
  const lists = settled.map(
    (result) => (result as PromiseFulfilledResult<SourceSearchResult>).value,
  );
  const [first, ...rest] = lists as [SourceSearchResult, ...SourceSearchResult[]];
  const common = new Set(first.results.map((item) => item.id));
  for (const list of rest) {
    const ids = new Set(list.results.map((item) => item.id));
    for (const id of [...common]) {
      if (!ids.has(id)) common.delete(id);
    }
  }
  return {
    results: first.results.filter((item) => common.has(item.id)),
    page,
    hasMore: lists.some((list) => list.hasMore),
  };
}
