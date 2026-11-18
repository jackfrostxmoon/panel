import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import {
  DEFAULT_DETAILS_PAGE_SETTINGS,
  type DetailsPageSettings,
} from '@panel/shared';

const DATA_DIR = 'data/display';
const FILE_PATH = `${DATA_DIR}/details.json`;

/** Load the details-page settings; defaults when the file is missing/invalid. */
export function loadDetailsSettings(): DetailsPageSettings {
  if (!existsSync(FILE_PATH)) return { ...DEFAULT_DETAILS_PAGE_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(FILE_PATH, 'utf-8')) as Partial<DetailsPageSettings>;
    return {
      showFillerLabels:
        typeof parsed.showFillerLabels === 'boolean'
          ? parsed.showFillerLabels
          : DEFAULT_DETAILS_PAGE_SETTINGS.showFillerLabels,
    };
  } catch {
    return { ...DEFAULT_DETAILS_PAGE_SETTINGS };
  }
}

/** Replace the stored details-page settings (already validated by the route). */
export function saveDetailsSettings(settings: DetailsPageSettings): DetailsPageSettings {
  const clean: DetailsPageSettings = {
    showFillerLabels: settings.showFillerLabels !== false,
  };
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(FILE_PATH, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}
