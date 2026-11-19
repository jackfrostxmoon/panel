import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import type { ReaderSettings } from '@panel/shared';

const DATA_DIR = 'data/reader';
const FILE_PATH = `${DATA_DIR}/panel.json`;

export function loadReaderSettings(): ReaderSettings {
  const defaults: ReaderSettings = {
      mode: 'vertical',
      direction: 'ltr',
      background: 'dark',
      imageWidth: 60,
      imageWidthPx: null,
      imageHeightPx: null,
      pixelSizeEnabled: false,
      showProgressBar: true,
      imageGap: false,
      clearToolbarSpace: true,
      scrollSpeed: 'normal',
      smoothScrollKeys: false,
      imageLoad: 'sequential',
      preloadAhead: 3,
      imageBrightness: 100,
      doublePage: false,
      spreadOddPolicy: 'blank',
      autoScrollDelayMs: 3500,
      showAutoScrollButton: false,
      wheelPagesPerNotch: 0,
      keyPagesPress: 0,
      fitToHeight: false,
      fitToWidth: false,
      autoLandscapeSingle: true,
      dataSaver: false,
      glidePreset: 'quick',
      showScrollbar: false,
      defaultFolderId: null,
      mkImageServer: 'default',
    };
  if (!existsSync(FILE_PATH)) {
    // Return defaults by importing from web settings? We can't import web here easily.
    // Let's construct defaults manually.
    return defaults;
  }
  const raw = readFileSync(FILE_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<ReaderSettings>;
  // Legacy files without the flag infer it from stored pixel sizes so
  // existing setups keep their fixed layout; fresh setups default to off.
  if (parsed.pixelSizeEnabled === undefined) {
    parsed.pixelSizeEnabled = parsed.imageWidthPx != null || parsed.imageHeightPx != null;
  }
  return { ...defaults, ...parsed };
}

export function saveReaderSettings(settings: ReaderSettings): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(FILE_PATH, JSON.stringify(settings, null, 2) + '\n');
}
