import { ErrorCodes, parseGlobalId, type GenreLookup, type PanelSource } from '@panel/shared';
import type { AppConfig } from '../config.js';
import { AppError } from '../lib/errors.js';
import { MangaKatanaSource } from './mangakatana/MangaKatanaSource.js';
import { NihonKuniSource } from './nihonkuni/NihonKuniSource.js';
import { RawkumaSource } from './rawkuma/RawkumaSource.js';
import { RawSakuraSource } from './rawsakura/RawSakuraSource.js';
import { HiperdexSource } from './hiperdex/HiperdexSource.js';
import { MangaReadSource } from './mangaread/MangaReadSource.js';
import { ToonilySource } from './toonily/ToonilySource.js';
import { RawdexSource } from './rawdex/RawdexSource.js';
import { KaliscanSource } from './kaliscan/KaliscanSource.js';
import { RawUwUSource } from './rawuwu/RawUwUSource.js';
import { RoliaScanSource } from './roliascan/RoliaScanSource.js';

/**
 * Source registry — maps global id prefixes ("mk:...") to source adapters.
 *
 * Adding another source = implement PanelSource, then add one line here.
 * The rest of the application never references a concrete source class.
 */
export class SourceRegistry {
  private readonly sources = new Map<string, PanelSource>();

  register(source: PanelSource): void {
    this.sources.set(source.name, source);
  }

  /** Resolve a source by its name/prefix. Throws UNKNOWN_SOURCE. */
  get(name: string): PanelSource {
    const source = this.sources.get(name);
    if (!source) {
      throw new AppError(ErrorCodes.UNKNOWN_SOURCE, `Unknown panel source: "${name}".`);
    }
    return source;
  }

  /** Resolve the source responsible for a global id ("mk:..."). */
  forGlobalId(globalId: string): { source: PanelSource; nativeId: string } {
    const parsed = parseGlobalId(globalId);
    if (!parsed) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed id — expected "<source>:<id>".', {
        id: globalId,
      });
    }
    return { source: this.get(parsed.source), nativeId: parsed.nativeId };
  }

  list(): PanelSource[] {
    return [...this.sources.values()];
  }

  /**
   * Fan out the runtime performance-mode profile to every adapter (see
   * `PanelSource.setPerformanceMode`). Adapters without the hook keep
   * their construction values — never throws, so one adapter can never
   * break the toggle for the rest.
   */
  setPerformanceModeAll(on: boolean): void {
    for (const source of this.sources.values()) {
      try {
        source.setPerformanceMode?.(on);
      } catch {
        // Best-effort per adapter.
      }
    }
  }
}

export function createSourceRegistry(
  config: AppConfig,
  deps?: { findGenres?: GenreLookup },
): SourceRegistry {
  const registry = new SourceRegistry();
  const findGenres = deps?.findGenres;
  registry.register(new MangaKatanaSource(config.sources.mangakatana));
  registry.register(new NihonKuniSource(config.sources.nihonkuni, undefined, findGenres));
  registry.register(new RawkumaSource(config.sources.rawkuma, undefined, findGenres));
  registry.register(new RawSakuraSource(config.sources.rawsakura, undefined, findGenres));
  registry.register(new HiperdexSource(config.sources.hiperdex));
  registry.register(new MangaReadSource(config.sources.mangaread, undefined, findGenres));
  registry.register(new ToonilySource(config.sources.toonily, undefined, findGenres));
  registry.register(new RawdexSource(config.sources.rawdex, undefined, findGenres));
  registry.register(new KaliscanSource(config.sources.kaliscan));
  registry.register(new RawUwUSource(config.sources.rawuwu, undefined, findGenres));
  registry.register(new RoliaScanSource(config.sources.roliascan));
  return registry;
}
