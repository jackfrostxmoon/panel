import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import type { ReaderStylePreset } from '@panel/shared';

const DATA_DIR = 'data/reader';
const FILE_PATH = `${DATA_DIR}/styles.json`;
const MAX_NAME = 60;
const MAX_COUNT = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeEntry(raw: unknown): ReaderStylePreset | null {
  if (!isRecord(raw)) return null;
  const name = typeof raw['name'] === 'string' ? raw['name'].trim().slice(0, MAX_NAME) : '';
  if (!name) return null;
  // Settings objects pass through untouched — the web client sanitizes
  // them field-by-field on read, so an older/newer shape never breaks here.
  if (!isRecord(raw['settings'])) return null;
  const updatedAt =
    typeof raw['updatedAt'] === 'string' && raw['updatedAt']
      ? raw['updatedAt']
      : new Date().toISOString();
  const settings = raw['settings'] as unknown as ReaderStylePreset['settings'];
  return { name, settings, updatedAt };
}

function sanitizeList(raw: unknown): ReaderStylePreset[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Map<string, ReaderStylePreset>();
  for (const entry of raw) {
    const preset = sanitizeEntry(entry);
    if (preset) seen.set(preset.name, preset);
  }
  return [...seen.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_COUNT);
}

/** Load the stored style presets; empty when the file is missing/invalid. */
export function loadReaderStyles(): ReaderStylePreset[] {
  if (!existsSync(FILE_PATH)) return [];
  try {
    return sanitizeList(JSON.parse(readFileSync(FILE_PATH, 'utf-8')) as unknown);
  } catch {
    return [];
  }
}

/** Replace the stored style presets (already validated as an array by the route). */
export function saveReaderStyles(styles: unknown[]): ReaderStylePreset[] {
  const clean = sanitizeList(styles);
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(FILE_PATH, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}
