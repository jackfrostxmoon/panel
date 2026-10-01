import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import {
  DEFAULT_SOURCE_ORDER_SETTINGS,
  type SourceOrderSettings,
} from '@panel/shared';

const DATA_DIR = 'data/display';
const FILE_PATH = `${DATA_DIR}/sources.json`;

/** Maximum stored codes — far above the real source count; an abuse guard. */
const MAX_CODES = 50;
/** Maximum length of one source code ("rawsakura"-scale names fit easily). */
const MAX_CODE_LENGTH = 16;

/** Keep the first occurrence of each well-formed code, in order. */
export function sanitizeSourceOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const code = entry.trim();
    if (!code || code.length > MAX_CODE_LENGTH || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= MAX_CODES) break;
  }
  return out;
}

/** Load the source order; canonical (empty) when the file is missing/invalid. */
export function loadSourceOrder(): SourceOrderSettings {
  if (!existsSync(FILE_PATH)) return { ...DEFAULT_SOURCE_ORDER_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(FILE_PATH, 'utf-8')) as Partial<SourceOrderSettings>;
    return { order: sanitizeSourceOrder(parsed.order) };
  } catch {
    return { ...DEFAULT_SOURCE_ORDER_SETTINGS };
  }
}

/** Replace the stored source order (already validated by the route). */
export function saveSourceOrder(settings: SourceOrderSettings): SourceOrderSettings {
  const clean: SourceOrderSettings = { order: sanitizeSourceOrder(settings.order) };
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(FILE_PATH, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}
