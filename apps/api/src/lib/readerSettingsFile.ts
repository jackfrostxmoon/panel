import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import type { ReaderSettings } from '@panel/shared';

const DATA_DIR = 'data/reader';
const FILE_PATH = `${DATA_DIR}/panel.json`;

export function loadReaderSettings(): ReaderSettings {
  if (!existsSync(FILE_PATH)) {
    // Return defaults by importing from web settings? We can't import web here easily.
    // Let's construct defaults manually.
    return {
      mode: 'vertical',
      direction: 'ltr',
      background: 'dark',
      imageWidth: 60,
      imageWidthPx: null,
      imageHeightPx: null,
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
      wheelPagesPerNotch: 0,
      keyPagesPress: 0,
      zoomLevel: 1,
      autoLandscapeSingle: true,
      dataSaver: false,
      glidePreset: 'quick',
      showScrollbar: false,
      defaultFolderId: null,
    };
  }
  const raw = readFileSync(FILE_PATH, 'utf-8');
  return JSON.parse(raw) as ReaderSettings;
}

export function saveReaderSettings(settings: ReaderSettings): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(FILE_PATH, JSON.stringify(settings, null, 2) + '\n');
}
