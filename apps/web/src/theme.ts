/**
 * Global app theme (dark/light) — persisted to localStorage and reflected as
 * `data-theme` on <html> so the token overrides in tokens.css apply.
 * Kept separate from reader settings: the reader's background switch only
 * re-skins reading surfaces, not the app shell.
 */
export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'panel-reader:theme:v1';

export function loadTheme(storage: Pick<Storage, 'getItem'> = localStorage): Theme {
  try {
    return storage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function saveTheme(theme: Theme, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage full/blocked — the choice just won't persist. Non-fatal.
  }
}

/** Reflects the choice onto <html>; dark is the default (no attribute). */
export function applyTheme(theme: Theme): void {
  if (theme === 'light') {
    document.documentElement.dataset.theme = 'light';
  } else {
    delete document.documentElement.dataset.theme;
  }
}
