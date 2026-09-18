import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { chapters, panel } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { logger } from './logger.js';

/**
 * Per-panel folders for the on-disk image cache.
 *
 * Files used to land flat in the cache root as `chapter-<tagHash><suffix>.<ext>`
 * (hash soup — see the screenshot that motivated this). New writes now go to
 * `<Title> [<source>-<hash>]/` subfolders so the cache is browsable in
 * Explorer; reads find files through the cache's recursive index no matter
 * which folder (or the legacy flat root) they live in.
 *
 * Folder names are derived from the panel's DB title plus the stable 8-hex
 * tag hash of its global id, so renames stay unique per panel even when two
 * titles sanitize identically, and the suffix survives title edits.
 */

/** Hard cap for a folder name (keeps full paths Explorer-friendly). */
export const MAX_FOLDER_NAME_LENGTH = 100;
/** Title portion before the ` [source-hash]` suffix is appended. */
const MAX_TITLE_PART = 60;

/** Names Windows refuses as path segments (CON, PRN, AUX, NUL, COM1-9, LPT1-9). */
const WINDOWS_RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/**
 * Make a panel title safe as a single path segment on Windows + POSIX:
 * illegal/control chars become `-`, whitespace collapses, trailing dots and
 * spaces are trimmed (Windows refuses those), length is capped.
 */
export function sanitizeFolderSegment(title: string): string {
  // eslint-disable-next-line no-control-regex -- stripping C0 controls from folder names is the point.
  const collapsed = (title ?? '').replace(/[\x00-\x1f<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim();
  let out = collapsed.replace(/[. ]+$/g, '');
  if (out.length > MAX_TITLE_PART) {
    out = out.slice(0, MAX_TITLE_PART).trimEnd().replace(/[. ]+$/g, '');
  }
  if (!out) return 'untitled';
  if (WINDOWS_RESERVED.has(out.toUpperCase())) return `_${out}`;
  return out;
}

/** 8-hex-char hash prefix, same derivation as `ImageCache.tagHash`. */
export function folderTagHash(tag: string): string {
  return createHash('sha256').update(tag).digest('hex').slice(0, 8);
}

/**
 * Folder name for one panel, e.g. `Fukushuu no Taishi - Level 9999 [mr-863c75a0]`.
 * `panelTagHash` must be `folderTagHash(panelGlobalId)` — stable across
 * title edits, unique per panel.
 */
export function panelFolderName(title: string, source: string, panelTagHash: string): string {
  const suffix = ` [${source}-${panelTagHash}]`;
  const maxClean = MAX_FOLDER_NAME_LENGTH - suffix.length;
  let clean = sanitizeFolderSegment(title);
  if (clean.length > maxClean) {
    clean = clean.slice(0, maxClean).trimEnd().replace(/[. ]+$/g, '') || 'untitled';
  }
  return `${clean}${suffix}`;
}

export interface CacheMigrationResult {
  scanned: number;
  moved: number;
  skipped: number;
}

const FLAT_TAGGED_RE = /^(cover|chapter)-([0-9a-f]{8})[0-9a-f]{56}\.\w+$/;

/**
 * One-time, best-effort organization of pre-existing flat cache files into
 * per-panel folders. Runs at server startup (see `index.ts`): files whose
 * 8-hex tag prefix matches a known panel or chapter row are renamed into
 * that panel's folder; unknown/legacy files stay where they are and keep
 * serving from the flat root.
 *
 * Moves are same-directory renames (fast, atomic per file). If two files
 * would collide at the destination (e.g. a concurrent write won the race),
 * the leftover source copy is deleted as a duplicate.
 */
export async function migrateImageCacheToFolders(
  dir: string,
  db: Database,
): Promise<CacheMigrationResult> {
  const result: CacheMigrationResult = { scanned: 0, moved: 0, skipped: 0 };
  let topEntries;
  try {
    topEntries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result; // Directory not yet created — nothing to organize.
  }
  const flatFiles = topEntries
    .filter((d) => d.isFile() && !d.name.endsWith('.tmp') && FLAT_TAGGED_RE.test(d.name))
    .map((d) => d.name);
  if (flatFiles.length === 0) return result;

  let panelRows;
  let chapterRows;
  try {
    panelRows = await db
      .select({ id: panel.id, globalId: panel.globalId, title: panel.title, source: panel.source })
      .from(panel);
    chapterRows = await db
      .select({ globalId: chapters.globalId, panelId: chapters.panelId })
      .from(chapters);
  } catch (error) {
    logger.warn('Image cache organization skipped (database unreadable)', {
      error: error instanceof Error ? error.message : String(error),
    });
    return result;
  }

  const folderByPanelId = new Map<string, string>();
  for (const m of panelRows) {
    folderByPanelId.set(m.id, panelFolderName(m.title, m.source, folderTagHash(m.globalId)));
  }
  const folderByTagHash = new Map<string, string>();
  for (const m of panelRows) {
    folderByTagHash.set(folderTagHash(m.globalId), folderByPanelId.get(m.id)!);
  }
  for (const c of chapterRows) {
    const folder = folderByPanelId.get(c.panelId);
    if (folder && !folderByTagHash.has(folderTagHash(c.globalId))) {
      folderByTagHash.set(folderTagHash(c.globalId), folder);
    }
  }

  const ensured = new Set<string>();
  for (const file of flatFiles) {
    result.scanned += 1;
    const match = FLAT_TAGGED_RE.exec(file);
    const folder = match?.[2] ? folderByTagHash.get(match[2]) : undefined;
    if (!folder) {
      result.skipped += 1;
      continue;
    }
    try {
      if (!ensured.has(folder)) {
        await mkdir(join(dir, folder), { recursive: true });
        ensured.add(folder);
      }
      const dest = join(dir, folder, file);
      let destExists = false;
      try {
        await stat(dest);
        destExists = true;
      } catch {
        // Destination missing — the normal case.
      }
      if (destExists) {
        await rm(join(dir, file), { force: true });
      } else {
        await rename(join(dir, file), dest);
      }
      result.moved += 1;
    } catch {
      result.skipped += 1;
    }
  }
  return result;
}
