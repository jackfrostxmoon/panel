import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import {
  DEFAULT_CARD_LAYOUT,
  DEFAULT_LATEST_PAGE_SETTINGS,
  type CardLayout,
  type LatestPageSettings,
} from '@panel/shared';

const DATA_DIR = 'data/display';
const FILE_PATH = `${DATA_DIR}/latest.json`;

/** Load the latest-page settings; defaults when the file is missing/invalid. */
export function loadLatestSettings(): LatestPageSettings {
  if (!existsSync(FILE_PATH)) return { ...DEFAULT_LATEST_PAGE_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(FILE_PATH, 'utf-8')) as Partial<LatestPageSettings>;
    return {
      infiniteScroll:
        typeof parsed.infiniteScroll === 'boolean'
          ? parsed.infiniteScroll
          : DEFAULT_LATEST_PAGE_SETTINGS.infiniteScroll,
      cardLayout: coerceCardLayout(parsed.cardLayout),
      filtersCollapsed:
        typeof parsed.filtersCollapsed === 'boolean'
          ? parsed.filtersCollapsed
          : DEFAULT_LATEST_PAGE_SETTINGS.filtersCollapsed,
      searchOpen:
        typeof parsed.searchOpen === 'boolean'
          ? parsed.searchOpen
          : DEFAULT_LATEST_PAGE_SETTINGS.searchOpen,
    };
  } catch {
    return { ...DEFAULT_LATEST_PAGE_SETTINGS };
  }
}

/** Replace the stored latest-page settings (already validated by the route). */
export function saveLatestSettings(settings: LatestPageSettings): LatestPageSettings {
  const clean: LatestPageSettings = {
    infiniteScroll: settings.infiniteScroll === true,
    cardLayout: coerceCardLayout(settings.cardLayout),
    filtersCollapsed: settings.filtersCollapsed !== false,
    searchOpen: settings.searchOpen === true,
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
