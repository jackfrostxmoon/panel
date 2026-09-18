import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PanelSummary, ReadingProgressEntry, SourceSearchResult } from '@panel/shared';
import { getProxiedImageUrl } from './format';

/**
 * Resolve the cache-settings drill dialog's ticked tag hashes back to chapter
 * global ids. The clear-by-tag API only accepts raw provenance strings
 * (hashes fail its strict tag validation with a 400, which used to abort the
 * whole batch on the first row), so the selection must be mapped to ids —
 * the same values the per-row trash icon sends. Hashes with no matching row
 * (the chapter list changed since the user ticked them) are dropped.
 */
export function chapterIdsForSelectedTags(
  rows: ReadonlyArray<{ tag: string; chapter: { id: string } }>,
  selected: ReadonlySet<string>,
): string[] {
  const idByTag = new Map(rows.map((row) => [row.tag, row.chapter.id] as const));
  const ids: string[] = [];
  for (const hash of selected) {
    const id = idByTag.get(hash);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/**
 * Warm the on-disk image cache the moment the app mounts, so the covers the
 * user is most likely to see next are already on disk — no upstream fetch on
 * revisit. Pure client-side: it only turns already-cached JSON data into
 * preloaded images, it never issues a new API request.
 *
 * Scope (bounded, not all-time): the latest-page covers for the active
 * source + the covers of every bookmarked panel + covers from any search
 * result already in cache. Chapter images are warmed on demand when the
 * user opens a chapter (visible window + lookahead).
 */
export function useWarmCovers() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const coverUrls = collectCoverUrls(queryClient);
    if (coverUrls.length === 0) return;

    const preloaders = coverUrls.map((url) => {
      const img = new Image();
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.src = url;
      return img;
    });

    return () => {
      for (const img of preloaders) {
        img.src = '';
      }
    };
  }, [queryClient]);
}

function collectCoverUrls(queryClient: ReturnType<typeof useQueryClient>): string[] {
  const urls = new Set<string>();
  const seen = new Set<string>();

  const add = (
    cover: { coverUrl: string | null; source?: string } | null | undefined,
    tag: string | null = null,
  ) => {
    if (!cover?.coverUrl) return;
    const proxied = getProxiedImageUrl(cover.source ?? '', cover.coverUrl, 'cover', tag);
    if (proxied && !seen.has(proxied)) {
      seen.add(proxied);
      urls.add(proxied);
    }
  };

  // Latest-page covers — the first thing the user lands on after home.
  // Match every query whose key starts with 'latest' (page 1/2/3…).
  const latestData = queryClient.getQueriesData<SourceSearchResult>({
    queryKey: ['latest'],
  });
  for (const [, data] of latestData) {
    for (const m of data?.results ?? []) add(m, m.id);
  }

  // Search results the user already pulled — covers they're about to click.
  // best-effort: only covers already in cache.
  try {
    const searchCache = queryClient.getQueriesData<SourceSearchResult>({
      queryKey: ['search'],
    });
    for (const [, data] of searchCache) {
      for (const m of data?.results ?? []) add(m, m.id);
    }
  } catch {
    // ignore — best-effort
  }

  // Bookmark covers — the library the user is most likely to return to.
  try {
    const bookmarkCache = queryClient.getQueriesData<PanelSummary[]>({
      queryKey: ['bookmarks'],
    });
    for (const [, data] of bookmarkCache) {
      for (const m of data ?? []) add(m, m.id);
    }
  } catch {
    // ignore
  }

  // Recently-read covers — the "continue reading" rail on home.
  try {
    const progressCache = queryClient.getQueriesData<ReadingProgressEntry[]>({
      queryKey: ['progress'],
    });
    for (const [, data] of progressCache) {
      for (const entry of data ?? []) {
        // `panelId` is the global panel id (`<source>:<nativeId>`), which is
        // exactly the provenance tag the proxy bakes into cover filenames.
        add({ coverUrl: entry.coverUrl, source: entry.panelId.split(':')[0] ?? '' }, entry.panelId);
      }
    }
  } catch {
    // ignore
  }

  return [...urls];
}