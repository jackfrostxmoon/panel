/**
 * Global id helpers.
 *
 * Global ids route an entity to its source without a database lookup:
 *
 *   panel:   "mk:solo-leveling.21708"
 *   chapter: "mk:solo-leveling.21708~c200"
 *
 * The chapter token is joined with `~` (not `/`) so ids survive being used as
 * a single URL path segment without percent-encoding surprises.
 */

export const GLOBAL_ID_SEPARATOR = ':';
export const CHAPTER_ID_SEPARATOR = '~';

export function toGlobalId(sourceName: string, nativeId: string): string {
  return `${sourceName}${GLOBAL_ID_SEPARATOR}${nativeId}`;
}

export interface ParsedGlobalId {
  source: string;
  nativeId: string;
}

/** Returns null when the id is malformed (no separator / empty parts). */
export function parseGlobalId(id: string): ParsedGlobalId | null {
  const idx = id.indexOf(GLOBAL_ID_SEPARATOR);
  if (idx <= 0 || idx === id.length - 1) return null;
  return { source: id.slice(0, idx), nativeId: id.slice(idx + 1) };
}

export function isGlobalId(id: string): boolean {
  return parseGlobalId(id) !== null;
}

/** Split a native chapter id into its panel id + chapter token parts. */
export function splitNativeChapterId(nativeChapterId: string): {
  panelId: string;
  chapterToken: string;
} | null {
  const idx = nativeChapterId.lastIndexOf(CHAPTER_ID_SEPARATOR);
  if (idx <= 0 || idx === nativeChapterId.length - 1) return null;
  return {
    panelId: nativeChapterId.slice(0, idx),
    chapterToken: nativeChapterId.slice(idx + 1),
  };
}

export function joinNativeChapterId(panelId: string, chapterToken: string): string {
  return `${panelId}${CHAPTER_ID_SEPARATOR}${chapterToken}`;
}
