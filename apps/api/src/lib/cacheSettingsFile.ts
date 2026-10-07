import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import {
  DEFAULT_CACHE_PAGE_SETTINGS,
  type CachePageSettings,
} from '@panel/shared';

const DATA_DIR = 'data/display';
const FILE_PATH = `${DATA_DIR}/cache.json`;

/** Load the cache-page settings; defaults when the file is missing/invalid. */
export function loadCacheSettings(): CachePageSettings {
  if (!existsSync(FILE_PATH)) return { ...DEFAULT_CACHE_PAGE_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(FILE_PATH, 'utf-8')) as Partial<CachePageSettings>;
    return {
      liveRefresh:
        typeof parsed.liveRefresh === 'boolean'
          ? parsed.liveRefresh
          : DEFAULT_CACHE_PAGE_SETTINGS.liveRefresh,
      autoMemoryRelief:
        typeof parsed.autoMemoryRelief === 'boolean'
          ? parsed.autoMemoryRelief
          : DEFAULT_CACHE_PAGE_SETTINGS.autoMemoryRelief,
      autoMemoryReliefThresholdMb:
        typeof parsed.autoMemoryReliefThresholdMb === 'number' && !Number.isNaN(parsed.autoMemoryReliefThresholdMb)
          ? parsed.autoMemoryReliefThresholdMb
          : DEFAULT_CACHE_PAGE_SETTINGS.autoMemoryReliefThresholdMb,
    };
  } catch {
    return { ...DEFAULT_CACHE_PAGE_SETTINGS };
  }
}

/** Replace the stored cache-page settings (already validated by the route). */
export function saveCacheSettings(settings: CachePageSettings): CachePageSettings {
  const clean: CachePageSettings = {
    liveRefresh: settings.liveRefresh === true,
    autoMemoryRelief: settings.autoMemoryRelief === true,
    autoMemoryReliefThresholdMb: Math.max(20, Math.round(Number(settings.autoMemoryReliefThresholdMb) || 20)),
  };
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(FILE_PATH, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}
