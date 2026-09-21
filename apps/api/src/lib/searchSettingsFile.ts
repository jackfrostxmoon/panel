import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import {
  DEFAULT_CARD_LAYOUT,
  DEFAULT_SEARCH_PAGE_SETTINGS,
  type CardLayout,
  type SearchPageSettings,
} from '@panel/shared';

const DATA_DIR = 'data/display';
const FILE_PATH = `${DATA_DIR}/search.json`;

/** Load the search-page settings; defaults when the file is missing/invalid. */
export function loadSearchSettings(): SearchPageSettings {
  if (!existsSync(FILE_PATH)) return { ...DEFAULT_SEARCH_PAGE_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(FILE_PATH, 'utf-8')) as Partial<SearchPageSettings>;
    return {
      infiniteScroll:
        typeof parsed.infiniteScroll === 'boolean'
          ? parsed.infiniteScroll
          : DEFAULT_SEARCH_PAGE_SETTINGS.infiniteScroll,
      cardLayout: coerceCardLayout(parsed.cardLayout),
    };
  } catch {
    return { ...DEFAULT_SEARCH_PAGE_SETTINGS };
  }
}

/** Replace the stored search-page settings (already validated by the route). */
export function saveSearchSettings(settings: SearchPageSettings): SearchPageSettings {
  const clean: SearchPageSettings = {
    infiniteScroll: settings.infiniteScroll === true,
    cardLayout: coerceCardLayout(settings.cardLayout),
  };
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(FILE_PATH, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

function coerceCardLayout(value: unknown): CardLayout {
  return value === 'list' || value === 'cards' ? value : DEFAULT_CARD_LAYOUT;
}
