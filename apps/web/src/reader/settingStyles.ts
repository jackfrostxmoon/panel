/**
 * Named reader-style presets — pure module (no React).
 * Stored server-side as a JSON file (`data/reader/styles.json`) via the
 * reader-styles endpoints; import/export of that same shape via JSON file.
 */
import type { ReaderStylePreset } from '@panel/shared';
import {
  DEFAULT_READER_SETTINGS,
  PRELOAD_AHEAD_MAX,
  PRELOAD_AHEAD_MIN,
  type ReaderSettings,
} from './settings';
import { normalizeManualSpreadStarts } from './navigation';

export type { ReaderStylePreset } from '@panel/shared';
export const READER_STYLE_FORMAT = 'panel-viewer-reader-styles';
export const READER_STYLE_MAX_NAME = 60;
export const READER_STYLE_MAX_COUNT = 50;

/**
 * Legacy browser-only store, predating the server JSON file. Read once to
 * migrate styles saved before the server persistence existed, then deleted.
 */
const LEGACY_STORAGE_KEY = 'panel-reader:styles:v1';

export interface ReaderStyleExportFile {
  format: typeof READER_STYLE_FORMAT;
  version: 1;
  exportedAt: string;
  styles: ReaderStylePreset[];
}

export function normalizeStyleName(name: string): string {
  return name.trim().slice(0, READER_STYLE_MAX_NAME);
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function nullablePx(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(4096, Math.max(1, Math.trunc(value)));
}

function nullableMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(15000, Math.max(500, Math.trunc(value)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Sanitize the per-chapter manual page merges. Keys are chapter global ids
 * (bounded), values are pair starts normalized by the shared helper. Empty
 * chapters are dropped so the map never keeps dead keys.
 */
function sanitizeManualSpreads(raw: unknown): Record<string, number[]> {
  if (!isRecord(raw)) return {};
  const result: Record<string, number[]> = {};
  for (const [chapterId, value] of Object.entries(raw)) {
    if (!chapterId || chapterId.length > 200) continue;
    if (!Array.isArray(value)) continue;
    const starts = normalizeManualSpreadStarts(value);
    if (starts.length > 0) result[chapterId] = starts;
  }
  return result;
}

/**
 * Sanitize the per-chapter spread start pages (1-based). Invalid entries are
 * dropped so the field only ever holds a usable page number.
 */
function sanitizeSpreadStarts(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) return {};
  const result: Record<string, number> = {};
  for (const [chapterId, value] of Object.entries(raw)) {
    if (!chapterId || chapterId.length > 200) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const page = Math.trunc(value);
    if (page < 1 || page > 10_000) continue;
    result[chapterId] = page;
  }
  return result;
}

/**
 * Chapter-specific bits that must not leak into a named style: page numbers
 * only make sense in the chapter they were entered for. Comparing/exporting
 * with these cleared keeps the styles dropdown honest and stops applying a
 * style from wiping another chapter's merges.
 */
function withoutChapterSpreads(settings: ReaderSettings): ReaderSettings {
  return { ...sanitizeReaderSettings(settings), manualSpreads: {}, spreadStarts: {} };
}

/** Drop unknown keys, fill defaults for missing/invalid fields. */
export function sanitizeReaderSettings(raw: unknown): ReaderSettings {
  const d = DEFAULT_READER_SETTINGS;
  if (!isRecord(raw)) return { ...d };
  const preload = Math.trunc(
    finiteNumber(raw['preloadAhead'], d.preloadAhead, PRELOAD_AHEAD_MIN, PRELOAD_AHEAD_MAX),
  );
  return {
    mode: oneOf(raw['mode'], ['vertical', 'paged', 'gallery'] as const, d.mode),
    direction: oneOf(raw['direction'], ['ltr', 'rtl'] as const, d.direction),
    background: oneOf(raw['background'], ['dark', 'light', 'high-contrast'] as const, d.background),
    imageWidth: finiteNumber(raw['imageWidth'], d.imageWidth, 20, 100),
    imageWidthPx: nullablePx(raw['imageWidthPx']),
    imageHeightPx: nullablePx(raw['imageHeightPx']),
    // Legacy payloads without the flag infer it from stored pixel sizes so
    // existing setups keep their fixed layout; fresh setups default to off.
    pixelSizeEnabled: bool(
      raw['pixelSizeEnabled'],
      nullablePx(raw['imageWidthPx']) !== null || nullablePx(raw['imageHeightPx']) !== null,
    ),
    showProgressBar: bool(raw['showProgressBar'], d.showProgressBar),
    imageGap: bool(raw['imageGap'], d.imageGap),
    clearToolbarSpace: bool(raw['clearToolbarSpace'], d.clearToolbarSpace),
    scrollSpeed: oneOf(raw['scrollSpeed'], ['slow', 'normal', 'fast'] as const, d.scrollSpeed),
    smoothScrollKeys: bool(raw['smoothScrollKeys'], d.smoothScrollKeys),
    imageLoad: oneOf(raw['imageLoad'], ['parallel', 'sequential'] as const, d.imageLoad),
    preloadAhead: preload,
    imageBrightness: finiteNumber(raw['imageBrightness'], d.imageBrightness, 30, 150),
    doublePage: bool(raw['doublePage'], d.doublePage),
    spreadOddPolicy: oneOf(
      raw['spreadOddPolicy'],
      ['duplicate', 'blank', 'single'] as const,
      d.spreadOddPolicy,
    ),
    autoScrollDelayMs: nullableMs(raw['autoScrollDelayMs']),
    showAutoScrollButton: bool(raw['showAutoScrollButton'], d.showAutoScrollButton),
    wheelPagesPerNotch: finiteNumber(raw['wheelPagesPerNotch'], d.wheelPagesPerNotch, 0, 3),
    keyPagesPress: finiteNumber(raw['keyPagesPress'], d.keyPagesPress, 0, 3),
    fitToHeight: bool(raw['fitToHeight'], d.fitToHeight),
    fitToWidth: bool(raw['fitToWidth'], d.fitToWidth),
    autoLandscapeSingle: bool(raw['autoLandscapeSingle'], d.autoLandscapeSingle),
    dataSaver: bool(raw['dataSaver'], d.dataSaver),
    showScrollbar: bool(raw['showScrollbar'], d.showScrollbar),
    glidePreset: oneOf(
      raw['glidePreset'],
      ['instant', 'quick', 'normal', 'smooth'] as const,
      d.glidePreset,
    ),
    mkImageServer: oneOf<'default' | 'sv2' | 'sv3'>(
      raw['mkImageServer'],
      ['default', 'sv2', 'sv3'] as const,
      d.mkImageServer ?? 'default',
    ) as 'default' | 'sv2' | 'sv3',
    manualSpreads: sanitizeManualSpreads(raw['manualSpreads']),
    spreadStarts: sanitizeSpreadStarts(raw['spreadStarts']),
  };
}

function sanitizePreset(raw: unknown): ReaderStylePreset | null {
  if (!isRecord(raw)) return null;
  const name = normalizeStyleName(typeof raw['name'] === 'string' ? raw['name'] : '');
  if (!name) return null;
  const settings = sanitizeReaderSettings(raw['settings']);
  const updatedAt =
    typeof raw['updatedAt'] === 'string' && raw['updatedAt'] ? raw['updatedAt'] : new Date().toISOString();
  return { name, settings, updatedAt };
}

function sortPresets(list: ReaderStylePreset[]): ReaderStylePreset[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Sanitize any unknown payload (server response, import file, legacy store)
 * into a sorted, capped preset list. Unknown keys are dropped and invalid
 * fields fall back to reader defaults, so an older/newer shape never breaks.
 */
export function sanitizeStylePresets(raw: unknown): ReaderStylePreset[] {
  const list = Array.isArray(raw) ? raw : [];
  const valid: ReaderStylePreset[] = [];
  for (const entry of list) {
    const preset = sanitizePreset(entry);
    if (preset) valid.push(preset);
  }
  return sortPresets(valid.slice(0, READER_STYLE_MAX_COUNT));
}

/** Read the legacy browser-only store (pre-server-JSON-file styles). */
export function loadLegacyLocalPresets(): ReaderStylePreset[] {
  const store = storage();
  if (!store) return [];
  let raw: string | null;
  try {
    raw = store.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return sanitizeStylePresets(parsed);
}

/** Drop the legacy browser-only store after a successful server migration. */
export function clearLegacyLocalPresets(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Best-effort — a stale copy here is harmless (server is the source).
  }
}

/** Insert or overwrite preset by name. Pure — returns the sorted list. */
export function saveStylePreset(
  name: string,
  settings: ReaderSettings,
  existing: ReaderStylePreset[],
): ReaderStylePreset[] {
  const clean = normalizeStyleName(name);
  if (!clean) throw new Error('Enter a name for this style.');
  const next = existing.filter((p) => p.name !== clean);
  // Manual page merges are chapter-specific — never capture them in a style.
  next.push({
    name: clean,
    settings: withoutChapterSpreads(settings),
    updatedAt: new Date().toISOString(),
  });
  return sortPresets(next).slice(0, READER_STYLE_MAX_COUNT);
}

/** Remove one preset by name. Pure — returns the remaining list. */
export function deleteStylePreset(name: string, existing: ReaderStylePreset[]): ReaderStylePreset[] {
  return existing.filter((p) => p.name !== name);
}

/**
 * True when two snapshots describe the same reader setup (name/updatedAt
 * ignored). Both sides are sanitized first so a stored preset and live
 * settings compare on the same normalized shape.
 */
export function readerSettingsEqual(a: ReaderSettings, b: ReaderSettings): boolean {
  // Manual page merges belong to a chapter, not a style — ignore them so
  // adding a merge doesn't flip the dropdown to "Custom".
  const left = withoutChapterSpreads(a);
  const right = withoutChapterSpreads(b);
  for (const key of Object.keys(left) as (keyof ReaderSettings)[]) {
    // Cleared on both sides above, and each call builds a fresh object.
    if (key === 'manualSpreads' || key === 'spreadStarts') continue;
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/**
 * Name of the first preset whose settings match the live settings, or ''
 * when nothing matches (caller shows the empty / custom state).
 */
export function findMatchingPreset(
  settings: ReaderSettings,
  presets: ReaderStylePreset[],
): string {
  const current = sanitizeReaderSettings(settings);
  return presets.find((p) => readerSettingsEqual(current, p.settings))?.name ?? '';
}

/** Overwrite the whole list (used after import). Pure — returns sorted list. */
export function replaceStylePresets(list: ReaderStylePreset[]): ReaderStylePreset[] {
  const valid: ReaderStylePreset[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const preset = sanitizePreset(entry);
    if (preset && !seen.has(preset.name)) {
      seen.add(preset.name);
      valid.push(preset);
    }
  }
  return sortPresets(valid).slice(0, READER_STYLE_MAX_COUNT);
}

export function toStyleExportFile(styles: ReaderStylePreset[]): ReaderStyleExportFile {
  return {
    format: READER_STYLE_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    styles,
  };
}

export function downloadStyleExport(styles: ReaderStylePreset[], singleName?: string): void {
  const payload = singleName ? styles.filter((s) => s.name === singleName) : styles;
  const blob = new Blob([JSON.stringify(toStyleExportFile(payload), null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  const slug = singleName
    ? singleName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'style'
    : 'reader-styles';
  anchor.download = `${slug}-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Accept export file ({format, styles}), bare array, or single preset.
 * Throws on empty/invalid input.
 */
export function parseStyleImport(raw: string): ReaderStylePreset[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  let candidates: unknown[] = [];
  if (Array.isArray(parsed)) {
    candidates = parsed;
  } else if (isRecord(parsed) && Array.isArray(parsed['styles'])) {
    candidates = parsed['styles'] as unknown[];
  } else if (isRecord(parsed) && (parsed['settings'] || parsed['name'])) {
    candidates = [parsed];
  }
  const valid: ReaderStylePreset[] = [];
  for (const entry of candidates) {
    const preset = sanitizePreset(entry);
    if (preset) valid.push(preset);
  }
  if (valid.length === 0) throw new Error('No reader styles found in that file.');
  return valid;
}
