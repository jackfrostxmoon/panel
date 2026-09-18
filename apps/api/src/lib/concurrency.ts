/**
 * Bounded-concurrency iteration over an array.
 *
 * Runs `fn` for every item using at most `limit` parallel workers
 * (worker-pool over a shared cursor). Used by source adapters to enrich
 * listing results (e.g. per-item detail fetches) without hammering the
 * source with an unbounded `Promise.all`.
 *
 * A rejection in `fn` for one item does NOT stop the other workers — callers
 * that want per-item tolerance must catch inside `fn`. An exception that
 * escapes `fn` still rejects the whole call (via `Promise.all`), so only
 * use a bare `fn` when a single failure should fail the batch.
 */
export async function eachWithConcurrency<T>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<void>,
  limit = 4,
): Promise<void> {
  const workerCount = Math.min(Math.max(1, limit), items.length);
  if (workerCount === 0) return;
  let cursor = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      // `noUncheckedIndexedAccess` types this as `T | undefined`.
      const item = items[index];
      if (item !== undefined) await fn(item, index);
    }
  });
  await Promise.all(workers);
}
