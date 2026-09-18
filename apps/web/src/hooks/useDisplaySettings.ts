import { useEffect, useState } from 'react';
import {
  loadDisplaySettings,
  saveDisplaySettings,
  type DisplaySettings,
} from '../display/settings';

/**
 * Display settings hook: in-memory state synced to localStorage.
 *
 * The shape mirrors `useDownloadSettings` (state seeded from storage on
 * mount, debounced persistence, pagehide/unmount flush) so every
 * settings surface in the app feels consistent to the user.
 *
 * Settings are a process-wide singleton — every component that calls
 * this hook shares one source of truth, so toggling cover badges on the
 * Bookmarks page re-renders the Latest grid without a navigation. A
 * `storage` event listener also picks up changes from other tabs.
 */
const PERSIST_DEBOUNCE_MS = 250;

let current: DisplaySettings = loadDisplaySettings();
const subscribers = new Set<() => void>();
let saveTimer: number | undefined;

function notify() {
  for (const fn of subscribers) fn();
}

function persist() {
  saveDisplaySettings(current);
}

function update(patch: Partial<DisplaySettings>) {
  current = { ...current, ...patch };
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(persist, PERSIST_DEBOUNCE_MS);
  notify();
}

// Cross-tab sync: another tab changed the same key — reload and re-render.
window.addEventListener('storage', (e: StorageEvent) => {
  if (e.storageArea !== localStorage) return;
  if (e.key === null) {
    // Entire storage cleared — reload defaults.
    current = loadDisplaySettings();
    notify();
    return;
  }
  if (e.key.startsWith('panel-display:')) {
    current = loadDisplaySettings();
    notify();
  }
});

export function useDisplaySettings() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }, []);

  return {
    settings: current,
    update,
  };
}