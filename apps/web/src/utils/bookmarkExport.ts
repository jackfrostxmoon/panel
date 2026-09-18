import type { BackupExportScope, Bookmark } from '@panel/shared';

/**
 * Bookmark backup as a .sql dump.
 *
 * Export downloads the dump produced by GET /api/backup/export (pg_dump
 * COPY format — the same file `bun run db:import` reads). `full` covers the
 * whole database including caches; `minimal` is bookmark data only
 * (bookmarks, folders, chapter marks, progress, lists, ratings, tags —
 * cache tables skipped, panel/chapters limited to referenced rows).
 * Import POSTs the file back to /api/backup/import, which restores it
 * idempotently, so importing a file twice never duplicates anything.
 */

export interface BookmarkExportFile {
  /** Format tag so future versions can migrate. */
  format: 'panel-viewer-bookmarks';
  version: 1;
  exportedAt: string;
  bookmarks: Array<{
    panelId: string;
    title: string;
    coverUrl: string | null;
    source: string;
    sourceUrl: string;
  }>;
}

export function toExportFile(bookmarks: Bookmark[]): BookmarkExportFile {
  return {
    format: 'panel-viewer-bookmarks',
    version: 1,
    exportedAt: new Date().toISOString(),
    bookmarks: bookmarks.map((b) => ({
      panelId: b.panelId,
      title: b.title,
      coverUrl: b.coverUrl,
      source: b.source,
      sourceUrl: b.sourceUrl,
    })),
  };
}

/** True when the uploaded text looks like a .sql dump (not legacy JSON). */
export function isSqlDump(raw: string): boolean {
  return /(^|\n)\s*COPY\s+(public\.)?\w+\s*\(/i.test(raw);
}

/**
 * Slice a dump into small single-block pieces for upload. The API caps
 * request bodies at 1 MiB, but dumps are tens of MB — so each slice holds
 * one table's COPY header plus up to ~`maxBytes` of its data lines, closed
 * by its own `\.` terminator. Slices keep dump order (FK-safe) and the
 * server treats a missing table as zero rows, so every slice restores
 * standalone and re-sending is idempotent.
 */
export function splitDumpIntoChunks(dump: string, maxBytes = 800_000): string[] {
  const chunks: string[] = [];
  let header: string | null = null;
  let buf: string[] = [];
  let bufBytes = 0;
  const flush = () => {
    if (header && buf.length > 0) {
      chunks.push(`${header}\n${buf.join('\n')}\n\\.`);
      buf = [];
      bufBytes = 0;
    }
  };
  for (const rawLine of dump.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (header === null) {
      if (/^COPY\s+(public\.)?\w+\s*\(.*\)\s+FROM stdin;\s*$/.test(line)) header = line;
      continue;
    }
    if (line === '\\.') {
      flush();
      header = null;
      continue;
    }
    buf.push(line);
    bufBytes += line.length + 1;
    if (bufBytes >= maxBytes) flush();
  }
  flush();
  return chunks;
}

/** Count data rows of one table's COPY block inside a dump (for toasts). */
export function countDumpRows(raw: string, table: string): number {
  const start = new RegExp(`^COPY\\s+(public\\.)?${table}\\s*\\(`, 'i');
  let inside = false;
  let count = 0;
  for (const line of raw.split('\n')) {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!inside) {
      if (start.test(clean)) inside = true;
      continue;
    }
    if (clean === '\\.') break;
    count += 1;
  }
  return count;
}

/** Trigger a client-side download of the .sql dump. */
export function downloadSqlDump(dump: string, scope: BackupExportScope = 'full'): void {
  const blob = new Blob([dump], { type: 'application/sql' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  const prefix = scope === 'minimal' ? 'panel-viewer-bookmarks' : 'panel-viewer-backup';
  anchor.download = `${prefix}-${new Date().toISOString().slice(0, 10)}.sql`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Parse a legacy JSON export (the pre-.sql format). Kept so files exported
 * by older versions still import. New exports are always .sql dumps.
 */
export function parseBookmarkImport(raw: string): BookmarkExportFile['bookmarks'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('That file is neither a .sql backup nor a valid JSON export.');
  }
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as BookmarkExportFile).bookmarks)
      ? (parsed as BookmarkExportFile).bookmarks
      : [];

  const valid = list.filter(
    (entry): entry is BookmarkExportFile['bookmarks'][number] =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as { panelId?: unknown }).panelId === 'string' &&
      typeof (entry as { title?: unknown }).title === 'string' &&
      typeof (entry as { source?: unknown }).source === 'string' &&
      typeof (entry as { sourceUrl?: unknown }).sourceUrl === 'string',
  );
  if (valid.length === 0) {
    throw new Error('No bookmarks found in that file.');
  }
  return valid;
}
