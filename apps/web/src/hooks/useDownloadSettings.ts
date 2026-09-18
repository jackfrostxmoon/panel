import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadDownloadSettings,
  saveDownloadSettings,
  type DownloadSettings,
} from '../download/settings';

/**
 * How long to wait after the last settings change before flushing to
 * localStorage. A segmented click or a number-input keystroke fires one
 * update each, and a synchronous `setItem` per keystroke on mobile shows
 * up as a stutter. Coalescing the writes to once per debounce window
 * keeps the UI responsive.
 */
const PERSIST_DEBOUNCE_MS = 250;

/**
 * Bulk-download settings hook: in-memory state synced to localStorage.
 *
 * The shape mirrors reader settings (state seeded from storage on mount,
 * debounced persistence, pagehide/unmount flush) so both settings surfaces
 * feel consistent to the user.
 */
export function useDownloadSettings(): {
  settings: DownloadSettings;
  update: (patch: Partial<DownloadSettings>) => void;
} {
  const [settings, setSettings] = useState<DownloadSettings>(() => loadDownloadSettings());
  // Mirror the latest settings for the pagehide/unmount flush so the
  // pending debounce window doesn't lose the user's most recent tweak.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Debounced persistence — a rapid burst of patches (clicking through
  // preset segments, typing into the custom field) coalesces into a
  // single localStorage write instead of paying the sync I/O cost on
  // every keystroke.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      saveDownloadSettings(settings);
    }, PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [settings]);

  // Flush pending changes when the tab is hidden or the hook unmounts.
  useEffect(() => {
    const flush = () => saveDownloadSettings(settingsRef.current);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  const update = useCallback((patch: Partial<DownloadSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  return { settings, update };
}
