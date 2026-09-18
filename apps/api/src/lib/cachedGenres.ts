import { toGlobalId, type GenreLookup } from '@panel/shared';

/**
 * Fill listing-item genres from the panel metadata cache (panels the user
 * has opened before). Callers run this before their bounded-concurrency
 * detail-fetch pass so only uncached items hit the source.
 *
 * Best-effort by design: no lookup wired (tests, standalone use) or any
 * lookup failure simply leaves every item empty and the fetch pass covers
 * everything. Cached entries with no genres are ignored — an empty list
 * means "unknown", never "has none".
 */
export async function fillGenresFromCache<
  T extends { nativeId: string; genres: string[] },
>(
  sourceName: string,
  items: readonly T[],
  findGenres: GenreLookup | undefined,
): Promise<void> {
  const pending = items.filter((item) => item.genres.length === 0);
  if (pending.length === 0 || !findGenres) return;
  try {
    const byGlobalId = new Map(
      pending.map((item) => [toGlobalId(sourceName, item.nativeId), item] as const),
    );
    const known = await findGenres([...byGlobalId.keys()]);
    for (const [globalId, genres] of known) {
      const item = byGlobalId.get(globalId);
      if (item && genres.length > 0) item.genres = [...genres];
    }
  } catch {
    // Cache lookup is best-effort — the fetch pass below covers everything.
  }
}
