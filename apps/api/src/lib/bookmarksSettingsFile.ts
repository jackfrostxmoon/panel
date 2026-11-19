import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import {
  DEFAULT_BOOKMARKS_PAGE_SETTINGS,
  DEFAULT_CARD_LAYOUT,
  type BookmarksPageSettings,
  type CardLayout,
} from '@panel/shared';

const DATA_DIR = 'data/display';
const FILE_PATH = `${DATA_DIR}/bookmarks.json`;

/** Load the bookmarks-page settings; defaults when the file is missing/invalid. */
export function loadBookmarksSettings(): BookmarksPageSettings {
  if (!existsSync(FILE_PATH)) return { ...DEFAULT_BOOKMARKS_PAGE_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(FILE_PATH, 'utf-8')) as Partial<BookmarksPageSettings>;
    return {
      cardLayout: coerceCardLayout(parsed.cardLayout),
      filtersCollapsed:
        typeof parsed.filtersCollapsed === 'boolean'
          ? parsed.filtersCollapsed
          : DEFAULT_BOOKMARKS_PAGE_SETTINGS.filtersCollapsed,
      searchOpen:
        typeof parsed.searchOpen === 'boolean'
          ? parsed.searchOpen
          : DEFAULT_BOOKMARKS_PAGE_SETTINGS.searchOpen,
      sortByLatestUpdate:
        typeof parsed.sortByLatestUpdate === 'boolean'
          ? parsed.sortByLatestUpdate
          : DEFAULT_BOOKMARKS_PAGE_SETTINGS.sortByLatestUpdate,
      autoOpenFolderPicker:
        typeof parsed.autoOpenFolderPicker === 'boolean'
          ? parsed.autoOpenFolderPicker
          : DEFAULT_BOOKMARKS_PAGE_SETTINGS.autoOpenFolderPicker,
      matchAllGenres:
        typeof parsed.matchAllGenres === 'boolean'
          ? parsed.matchAllGenres
          : DEFAULT_BOOKMARKS_PAGE_SETTINGS.matchAllGenres,
    };
  } catch {
    return { ...DEFAULT_BOOKMARKS_PAGE_SETTINGS };
  }
}

/** Replace the stored bookmarks-page settings (already validated by the route). */
export function saveBookmarksSettings(settings: BookmarksPageSettings): BookmarksPageSettings {
  const clean: BookmarksPageSettings = {
    cardLayout: coerceCardLayout(settings.cardLayout),
    filtersCollapsed: settings.filtersCollapsed !== false,
    searchOpen: settings.searchOpen === true,
    sortByLatestUpdate: settings.sortByLatestUpdate !== false,
    autoOpenFolderPicker: settings.autoOpenFolderPicker !== false,
    matchAllGenres: settings.matchAllGenres === true,
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
