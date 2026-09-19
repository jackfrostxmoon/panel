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
 * Explorer; chapter pages go one level deeper into
 * `<Title> [<source>-<hash>]/<chapter label> [<chapterHash>]/` with human
 * page filenames (`001.jpg`, `002.jpg`, … — 1-based page order). Reads find
 * files through the cache's recursive index no matter which folder (or the
 * legacy flat root) they live in.
 *
 * Folder names are derived from the panel's DB title plus the stable 8-hex
 * tag hash of its global id, so renames stay unique per panel even when two
 * titles sanitize identically, and the suffix survives title edits. Chapter
 * folders embed the chapter tag hash the same way, which is also what lets
 * size/clear-by-tag attribute a numbered page file back to its chapter
 * without storing anything in the database.
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

/**
 * Human label for a chapter folder, e.g. `chapter 1`. Prefers the numeric
 * chapter number (read from the existing chapter row — never written by the
 * cache); falls back to the chapter title when there is no number.
 */
export function formatChapterLabel(chapterNumber: number | null, title: string): string {
  if (chapterNumber !== null && chapterNumber !== undefined && Number.isFinite(chapterNumber)) {
    return `chapter ${Number.isInteger(chapterNumber) ? chapterNumber : String(chapterNumber)}`;
  }
  const clean = (title ?? '').replace(/\s+/g, ' ').trim();
  return clean || 'untitled chapter';
}

/**
 * Folder name for one chapter, e.g. `chapter 1 [ef56ab78]`. Lives inside the
 * panel folder. `chapterTagHash` must be `folderTagHash(chapterGlobalId)` —
 * the bare 8-hex suffix (no source prefix, unlike panel folders) is what
 * lets tag operations attribute numbered page files back to their chapter.
 */
export function chapterFolderName(label: string, chapterTagHash: string): string {
  const suffix = ` [${chapterTagHash}]`;
  const maxClean = MAX_FOLDER_NAME_LENGTH - suffix.length;
  let clean = sanitizeFolderSegment(label);
  if (clean.length > maxClean) {
    clean = clean.slice(0, maxClean).trimEnd().replace(/[. ]+$/g, '') || 'untitled';
  }
  return `${clean}${suffix}`;
}

export interface CacheMigrationResult {
  scanned: number;
  moved: number;
  skipped: number;
  /** Chapter files grouped from a panel folder into a chapter subfolder. */
  chaptersGrouped: number;
}

const FLAT_TAGGED_RE = /^(cover|chapter)-([0-9a-f]{8})[0-9a-f]{56}\.\w+$/;

/**
 * One-time, best-effort organization of pre-existing flat cache files into
 * per-panel folders. Runs at server startup (see `index.ts`): files whose
 * 8-hex tag prefix matches a known panel or chapter row are renamed into
 * that panel's folder; unknown/legacy files stay where they are and keep
 * serving from the flat root.
 *
 * A second pass then groups chapter files that already sit inside panel
 * folders (from previous runs, or moved by the first pass) into per-chapter
 * subfolders (`<panel>/<chapter label> [<hash>]/`). Existing files keep
 * their hash filenames — the original page order is unrecoverable from
 * `sha256(<tag>#p<index>)`, so renumbering them would fabricate an order;
 * only new downloads get human `001.jpg`-style names. Both shapes keep
 * serving through the recursive index.
 *
 * Moves are same-directory renames (fast, atomic per file). If two files
 * would collide at the destination (e.g. a concurrent write won the race),
 * the leftover source copy is deleted as a duplicate.
 */
export async function migrateImageCacheToFolders(
  dir: string,
  db: Database,
): Promise<CacheMigrationResult> {
  const result: CacheMigrationResult = { scanned: 0, moved: 0, skipped: 0, chaptersGrouped: 0 };
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
      .select({
        globalId: chapters.globalId,
        panelId: chapters.panelId,
        title: chapters.title,
        chapterNumber: chapters.chapterNumber,
      })
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
  // Chapter tag hash → its panel + chapter folders (read-only label lookup;
  // chapters with no row stay at the panel level and keep serving there).
  const chapterFolderByTagHash = new Map<string, { panelFolder: string; chapterFolder: string }>();
  for (const c of chapterRows) {
    const panelFolder = folderByPanelId.get(c.panelId);
    if (!panelFolder) continue;
    const hash = folderTagHash(c.globalId);
    if (chapterFolderByTagHash.has(hash)) continue;
    chapterFolderByTagHash.set(hash, {
      panelFolder,
      chapterFolder: chapterFolderName(formatChapterLabel(c.chapterNumber, c.title), hash),
    });
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

  // Second pass: group chapter files already inside panel folders (moved by
  // the first pass just now, or by previous runs) into chapter subfolders.
  // Filenames are kept as-is — only the directory level changes.
  let panelDirs: string[];
  try {
    const top = await readdir(dir, { withFileTypes: true });
    panelDirs = top.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return result;
  }
  for (const panelDir of panelDirs) {
    let inner;
    try {
      inner = await readdir(join(dir, panelDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of inner) {
      if (!entry.isFile() || entry.name.endsWith('.tmp')) continue;
      const match = FLAT_TAGGED_RE.exec(entry.name);
      if (!match || match[1] !== 'chapter' || !match[2]) continue;
      const target = chapterFolderByTagHash.get(match[2]);
      if (!target || target.panelFolder !== panelDir) {
        result.skipped += 1;
        continue;
      }
      result.scanned += 1;
      try {
        if (!ensured.has(join(target.panelFolder, target.chapterFolder))) {
          await mkdir(join(dir, target.panelFolder, target.chapterFolder), { recursive: true });
          ensured.add(join(target.panelFolder, target.chapterFolder));
        }
        const dest = join(dir, target.panelFolder, target.chapterFolder, entry.name);
        let destExists = false;
        try {
          await stat(dest);
          destExists = true;
        } catch {
          // Destination missing — the normal case.
        }
        if (destExists) {
          await rm(join(dir, panelDir, entry.name), { force: true });
        } else {
          await rename(join(dir, panelDir, entry.name), dest);
        }
        result.chaptersGrouped += 1;
      } catch {
        result.skipped += 1;
      }
    }
  }
  return result;
}
