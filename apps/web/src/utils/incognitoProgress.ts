/**
 * Incognito-mode reading progress — browser-only fallback for the
 * server-side `reading_progress` table. Enabled while incognito is on;
 * writes and reads never touch the network.
 *
 * Same shape as the server response (`ReadingProgressEntry`) so the
 * TanStack hooks can swap the data source without reshaping anything.
 * `sourceUrl` is not part of `SaveProgressInput`, so locally-recorded
 * entries carry `''` and rails that need it fall back to the panel cache.
 *
 * Stored under `panel-incognito:progress:v1` as a flat array of entries,
 * newest first; writes are upserts by (panelId, chapterId). Capped so the
 * key can't grow without bound — the oldest entries drop off first.
 */

import type { ReadingProgressEntry, SaveProgressInput } from '@panel/shared';

const STORAGE_KEY = 'panel-incognito:progress:v1';
const MAX_ENTRIES = 500;

export interface LocalProgressEntry {
  panelId: string;
  chapterId: string;
  panelTitle: string | null;
  coverUrl: string | null;
  chapterTitle: string | null;
  sourceUrl: string;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEntry(value: unknown): value is LocalProgressEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.panelId === 'string' &&
    value.panelId.length > 0 &&
    typeof value.chapterId === 'string' &&
    value.chapterId.length > 0 &&
    typeof value.updatedAt === 'string'
  );
}

function readAll(): LocalProgressEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isEntry)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function writeAll(entries: LocalProgressEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // Storage full/blocked — progress simply won't persist this session.
  }
}

function toEntry(entry: LocalProgressEntry): ReadingProgressEntry {
  return {
    panelId: entry.panelId,
    chapterId: entry.chapterId,
    updatedAt: entry.updatedAt,
    panelTitle: entry.panelTitle,
    coverUrl: entry.coverUrl,
    chapterTitle: entry.chapterTitle,
    sourceUrl: entry.sourceUrl,
  };
}

/** Cap for the "recent" list — matches the server's default window. */
const RECENT_LIMIT = 20;

/** Upsert one chapter's read marker. Returns the stored entry. */
export function saveLocalProgress(input: SaveProgressInput): ReadingProgressEntry {
  const entries = readAll();
  const existing = entries.find(
    (e) => e.panelId === input.panelId && e.chapterId === input.chapterId,
  );
  const next: LocalProgressEntry = {
    panelId: input.panelId,
    chapterId: input.chapterId,
    panelTitle: input.panelTitle ?? existing?.panelTitle ?? null,
    coverUrl: input.coverUrl ?? existing?.coverUrl ?? null,
    chapterTitle: input.chapterTitle ?? existing?.chapterTitle ?? null,
    sourceUrl: existing?.sourceUrl ?? '',
    updatedAt: new Date().toISOString(),
  };
  const rest = entries.filter(
    (e) => !(e.panelId === input.panelId && e.chapterId === input.chapterId),
  );
  writeAll([next, ...rest]);
  return toEntry(next);
}

/** Single read marker — what `useProgress` returns. */
export function getLocalProgress(
  panelId: string,
  chapterId: string,
): ReadingProgressEntry | null {
  const found = readAll().find((e) => e.panelId === panelId && e.chapterId === chapterId);
  return found ? toEntry(found) : null;
}

/** Newest-first recent markers across all panels — home/details rails. */
export function recentLocalProgress(limit = RECENT_LIMIT): ReadingProgressEntry[] {
  return readAll().slice(0, limit).map(toEntry);
}

/** Newest marker for one panel, or null. */
export function latestLocalProgressForPanel(panelId: string): ReadingProgressEntry | null {
  const found = readAll().find((e) => e.panelId === panelId);
  return found ? toEntry(found) : null;
}

/** Every marker for one panel, newest first. */
export function localProgressForPanel(panelId: string): ReadingProgressEntry[] {
  return readAll().filter((e) => e.panelId === panelId).map(toEntry);
}

/** Delete all markers for a panel. Returns how many were removed. */
export function clearLocalProgressForPanel(panelId: string): number {
  const entries = readAll();
  const kept = entries.filter((e) => e.panelId !== panelId);
  writeAll(kept);
  return entries.length - kept.length;
}

/**
 * Bulk mark chapters read/unread — the incognito twin of
 * `POST /api/progress/bulk-mark`. Marking read creates placeholder entries
 * (chapter number/title unknown); unmarking removes the marker.
 */
export function bulkMarkLocalProgress(
  panelId: string,
  chapters: ReadonlyArray<{ chapterId: string; read: boolean }>,
): { markedRead: number; markedUnread: number } {
  let markedRead = 0;
  let markedUnread = 0;
  let entries = readAll();
  for (const { chapterId, read } of chapters) {
    const existing = entries.find((e) => e.panelId === panelId && e.chapterId === chapterId);
    if (read) {
      if (existing) continue;
      entries = [
        {
          panelId,
          chapterId,
          panelTitle: null,
          coverUrl: null,
          chapterTitle: null,
          sourceUrl: '',
          updatedAt: new Date().toISOString(),
        },
        ...entries,
      ];
      markedRead += 1;
    } else {
      if (!existing) continue;
      entries = entries.filter((e) => !(e.panelId === panelId && e.chapterId === chapterId));
      markedUnread += 1;
    }
  }
  writeAll(entries);
  return { markedRead, markedUnread };
}

/** Wipe every incognito-recorded progress marker. */
export function clearAllLocalProgress(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // best-effort
  }
}
