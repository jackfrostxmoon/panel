import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename as pathBasename } from 'node:path';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';

export type ImageKind = 'cover' | 'chapter';

/** Bounds for a user-supplied custom cap (see `setCustomCapBytes`). */
export const MIN_CUSTOM_CAP_BYTES = 64 * 1024 * 1024;
export const MAX_CUSTOM_CAP_BYTES = 1024 * 1024 * 1024 * 1024;

/**
 * Bounds for a user-supplied upstream-concurrency override (see
 * `setUpstreamConcurrency`). Mirrors the `IMAGE_PROXY_CONCURRENCY` env
 * validation in config.ts so the route and the env agree on the range.
 */
export const MIN_UPSTREAM_CONCURRENCY = 1;
export const MAX_UPSTREAM_CONCURRENCY = 32;

export interface ImageCacheEntry {
  url: string;
  path: string;
  bytes: number;
  contentType: string | null;
}

export interface ImageCacheSizeInfo {
  entryCount: number;
  totalBytes: number;
}

export interface ImageCacheTagSummary {
  tag: string;
  entryCount: number;
  totalBytes: number;
}

/**
 * Resolves a provenance tag (e.g. `mr:solo-leveling.21708` or a chapter id)
 * to the per-panel folder (and, for chapter pages, the chapter subfolder)
 * its files belong in (see `imageCacheFolders.panelFolderName` /
 * `chapterFolderName`). Return null when the tag can't be attributed — the
 * file is written flat in the cache root as before.
 *
 * Read-only by contract: the resolver may look at existing metadata rows to
 * spell folder names, but the cache never stores anything in the database.
 */
export type ImageFolderResolver = (tag: string, kind: ImageKind) => Promise<ImageFolderInfo | null>;

/** Per-tag folder attribution: panel folder + optional chapter subfolder. */
export interface ImageFolderInfo {
  /** e.g. `Title [rk-ab12cd34]`, or null for the flat root. */
  panelFolder: string | null;
  /** e.g. `chapter 1 [ef56ab78]` inside the panel folder, or null. */
  chapterFolder: string | null;
}

export interface ImageCacheDeps {
  dir: string;
  maxFraction: number;
  minBytes: number;
  maxBytes: number;
  /**
   * Max concurrent UPSTREAM image fetches (disk hits bypass the limiter).
   * Cover grids fire dozens of requests at once and each miss buffers a
   * whole image in heap — unbounded concurrency is the transient memory
   * spike. Queued requests wait FIFO. Defaults to 16.
   */
  maxUpstreamConcurrency?: number;
  resolveFolder?: ImageFolderResolver;
  /**
   * Path of the JSON file persisting user-supplied overrides
   * (`{ "maxBytes": number | null, "maxUpstreamConcurrency": number | null }`).
   * Defaults to a sibling of the cache dir (NOT inside it — clear/evict
   * operations must never delete it, and it must not count toward the
   * cached size).
   */
  settingsPath?: string;
}

/**
 * On-disk cache for proxied cover / chapter images.
 *
 * Layout (all names human-browsable in Explorer):
 *   `<Title> [<source>-<hash>]/cover-<tagHash><suffix>.<ext>` — covers
 *   `<Title> [<source>-<hash>]/<chapter label> [<chapterHash>]/NNN.<ext>` —
 *   chapter pages with 1-based, zero-padded page numbers (`001.jpg`, …)
 * Unattributable files (no tag, or a tag with no panel row) stay flat in
 * the cache root with hash names, as do pre-existing chapter files that were
 * grouped into chapter folders by the startup migration (their original page
 * order is unrecoverable from `sha256(<tag>#p<index>)`, so they keep hash
 * names rather than a fabricated order).
 *
 * The `tagHash` (8 hex chars) is `sha256(tag).slice(0,8)` where `tag` is the
 * provenance string passed at write time (e.g. `mk:solo-leveling.21708` for a
 * cover, `mk:solo-leveling.21708~c200` for a chapter). The `entryHash` (56
 * hex chars) is usually `sha256(url).slice(0,56)`; for reader pages the
 * caller passes a STABLE key (`<chapterId>#p<index>`) instead, so the entry
 * keeps its identity even when the source rotates tokenized image URLs.
 * Together tag + entry hashes stay 64 hex chars wide.
 *
 * Numbered page files carry no hash, so they are attributed back to their
 * chapter through the chapter folder's ` [<8hex>]` suffix (same convention
 * as panel folders). Every programmatic operation keys on the filename
 * prefix or that folder suffix — never on a database table. The cache
 * stores NO metadata in the database; folder labels are derived read-only
 * from existing metadata rows at write time, and page numbers from the
 * request's own page index.
 *
 * The tag prefix (or, for numbered pages, the chapter folder's hash suffix)
 * lets us list, size, and selectively delete every file that
 * came from a given source / panel / chapter without scanning the whole
 * directory (folder names are for humans — every programmatic operation
 * still keys on the filename prefix or the folder hash suffix, so it works
 * identically inside folders and in the flat root). The cap is computed relative to the container's
 * available disk at runtime (maxFraction of bavail*bsize, clamped to
 * [minBytes, maxBytes]). Old entries (oldest access time first) are evicted
 * whenever the cap would be exceeded, so a small host disk can never balloon.
 * A user-supplied custom cap (`setCustomCapBytes`, persisted beside the
 * cache dir) replaces the computed value while set.
 *
 * Backward compatibility: files written before the tag format was added
 * (legacy `<kind>-<sha256(url)>` 64-hex-char names) still serve correctly
 * via the legacy read path, but they won't show up in `listTags` and can't
 * be cleared by tag. They get evicted on the cap path eventually; until then
 * they remain anonymous uncategorized entries. New writes always include a
 * tag, so the gap self-heals as the cache churns.
 */
export class ImageCache {
  private readonly inFlight = new Map<string, Promise<ImageCacheEntry>>();

  /**
   * Upstream-fetch semaphore (see `maxUpstreamConcurrency`). Only upstream
   * misses take a slot — `readFromDisk` hits return before this. FIFO queue.
   * Mutable at runtime via `setUpstreamConcurrency` (reader settings panel):
   * lowering it below the in-flight count just pauses new acquisitions
   * until the active fetches drain.
   */
  private upstreamSlots: number;
  private upstreamActive = 0;
  private readonly upstreamQueue: Array<() => void> = [];

  /**
   * Eviction throttle: `evictIfNeeded` walks the whole cache dir twice, so
   * running it on every write turns a 37-page download into 74 full walks.
   * Writes past this either run it (interval elapsed or enough writes
   * accumulated) or skip it — the cap is best-effort anyway.
   */
  private static readonly EVICT_MIN_INTERVAL_MS = 30_000;
  private static readonly EVICT_MIN_WRITES = 20;
  private lastEvictAt = 0;
  private writesSinceEvict = 0;

  /**
   * `sizeInfo` memo: a full kind sizing walks the whole cache dir + stats
   * every file (~500ms on a warm multi-GB cache), and the home badge polls
   * it on a timer — without a memo every poll pays the full walk. Cached
   * per kind for SIZE_TTL_MS; overlapping callers share one in-flight walk.
   * Explicit deletes (`clear*`/`pruneLegacy`) invalidate immediately so the
   * cache-settings page never shows a stale post-clear total. New writes
   * just ride the TTL (the badge undercounts for a few seconds — fine).
   */
  private static readonly SIZE_TTL_MS = 10_000;
  private readonly sizeMemo = new Map<ImageKind, { at: number; info: ImageCacheSizeInfo }>();
  private readonly sizeInflight = new Map<ImageKind, Promise<ImageCacheSizeInfo>>();

  /** Drop memoized kind sizes (called after explicit deletes). */
  private invalidateSizeMemo(): void {
    this.sizeMemo.clear();
  }

  /**
   * In-memory index of every cached file's stem → relative path.
   *
   * Tagged entries (8-hex tag prefix + 56-hex suffix, total 64 hex after
   * the kind) live here keyed by `<kind>-<tagHash><suffix>` (the full
   * stem WITHOUT the file extension — the extension is added by
   * `readFromDisk`'s lookup loop so we don't have to know at read time
   * which extension was used at write time); the value is the path
   * relative to the cache root (`<folder>/<file>` for organized entries,
   * plain `<file>` for flat ones). Legacy entries (no tag prefix) are
   * tracked separately in `legacyIndex` because they have no tag to
   * anchor on.
   *
   * Populated lazily by `ensureIndexPopulated()` on first miss — a
   * single recursive walk of the cache directory fills the maps.
   * Writes (`doFetch`) add to it; deletes (`evictIfNeeded`, `clear`,
   * `clearByTag`, `pruneLegacy`) remove from it. After warm-up,
   * `readFromDisk` is a hashmap hit instead of an O(n) directory scan —
   * the dominant cost of every image response, paid on every page turn
   * in paged mode (Q3 perf: ~50ms/turn on a 5K-entry cache on Windows,
   * several hundred ms on slow filesystems).
   *
   * `null` means "not loaded yet"; `Map` means "loaded".
   */
  private indexStems: Map<string, string> | null = null;
  /**
   * Legacy entries (no tag prefix, 64-hex URL hash directly after the
   * kind prefix) keyed by `<kind>-<urlHash>` (no extension). Reached
   * by the same warm-up walk; lookup is the same O(1) hashmap hit
   * the tagged index gets, but the lookup shape is different so we
   * keep two maps.
   */
  private legacyIndex: Map<string, string> | null = null;

  /**
   * Memoized `ensureDirs()` flag. `mkdir` with `recursive: true` is
   * idempotent but each call still does a syscall — that's
   * ~0.3ms/call on Windows, or ~300ms over 1000 reads (a single
   * chapter's worth). Set once after the first successful mkdir.
   */
  private dirEnsured = false;

  /**
   * Tag → folder-info memo (process lifetime). Folder names embed the
   * stable tag hash, so a panel keeps one folder even if its title is
   * re-cached under a different spelling mid-process; across restarts a
   * renamed title starts a new folder while the old files keep serving
   * through the recursive index until the cap evicts them.
   */
  private folderCache = new Map<string, ImageFolderInfo | null>();
  /** Dirs already created on disk this process (skips repeat mkdirs). */
  private foldersEnsured = new Set<string>();

  /**
   * User-supplied cap override (bytes), replacing the computed
   * disk-relative cap while set. Persisted to `settingsPath` so it
   * survives restarts; `null` means "automatic" (computed from disk).
   */
  private customCapBytes: number | null = null;
  /**
   * User-supplied upstream-concurrency override, replacing the startup
   * (`maxUpstreamConcurrency`) value while set. Same persistence file as
   * the cap override; `null` means "env default".
   */
  private customUpstreamConcurrency: number | null = null;
  /** Startup value — the fallback when no override is set. */
  private readonly defaultUpstreamConcurrency: number;
  private readonly settingsPath: string;

  constructor(private readonly deps: ImageCacheDeps) {
    this.defaultUpstreamConcurrency = Math.max(1, Math.floor(deps.maxUpstreamConcurrency ?? 16));
    this.settingsPath =
      deps.settingsPath ?? join(dirname(deps.dir), '.imagecache-settings.json');
    this.customUpstreamConcurrency = this.loadCustomConcurrency();
    this.upstreamSlots = this.customUpstreamConcurrency ?? this.defaultUpstreamConcurrency;
    this.customCapBytes = this.loadCustomCap();
  }

  /** 8-hex-char hash prefix derived from a provenance tag (kind-independent). */
  tagHash(tag: string): string {
    return createHash('sha256').update(tag).digest('hex').slice(0, 8);
  }

  /** 8-hex-char hash prefix derived from a provenance tag. */
  private tagPrefix(kind: ImageKind, tag: string | null): string {
    if (!tag) return '';
    return this.tagHash(tag);
  }

  /** 56-hex-char hash derived from the upstream URL (drops the `?_retry=` suffix). */
  private urlSuffix(url: string): string {
    return createHash('sha256').update(url).digest('hex').slice(0, 56);
  }

  /**
   * 56-hex-char hash derived from a STABLE cache key (e.g. `<chapterId>#p<index>`).
   * Unlike `urlSuffix`, this survives upstream URL rotations — the same chapter
   * page always maps to the same file even when the site hands out a new
   * tokenized image URL.
   */
  private keySuffix(stableKey: string): string {
    return createHash('sha256').update(stableKey).digest('hex').slice(0, 56);
  }

  private filename(
    kind: ImageKind,
    url: string,
    contentType: string | null,
    tag: string | null,
    stableKey: string | null = null,
  ): string {
    const ext = this.extFor(url, contentType);
    const suffix = stableKey ? this.keySuffix(stableKey) : this.urlSuffix(url);
    return `${kind}-${this.tagPrefix(kind, tag)}${suffix}${ext}`;
  }

  /**
   * Per-panel/chapter folders for a provenance tag, via the injected
   * resolver. Memoized; null (or null fields) means "write flat". The
   * resolver is our own DB-backed lookup, but the result is still validated
   * as safe single path segments so a hostile title can never escape the
   * cache root.
   */
  private async resolveFolder(tag: string, kind: ImageKind): Promise<ImageFolderInfo | null> {
    const cached = this.folderCache.get(tag);
    if (cached !== undefined) return cached;
    let info: ImageFolderInfo | null = null;
    try {
      info = (await this.deps.resolveFolder?.(tag, kind)) ?? null;
    } catch {
      // Resolver failure — fall through to the flat layout below.
    }
    if (info) {
      const validSegment = (s: string | null): string | null =>
        !s || s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.length > 120
          ? null
          : s;
      const panelFolder = validSegment(info.panelFolder);
      // A chapter subfolder is meaningless without its panel folder.
      const chapterFolder = panelFolder ? validSegment(info.chapterFolder) : null;
      info = panelFolder || chapterFolder ? { panelFolder, chapterFolder } : null;
    }
    this.folderCache.set(tag, info);
    return info;
  }

  /**
   * 1-based page number parsed from a reader stable key
   * (`<chapterTag>#p<index>`, 0-based index). Null when the key carries no
   * page index — the entry then uses the hash filename shape.
   */
  private stablePageNumber(stableKey: string | null): number | null {
    if (!stableKey) return null;
    const match = /#p(\d{1,4})$/.exec(stableKey);
    if (!match?.[1]) return null;
    return Number.parseInt(match[1], 10) + 1;
  }

  /** Human page filename: 1-based, zero-padded (`001.jpg`). */
  private pageFilename(pageNumber: number, ext: string): string {
    return `${String(pageNumber).padStart(3, '0')}${ext}`;
  }

  /**
   * Tag hash from a chapter folder's ` [<8hex>]` suffix, or null. Panel
   * folders (` [<source>-<hash>]`) never match — the bare-hash shape is
   * exclusive to chapter folders.
   */
  private chapterDirHash(dirName: string): string | null {
    const match = /\[([0-9a-f]{8})\]$/.exec(dirName);
    return match?.[1] ?? null;
  }

  /** True for human page filenames (`001.jpg`) as opposed to hash names. */
  private isNumberedPage(basename: string): boolean {
    return /^\d+\.\w+$/.test(basename);
  }

  /**
   * Logical kind of a cached file. Hash-prefixed basenames keep their kind
   * prefix; numbered page files inherit the chapter kind from their chapter
   * folder. Null for files that are not ours.
   */
  private fileKind(relPath: string, basename: string): ImageKind | null {
    if (basename.startsWith('cover-')) return 'cover';
    if (basename.startsWith('chapter-')) return 'chapter';
    if (this.isNumberedPage(basename)) {
      const parent = dirname(relPath);
      if (parent !== '.' && this.chapterDirHash(pathBasename(parent))) return 'chapter';
    }
    return null;
  }

  /**
   * Attribute a cached file back to its 8-hex tag hash: the filename prefix
   * for hash-named files, the chapter folder's hash suffix for numbered
   * pages. Null when unattributable (legacy/foreign files).
   */
  private attributeTagHash(kind: ImageKind, relPath: string, basename: string): string | null {
    if (basename.startsWith(`${kind}-`)) {
      const hash = basename.slice(kind.length + 1, kind.length + 9);
      return /^[0-9a-f]{8}$/.test(hash) ? hash : null;
    }
    if (kind === 'chapter' && this.isNumberedPage(basename)) {
      const parent = dirname(relPath);
      if (parent !== '.') return this.chapterDirHash(pathBasename(parent));
    }
    return null;
  }

  /**
   * Every cached file as a root-relative path (`panel/chapter/file`,
   * `panel/file` or `file`), `.tmp` partials excluded. The cache is
   * per-panel folders with per-chapter subfolders plus the legacy flat
   * root — one recursive walk covers all of it.
   */
  private async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (absDir: string, relDir: string): Promise<void> => {
      let dirents;
      try {
        dirents = await readdir(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of dirents) {
        const rel = relDir ? join(relDir, d.name) : d.name;
        if (d.isDirectory()) {
          await walk(join(absDir, d.name), rel);
        } else if (d.isFile() && !d.name.endsWith('.tmp')) {
          out.push(rel);
        }
      }
    };
    await walk(this.deps.dir, '');
    return out;
  }

  /** Remove newly-empty panel/chapter folders (tidiness after clears/eviction). */
  private async pruneEmptyDirs(): Promise<void> {
    // Bottom-up: empty chapter folders go first, then the panel folder when
    // nothing (not even a cover) is left inside it. Never removes the root.
    const clean = async (absDir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of entries) {
        if (d.isDirectory()) await clean(join(absDir, d.name));
      }
      if (absDir === this.deps.dir) return;
      try {
        if ((await readdir(absDir)).length === 0) await rmdir(absDir);
      } catch {
        // Best-effort — a transient error shouldn't fail the caller.
      }
    };
    await clean(this.deps.dir);
  }

  /**
   * Bulk-delete fast path: high parallel delete fan-out plus single-pass
   * index invalidation. Every `await` here yields the event loop, so
   * concurrent detail/image requests keep flowing while a large title
   * clear runs — the previous sequential `await rm` + per-file O(n)
   * index scan held the loop (and the stall in the other tab) for the
   * whole clear. CPU/memory trade-off is intentional: more concurrent
   * rm/stat calls in exchange for wall-clock speed.
   */
  private static readonly BULK_CONCURRENCY = 64;

  private async statSizesParallel(rels: readonly string[]): Promise<{ entryCount: number; totalBytes: number }> {
    let entryCount = 0;
    let totalBytes = 0;
    const C = ImageCache.BULK_CONCURRENCY;
    for (let i = 0; i < rels.length; i += C) {
      const chunk = rels.slice(i, i + C);
      const sizes = await Promise.allSettled(chunk.map((rel) => stat(join(this.deps.dir, rel))));
      for (const r of sizes) {
        if (r.status === 'fulfilled') {
          entryCount += 1;
          totalBytes += r.value.size;
        }
      }
    }
    return { entryCount, totalBytes };
  }

  private async rmParallel(rels: readonly string[]): Promise<string[]> {
    const deleted: string[] = [];
    const C = ImageCache.BULK_CONCURRENCY;
    for (let i = 0; i < rels.length; i += C) {
      const chunk = rels.slice(i, i + C);
      const results = await Promise.allSettled(chunk.map((rel) => rm(join(this.deps.dir, rel), { force: true })));
      results.forEach((r, idx) => {
        const rel = chunk[idx];
        if (r.status === 'fulfilled' && rel !== undefined) deleted.push(rel);
      });
    }
    return deleted;
  }

  /** Single O(n) index pass for a bulk delete (replaces per-file O(n) scans). */
  private indexRemoveMany(relPaths: readonly string[]): void {
    if (this.indexStems === null || this.legacyIndex === null) return;
    if (relPaths.length === 0) return;
    const dead = new Set(relPaths);
    for (const [k, v] of this.indexStems) {
      if (dead.has(v)) this.indexStems.delete(k);
    }
    for (const [k, v] of this.legacyIndex) {
      if (dead.has(v)) this.legacyIndex.delete(k);
    }
  }

  /**
   * Prune only directories that actually lost files (deepest first),
   * instead of re-walking the whole cache tree. Falls back to the full
   * walk when the affected set is empty/unknown.
   */
  private async pruneParentsOf(deleted: readonly string[]): Promise<void> {
    if (deleted.length === 0) return;
    const dirs = new Set<string>();
    for (const rel of deleted) {
      const parent = dirname(rel);
      if (parent && parent !== '.') dirs.add(parent);
    }
    if (dirs.size === 0) return;
    const sorted = Array.from(dirs).sort((a, b) => b.length - a.length);
    for (const relDir of sorted) {
      // Chapter dir first, then its panel parent.
      const parts = relDir.split(/[\\/]/);
      for (let depth = parts.length; depth >= 1; depth -= 1) {
        const abs = join(this.deps.dir, ...parts.slice(0, depth));
        try {
          if ((await readdir(abs)).length === 0) await rmdir(abs);
          else break;
        } catch {
          break;
        }
      }
    }
  }

  /** File extensions the proxy writes — see `extFor`. */
  private readonly KNOWN_EXTS = ['.webp', '.avif', '.png', '.gif', '.jpg', '.jpeg', '.bin'];

  private extFor(url: string, contentType: string | null): string {
    if (contentType) {
      if (contentType.includes('webp')) return '.webp';
      if (contentType.includes('avif')) return '.avif';
      if (contentType.includes('png')) return '.png';
      if (contentType.includes('gif')) return '.gif';
      if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg';
    }
    const ext = extname(new URL(url).pathname).toLowerCase();
    return ['.webp', '.avif', '.png', '.gif', '.jpg', '.jpeg'].includes(ext) ? ext : '.bin';
  }

  async ensureDirs(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(this.deps.dir, { recursive: true });
    this.dirEnsured = true;
  }

  /**
   * Run `fn` holding one upstream slot (FIFO when saturated).
   *
   * `signal` (the reader's client-disconnect signal) unqueues a waiter
   * that hasn't been granted a slot yet, so closing the reader — or
   * hopping to an already-cached chapter — stops feeding abandoned
   * upstream fetches instead of letting them queue behind (and stall)
   * the pages the user actually navigated to.
   */
  private async withUpstreamSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.upstreamActive >= this.upstreamSlots) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const waiter = () => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          if (settled) return;
          settled = true;
          const idx = this.upstreamQueue.indexOf(waiter);
          if (idx >= 0) this.upstreamQueue.splice(idx, 1);
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        this.upstreamQueue.push(waiter);
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
    // The signal may have fired between the grant and here — never start
    // an upstream fetch for a reader that already went away.
    signal?.throwIfAborted();
    this.upstreamActive += 1;
    try {
      return await fn();
    } finally {
      this.upstreamActive -= 1;
      this.upstreamQueue.shift()?.();
    }
  }

  /**
   * Throttled `evictIfNeeded`: at most every 30s or every 20 writes unless
   * forced (custom-cap change). The unthrottled form walks the whole cache
   * directory twice per call.
   */
  private async maybeEvict(force = false): Promise<void> {
    this.writesSinceEvict += 1;
    if (!force) {
      const now = Date.now();
      if (
        now - this.lastEvictAt < ImageCache.EVICT_MIN_INTERVAL_MS &&
        this.writesSinceEvict < ImageCache.EVICT_MIN_WRITES
      ) {
        return;
      }
    }
    this.lastEvictAt = Date.now();
    this.writesSinceEvict = 0;
    await this.evictIfNeeded();
  }

  async getOrCreate(
    url: string,
    fetcher: (signal?: AbortSignal) => Promise<{ bytes: ArrayBuffer; contentType: string | null }>,
    kind: ImageKind,
    tag: string | null = null,
    stableKey: string | null = null,
    signal?: AbortSignal,
  ): Promise<ImageCacheEntry> {
    await this.ensureDirs();
    signal?.throwIfAborted();
    const inFlightKey = `${kind}|${tag ?? ''}|${stableKey ?? ''}|${url}`;
    const existing = this.inFlight.get(inFlightKey);
    if (existing) {
      if (!signal) return existing;
      // Join the shared upstream fetch, but reject for THIS caller when
      // its reader goes away — without disturbing the other waiter(s)
      // sharing the same fetch.
      return await Promise.race([
        existing,
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      ]);
    }

    // Serve from disk if already cached — no upstream hit on revisit. This is
    // what makes covers survive a browser close/reopen (the browser cache is
    // gone in incognito, but the on-disk cache on the server is not).
    const cached = await this.readFromDisk(kind, url, tag, stableKey);
    if (cached) return cached;

    signal?.throwIfAborted();
    const promise = this.withUpstreamSlot(
      () => this.doFetch(url, fetcher, kind, tag, stableKey, signal),
      signal,
    );
    this.inFlight.set(inFlightKey, promise);
    // Delete on settle — NOT in an await-finally — so an aborted joiner
    // racing a shared fetch above never removes an entry other waiters
    // still need.
    const release = () => {
      if (this.inFlight.get(inFlightKey) === promise) this.inFlight.delete(inFlightKey);
    };
    promise.then(release, release);
    return await promise;
  }

  /**
   * Probe-only check: is the page for this (tag, stableKey) tuple on disk
   * right now? Used by the chapter downloader to skip pages that are
   * already cached so a partial previous run can be resumed cheaply without
   * hammering the source (and re-tripping its rate limit). The check mirrors
   * the `readFromDisk` lookup exactly — same folders, same filename — so a
   * "yes" here guarantees `getOrCreate` would return that file immediately
   * on the next call.
   *
   * Returns `false` when no `tag`/`stableKey` is provided (no key to look
   * up by), or when the directory does not exist yet. Cheap: folder
   * resolution is memoized and the hit is a direct stat (a short extension
   * loop), so probing every page of a chapter in parallel stays bounded.
   */
  async hasEntry(
    kind: ImageKind,
    tag: string,
    stableKey: string,
  ): Promise<boolean> {
    if (!tag || !stableKey) return false;
    if (kind === 'chapter') {
      const pageNumber = this.stablePageNumber(stableKey);
      if (pageNumber !== null) {
        return (await this.readNumberedPage(tag, pageNumber)) !== null;
      }
    }
    await this.ensureIndexPopulated();
    if (!this.indexStems) return false;
    const stem = `${kind}-${this.tagPrefix(kind, tag)}${this.keySuffix(stableKey)}`;
    if (this.indexStems.has(stem)) return true;
    // File written by another process after our warm-up — one filtered
    // recursive scan also heals the index as a side effect.
    return (await this.readdirFiltered(kind, tag, stableKey, '')) !== null;
  }

  /**
   * Locate a numbered chapter page (`<panel>/<chapter>/NNN.<ext>`).
   * Returns the root-relative path or null.
   *
   * First tries the memoized folder names directly (a short stat loop over
   * the known extensions); on a miss — e.g. the panel/chapter was renamed
   * since the memo was taken, or another process wrote the file — falls
   * back to one recursive scan matching the chapter folder's hash suffix
   * and the page number.
   */
  private async readNumberedPage(tag: string, pageNumber: number): Promise<string | null> {
    const tagHash = this.tagHash(tag);
    const pageStem = String(pageNumber).padStart(3, '0');
    const folders = await this.resolveFolder(tag, 'chapter');
    if (folders?.panelFolder && folders?.chapterFolder) {
      for (const ext of this.KNOWN_EXTS) {
        const rel = join(folders.panelFolder, folders.chapterFolder, `${pageStem}${ext}`);
        try {
          await stat(join(this.deps.dir, rel));
          return rel;
        } catch {
          // Try the next extension, then the scan fallback below.
        }
      }
    }
    for (const rel of await this.listFiles()) {
      const base = pathBasename(rel);
      if (!base.startsWith(`${pageStem}.`)) continue;
      const parent = dirname(rel);
      if (parent !== '.' && this.chapterDirHash(pathBasename(parent)) === tagHash) return rel;
    }
    return null;
  }

  /**
   * Look up a previously-cached file.
   *
   *   0. Numbered chapter page `<panel>/<chapter>/NNN.<ext>` — the modern
   *      download path. Direct stat via the memoized folders, scan fallback.
   *   1. Stable-key shape `<kind>-<tagHash><keyHash><ext>` — chapter
   *      pages written before numbering (e.g. grouped by the migration).
   *      One Map.get per candidate extension (cheap; the loop stops at the
   *      first hit).
   *   2. Tag-prefixed URL shape `<kind>-<tagHash><urlHash><ext>` —
   *      covers and chapter pages without a stableKey. One Map.get per
   *      candidate extension.
   *   3. Legacy `<kind>-<urlHash><ext>` — files written before the
   *      tag format existed. One Map.get per candidate extension.
   *   4. Cold-start fallback: a single filtered recursive scan that
   *      also populates the index.
   *
   * The first call after process start warms the index via one full
   * walk (an O(n) scan of the cache directory tree). Every subsequent
   * call is O(1) until a new file is written that the index hasn't
   * seen — the write path mirrors `indexWrite` immediately so this is
   * only an issue after a process restart that finds pre-existing
   * files.
   */
  private async readFromDisk(
    kind: ImageKind,
    url: string,
    tag: string | null,
    stableKey: string | null,
  ): Promise<ImageCacheEntry | null> {
    // Numbered chapter pages live outside the stem index (their filenames
    // carry no hash), so they resolve through their folder path instead.
    if (kind === 'chapter' && tag && stableKey) {
      const pageNumber = this.stablePageNumber(stableKey);
      if (pageNumber !== null) {
        const hit = await this.readNumberedPage(tag, pageNumber);
        if (hit) {
          return { url, path: join(this.deps.dir, hit), bytes: 0, contentType: null };
        }
      }
    }
    await this.ensureIndexPopulated();
    if (!this.indexStems || !this.legacyIndex) return null;

    if (tag) {
      const tagHash = this.tagPrefix(kind, tag);
      const suffix = stableKey ? this.keySuffix(stableKey) : this.urlSuffix(url);
      for (const ext of this.KNOWN_EXTS) {
        const stem = `${kind}-${tagHash}${suffix}${ext}`;
        const hit = this.indexStems.get(stem);
        if (hit !== undefined) {
          const fullPath = join(this.deps.dir, hit);
          try {
            await stat(fullPath);
            return { url, path: fullPath, bytes: 0, contentType: null };
          } catch {
            // Manually-deleted file while the server is running — a ghost
            // index entry. Drop it from the index so the next read sees
            // the missing file cleanly, and fall through to re-fetch.
            this.indexStems.delete(stem);
          }
        }
      }
    } else {
      const urlHash = this.urlSuffix(url);
      for (const ext of this.KNOWN_EXTS) {
        const stem = `${kind}-${urlHash}${ext}`;
        const hit = this.legacyIndex.get(stem);
        if (hit !== undefined) {
          const fullPath = join(this.deps.dir, hit);
          try {
            await stat(fullPath);
            return { url, path: fullPath, bytes: 0, contentType: null };
          } catch {
            // Ghost index entry from a manual delete — drop and fall through
            // to the directory scan / re-fetch path below.
            this.legacyIndex.delete(stem);
          }
        }
      }
    }

    // Cold-start or post-restart fallback: a single filtered readdir
    // also populates the index for any matching entry.
    const hit = await this.readdirFiltered(kind, tag, stableKey, url);
    if (hit) {
      return { url, path: join(this.deps.dir, hit), bytes: 0, contentType: null };
    }
    return null;
  }

  private async doFetch(
    url: string,
    fetcher: (signal?: AbortSignal) => Promise<{ bytes: ArrayBuffer; contentType: string | null }>,
    kind: ImageKind,
    tag: string | null,
    stableKey: string | null = null,
    signal?: AbortSignal,
  ): Promise<ImageCacheEntry> {
    const { bytes, contentType } = await fetcher(signal);
    const ext = this.extFor(url, contentType);
    // Organize attributable files into per-panel folders (and chapter
    // pages into chapter subfolders with human page names); unattributable
    // ones (no tag, or a tag with no panel row) stay flat as before.
    const folders = tag ? await this.resolveFolder(tag, kind) : null;
    let dir = this.deps.dir;
    let filename: string;
    let relPath: string;
    const pageNumber = kind === 'chapter' ? this.stablePageNumber(stableKey) : null;
    if (pageNumber !== null && folders?.panelFolder && folders?.chapterFolder) {
      dir = join(this.deps.dir, folders.panelFolder, folders.chapterFolder);
      const key = join(folders.panelFolder, folders.chapterFolder);
      if (!this.foldersEnsured.has(key)) {
        await mkdir(dir, { recursive: true });
        this.foldersEnsured.add(key);
      }
      filename = this.pageFilename(pageNumber, ext);
      relPath = join(folders.panelFolder, folders.chapterFolder, filename);
    } else {
      const hashName = this.filename(kind, url, contentType, tag, stableKey);
      filename = hashName;
      if (folders?.panelFolder) {
        dir = join(this.deps.dir, folders.panelFolder);
        if (!this.foldersEnsured.has(folders.panelFolder)) {
          await mkdir(dir, { recursive: true });
          this.foldersEnsured.add(folders.panelFolder);
        }
        relPath = join(folders.panelFolder, filename);
      } else {
        relPath = filename;
      }
    }
    const tmpPath = join(dir, `${filename}.tmp`);
    const finalPath = join(dir, filename);
    // Zero-copy view: `Buffer.from(arrayBuffer)` would duplicate the whole
    // image in heap (the fetcher already holds the ArrayBuffer). `writeFile`
    // accepts the Uint8Array view directly.
    await writeFile(tmpPath, new Uint8Array(bytes));
    await rm(finalPath, { force: true });
    await rename(tmpPath, finalPath);
    // Mirror the new file into the in-memory index so the next read is
    // a hashmap hit instead of a directory scan (see readFromDisk).
    // Skip when the index hasn't been warmed yet — the first walk
    // will pick this file up naturally. (Numbered pages resolve through
    // their folder path rather than the index, so they are not tracked.)
    this.indexWrite(relPath);
    await this.maybeEvict();
    return { url, path: finalPath, bytes: bytes.byteLength, contentType };
  }

  /**
   * Add a freshly written file to the index. Takes the root-relative path
   * (`folder/file` or `file`). No-op if the index hasn't been warmed yet
   * (the first walk will discover the file naturally and call
   * `indexFile`).
   */
  private indexWrite(relPath: string): void {
    if (this.indexStems === null || this.legacyIndex === null) return;
    this.indexFile(relPath);
  }

  /**
   * Remove a deleted file from the index. Takes the root-relative path
   * (symmetric to `indexWrite`). No-op if the index hasn't been warmed
   * (deletes before warm-up are reconciled on the first walk).
   *
   * We can't easily delete "the bucket whose value is this path" —
   * we'd have to scan all entries. Instead, the deletion paths
   * (`evictIfNeeded`, `clear`, `clearByTag`, `pruneLegacy`) invalidate
   * the entire affected portion of the index and let the next read
   * rebuild it via `ensureIndexPopulated`. That's a one-time O(n)
   * walk cost per bulk-delete, which is acceptable because bulk
   * deletes are rare.
   *
   * The single-file `rm` inside `doFetch`'s "remove old version
   * before rename" call doesn't go through here because that path
   * doesn't delete cache state — it removes a stale version of the
   * same key that's about to be replaced.
   */
  private indexRemove(relPath: string): void {
    if (this.indexStems === null || this.legacyIndex === null) return;
    // Scan the index for any key whose value is this path. Cheap
    // enough for the (rare) single-file delete path.
    for (const [k, v] of this.indexStems) {
      if (v === relPath) this.indexStems.delete(k);
    }
    for (const [k, v] of this.legacyIndex) {
      if (v === relPath) this.legacyIndex.delete(k);
    }
  }

  /**
   * Build the in-memory index from a single recursive walk of the cache
   * directory (per-panel folders + flat root). Idempotent: re-running it
   * leaves existing entries alone. The first call after process start
   * pays the walk cost; subsequent reads are O(1) hashmap hits.
   */
  private async ensureIndexPopulated(): Promise<void> {
    if (this.indexStems !== null && this.legacyIndex !== null) return;
    if (this.indexStems === null) this.indexStems = new Map();
    if (this.legacyIndex === null) this.legacyIndex = new Map();
    for (const rel of await this.listFiles()) {
      this.indexFile(rel);
    }
  }

  /**
   * Add one on-disk file to the appropriate index. Takes the root-relative
   * path; only the basename is matched. Tagged entries (8-hex tag prefix +
   * 56-hex suffix) go into `indexStems` keyed by `<kind>-<tagHash><suffix>`
   * (the full stem including the URL hash or stableKey hash, but no
   * extension). Legacy entries (no tag, 64-hex URL hash directly after the
   * kind prefix) go into `legacyIndex` keyed by `<kind>-<urlHash>` (no
   * extension).
   *
   * The key doesn't include the file extension because the proxy
   * doesn't know at read time which extension was used at write
   * time (the upstream may have sent `image/webp` for a URL ending in
   * `.jpg`, etc.). Read-side lookups try each known extension and
   * stop at the first hit — see `readFromDisk`.
   *
   * Silently ignores filenames that don't match either shape — those
   * aren't ours (e.g. lock files from a crashed process, leftover
   * partial writes that escaped the `.tmp` cleanup), plus numbered
   * chapter pages (`001.jpg`), which resolve through their chapter
   * folder path instead of this index.
   */
  private indexFile(relPath: string): void {
    if (!this.indexStems || !this.legacyIndex) return;
    const filename = pathBasename(relPath);
    const taggedMatch = /^(cover|chapter)-([0-9a-f]{8})([0-9a-f]{56})\.\w+$/.exec(filename);
    if (taggedMatch) {
      const [, kind, tagHash, suffix] = taggedMatch;
      // Strip the trailing extension from the suffix to keep the key
      // extension-agnostic. The full relative path (with its actual
      // extension) is the value.
      const stem = `${kind}-${tagHash}${suffix}`;
      this.indexStems.set(stem, relPath);
      return;
    }
    const legacyMatch = /^(cover|chapter)-([0-9a-f]{64})\.\w+$/.exec(filename);
    if (legacyMatch) {
      const [, kind, urlHash] = legacyMatch;
      const stem = `${kind}-${urlHash}`;
      this.legacyIndex.set(stem, relPath);
    }
  }

  /**
   * Slow-path recursive scan filtered to a single lookup tuple. Used when
   * the index miss suggests a file might exist that wasn't indexed yet
   * (e.g. written by another process or by a pre-index build).
   * Returns the matching root-relative path or `null`. Adds the
   * discovered file to the index as a side effect.
   */
  private async readdirFiltered(
    kind: ImageKind,
    tag: string | null,
    stableKey: string | null,
    url: string,
  ): Promise<string | null> {
    const entries = await this.listFiles();
    const urlHash = url ? this.urlSuffix(url) : '';
    const tagHash = this.tagPrefix(kind, tag);
    for (const rel of entries) {
      const e = pathBasename(rel);
      if (tag && stableKey) {
        const exactPrefix = `${kind}-${tagHash}${this.keySuffix(stableKey)}`;
        if (e.startsWith(exactPrefix)) {
          this.indexFile(rel);
          return rel;
        }
      } else if (tag) {
        const exactPrefix = `${kind}-${tagHash}`;
        if (e.startsWith(exactPrefix) && e.includes(urlHash)) {
          this.indexFile(rel);
          return rel;
        }
      } else {
        const legacyPrefix = `${kind}-${urlHash}`;
        if (e.startsWith(legacyPrefix)) {
          this.indexFile(rel);
          return rel;
        }
      }
    }
    return null;
  }

  /** The effective cap: the custom override while set, else the computed disk-relative cap. */
  getCapBytes(): number {
    return this.customCapBytes ?? this.computeCap();
  }

  /** The computed disk-relative cap (bavail*bsize * maxFraction, clamped) — the "automatic" value. */
  getComputedCapBytes(): number {
    return this.computeCap();
  }

  /** The persisted custom override, or null when the automatic cap applies. */
  getCustomCapBytes(): number | null {
    return this.customCapBytes;
  }

  /** Effective upstream concurrency: the override while set, else the startup default. */
  getUpstreamConcurrency(): number {
    return this.upstreamSlots;
  }

  /** The persisted concurrency override, or null when the env default applies. */
  getCustomUpstreamConcurrency(): number | null {
    return this.customUpstreamConcurrency;
  }

  /** The startup (`maxUpstreamConcurrency`) fallback. */
  getDefaultUpstreamConcurrency(): number {
    return this.defaultUpstreamConcurrency;
  }

  /**
   * Set (`n`) or clear (`null`, back to the env default) the upstream-
   * concurrency override. Persisted to disk immediately and enforced at
   * once — lowering it below the in-flight count just pauses new
   * acquisitions until active fetches drain. Returns the effective value.
   * Range validation lives in the route; values outside
   * [MIN_UPSTREAM_CONCURRENCY, MAX_UPSTREAM_CONCURRENCY] throw.
   */
  async setUpstreamConcurrency(n: number | null): Promise<number> {
    if (n !== null) {
      if (!Number.isInteger(n) || n < MIN_UPSTREAM_CONCURRENCY || n > MAX_UPSTREAM_CONCURRENCY) {
        throw new Error(
          `Upstream concurrency must be an integer between ${MIN_UPSTREAM_CONCURRENCY} and ${MAX_UPSTREAM_CONCURRENCY}.`,
        );
      }
    }
    this.customUpstreamConcurrency = n;
    this.upstreamSlots = n ?? this.defaultUpstreamConcurrency;
    await this.persistSettings();
    return this.upstreamSlots;
  }

  /**
   * Set (`bytes`) or clear (`null`) the custom cap override. Persisted to
   * disk immediately and enforced at once — lowering the cap below current
   * usage evicts cold entries right away instead of waiting for the next
   * write. Returns the effective cap. Range validation lives in the route;
   * values outside [MIN_CUSTOM_CAP_BYTES, MAX_CUSTOM_CAP_BYTES] throw.
   */
  async setCustomCapBytes(bytes: number | null): Promise<number> {
    if (bytes !== null) {
      if (!Number.isInteger(bytes) || bytes < MIN_CUSTOM_CAP_BYTES || bytes > MAX_CUSTOM_CAP_BYTES) {
        throw new Error(
          `Custom cap must be an integer between ${MIN_CUSTOM_CAP_BYTES} and ${MAX_CUSTOM_CAP_BYTES} bytes.`,
        );
      }
    }
    this.customCapBytes = bytes;
    await this.persistCustomCap();
    await this.maybeEvict(true);
    return this.getCapBytes();
  }

  private loadCustomCap(): number | null {
    try {
      if (!existsSync(this.settingsPath)) return null;
      const raw = JSON.parse(readFileSync(this.settingsPath, 'utf-8')) as { maxBytes?: unknown };
      const value = raw.maxBytes;
      if (value === null || value === undefined) return null;
      if (typeof value !== 'number' || !Number.isInteger(value)) return null;
      if (value < MIN_CUSTOM_CAP_BYTES || value > MAX_CUSTOM_CAP_BYTES) return null;
      return value;
    } catch {
      // Corrupt/unreadable settings — fall back to automatic.
      return null;
    }
  }

  private loadCustomConcurrency(): number | null {
    try {
      if (!existsSync(this.settingsPath)) return null;
      const raw = JSON.parse(readFileSync(this.settingsPath, 'utf-8')) as {
        maxUpstreamConcurrency?: unknown;
      };
      const value = raw.maxUpstreamConcurrency;
      if (value === null || value === undefined) return null;
      if (typeof value !== 'number' || !Number.isInteger(value)) return null;
      // Out-of-range (e.g. written by a newer client) is ignored rather
      // than clamped, so the startup default applies instead of a surprise.
      if (value < MIN_UPSTREAM_CONCURRENCY || value > MAX_UPSTREAM_CONCURRENCY) return null;
      return value;
    } catch {
      // Corrupt/unreadable settings — fall back to the startup default.
      return null;
    }
  }

  private async persistCustomCap(): Promise<void> {
    await this.persistSettings();
  }

  private async persistSettings(): Promise<void> {
    await mkdir(dirname(this.settingsPath), { recursive: true });
    await writeFile(
      this.settingsPath,
      JSON.stringify(
        { maxBytes: this.customCapBytes, maxUpstreamConcurrency: this.customUpstreamConcurrency },
        null,
        2,
      ) + '\n',
    );
  }

  private computeCap(): number {
    const { maxFraction, minBytes, maxBytes } = this.deps;
    let available: number;
    try {
      const stats = statfsSync(this.deps.dir);
      if (!stats?.bsize) return maxBytes;
      available = stats.bavail * stats.bsize;
    } catch {
      return maxBytes;
    }
    const cap = Math.floor(available * maxFraction);
    return Math.max(minBytes, Math.min(maxBytes, cap));
  }

  private async dirSize(): Promise<number> {
    const rels = await this.listFiles();
    let total = 0;
    const C = ImageCache.BULK_CONCURRENCY;
    for (let i = 0; i < rels.length; i += C) {
      const sizes = await Promise.allSettled(rels.slice(i, i + C).map((rel) => stat(join(this.deps.dir, rel))));
      for (const r of sizes) {
        if (r.status === 'fulfilled') total += r.value.size;
      }
    }
    return total;
  }

  private async evictIfNeeded(): Promise<void> {
    const cap = this.getCapBytes();
    const total = await this.dirSize();
    if (total <= cap) return;

    try {
      const rels = await this.listFiles();
      const metas: Array<{ path: string; rel: string; atime: number; mtime: number; size: number }> = [];
      const C = ImageCache.BULK_CONCURRENCY;
      for (let i = 0; i < rels.length; i += C) {
        const chunk = rels.slice(i, i + C);
        const stats = await Promise.allSettled(chunk.map((rel) => stat(join(this.deps.dir, rel))));
        stats.forEach((r, idx) => {
          const rel = chunk[idx];
          if (r.status === 'fulfilled' && rel !== undefined) {
            metas.push({ path: join(this.deps.dir, rel), rel, atime: r.value.atimeMs, mtime: r.value.mtimeMs, size: r.value.size });
          }
        });
      }
      const files = metas
        // Oldest access time first — evict cold entries.
        .sort((a, b) => a.atime - b.atime || a.mtime - b.mtime);

      let remaining = total;
      const evicted: string[] = [];
      for (const e of files) {
        if (remaining <= cap) break;
        try {
          await rm(e.path, { force: true });
          evicted.push(e.rel);
          remaining -= e.size;
        } catch {
          // Best-effort per file.
        }
      }
      // Mirror the eviction into the in-memory index so subsequent
      // reads don't try to look up a path that's no longer on
      // disk. The directory-scan fallback in `readFromDisk` would
      // catch this anyway, but removing eagerly keeps the index
      // honest.
      this.indexRemoveMany(evicted);
      await this.pruneParentsOf(evicted);
    } catch {
      // Eviction is best-effort — a transient error shouldn't fail the write.
    }
  }

  async sizeInfo(kind: ImageKind): Promise<ImageCacheSizeInfo> {
    const now = Date.now();
    const memo = this.sizeMemo.get(kind);
    if (memo && now - memo.at < ImageCache.SIZE_TTL_MS) return memo.info;
    const inflight = this.sizeInflight.get(kind);
    if (inflight) return inflight;
    const work = this.computeSizeInfo(kind).then(
      (info) => {
        this.sizeMemo.set(kind, { at: Date.now(), info });
        this.sizeInflight.delete(kind);
        return info;
      },
      (error: unknown) => {
        this.sizeInflight.delete(kind);
        throw error;
      },
    );
    this.sizeInflight.set(kind, work);
    return work;
  }

  private async computeSizeInfo(kind: ImageKind): Promise<ImageCacheSizeInfo> {
    await this.ensureDirs();
    const matching: string[] = [];
    for (const rel of await this.listFiles()) {
      const e = pathBasename(rel);
      if (this.fileKind(rel, e) !== kind) continue;
      matching.push(rel);
    }
    return this.statSizesParallel(matching);
  }

  /**
   * Aggregate per-tag size breakdown for the given kind. Reads the directory
   * once, groups by the 8-hex-char tag prefix (or, for numbered chapter
   * pages, the chapter folder's hash suffix), and returns one row per tag.
   * The `tag` field is the 8-hex hash; callers that want the original
   * provenance string need to keep a separate map (we don't reverse the
   * hash because it's not necessary for clear-by-tag — we filter by
   * prefix/suffix instead). Legacy files (no tag prefix) are skipped.
   */
  async listTags(kind: ImageKind): Promise<ImageCacheTagSummary[]> {
    await this.ensureDirs();
    const tagMap = new Map<string, { entryCount: number; totalBytes: number }>();
    const bucket = new Map<string, string[]>();
    for (const rel of await this.listFiles()) {
      const e = pathBasename(rel);
      if (this.fileKind(rel, e) !== kind) continue;
      // Tag hash from the `<kind>-` filename prefix, or from the chapter
      // folder suffix for numbered pages. Legacy files (64-hex-char URL
      // hash directly after kind prefix, no folder suffix) have no tag;
      // skip them so they don't pollute the per-tag breakdown.
      const tagHash = this.attributeTagHash(kind, rel, e);
      if (!tagHash) continue;
      const arr = bucket.get(tagHash) ?? [];
      arr.push(rel);
      bucket.set(tagHash, arr);
    }
    const C = ImageCache.BULK_CONCURRENCY;
    for (const [tagHash, rels] of bucket) {
      const row = { entryCount: 0, totalBytes: 0 };
      for (let i = 0; i < rels.length; i += C) {
        const sizes = await Promise.allSettled(rels.slice(i, i + C).map((rel) => stat(join(this.deps.dir, rel))));
        for (const r of sizes) {
          if (r.status === 'fulfilled') {
            row.entryCount += 1;
            row.totalBytes += r.value.size;
          }
        }
      }
      tagMap.set(tagHash, row);
    }
    return Array.from(tagMap.entries())
      .map(([tag, v]) => ({ tag, ...v }))
      .sort((a, b) => b.totalBytes - a.totalBytes);
  }

  /** Size of every file matching the given tag (filename prefix or chapter folder). */
  async sizeInfoByTag(kind: ImageKind, tag: string): Promise<ImageCacheSizeInfo> {
    await this.ensureDirs();
    const tagHash = this.tagPrefix(kind, tag);
    const matching: string[] = [];
    for (const rel of await this.listFiles()) {
      const e = pathBasename(rel);
      if (this.fileKind(rel, e) !== kind) continue;
      if (this.attributeTagHash(kind, rel, e) !== tagHash) continue;
      matching.push(rel);
    }
    return this.statSizesParallel(matching);
  }

  /**
   * Size of every file matching ANY of the given provenance tags, grouped per
   * tag. Reads the directory once (instead of one readdir per tag, which the
   * per-panel "total" view would otherwise need) and returns one row per
   * requested tag — tags with no cached files come back at zero so the caller
   * can render a stable "0 B / 0 files" row instead of omitting the panel.
   *
   * Used by the cache-settings page to show each bookmarked panel's total
   * cached footprint (cover + chapter pages) without N round-trips.
   */
  async sizeInfoByTagSum(
    kind: ImageKind,
    tags: readonly string[],
  ): Promise<ImageCacheTagSummary[]> {
    await this.ensureDirs();
    const wanted = new Set(tags.map((t) => this.tagPrefix(kind, t)));
    const result = new Map<string, ImageCacheTagSummary>();
    const bucket = new Map<string, string[]>();
    for (const tag of tags) {
      const hash = this.tagPrefix(kind, tag);
      result.set(hash, { tag: hash, entryCount: 0, totalBytes: 0 });
      bucket.set(hash, []);
    }
    for (const rel of await this.listFiles()) {
      const e = pathBasename(rel);
      if (this.fileKind(rel, e) !== kind) continue;
      // Tag hash from the filename prefix, or from the chapter folder
      // suffix for numbered pages. Legacy files (no tag hash anywhere)
      // are skipped so they don't pollute the per-tag breakdown.
      const tagHash = this.attributeTagHash(kind, rel, e);
      if (!tagHash || !wanted.has(tagHash)) continue;
      bucket.get(tagHash)!.push(rel);
    }
    const C = ImageCache.BULK_CONCURRENCY;
    for (const [hash, rels] of bucket) {
      const row = result.get(hash)!;
      for (let i = 0; i < rels.length; i += C) {
        const sizes = await Promise.allSettled(rels.slice(i, i + C).map((rel) => stat(join(this.deps.dir, rel))));
        for (const r of sizes) {
          if (r.status === 'fulfilled') {
            row.entryCount += 1;
            row.totalBytes += r.value.size;
          }
        }
      }
    }
    return Array.from(result.values());
  }

  async clear(kind: ImageKind): Promise<ImageCacheSizeInfo> {
    await this.ensureDirs();
    const matching: string[] = [];
    for (const rel of await this.listFiles()) {
      const e = pathBasename(rel);
      if (this.fileKind(rel, e) !== kind) continue;
      matching.push(rel);
    }
    const info = await this.statSizesParallel(matching);
    if (info.entryCount === 0) return info;
    try {
      const deleted = await this.rmParallel(matching);
      this.indexRemoveMany(deleted);
      this.invalidateSizeMemo();
      await this.pruneParentsOf(deleted);
    } catch {
      // Clearing is best-effort — a transient error shouldn't fail the call.
    }
    return info;
  }

  /**
   * Clear every file matching the given provenance tag. The tag is hashed
   * the same way as on write, so the caller passes the original provenance
   * string (e.g. `mk:solo-leveling.21708`) and we find all matching files by
   * their 8-hex filename prefix — or, for numbered chapter pages, by their
   * chapter folder's hash suffix. Single directory walk + parallel
   * stat/rm (no second walk, no per-file index scan).
   */
  async clearByTag(kind: ImageKind, tag: string): Promise<ImageCacheSizeInfo> {
    return this.clearByTags(kind, [tag]);
  }

  /**
   * Clear every file matching ANY of the given provenance tags in a single
   * directory walk. Used for panel clears (panel id + all its chapter ids)
   * so a 500-chapter title pays one walk instead of 500+ walks.
   */
  async clearByTags(kind: ImageKind, tags: readonly string[]): Promise<ImageCacheSizeInfo> {
    await this.ensureDirs();
    if (tags.length === 0) return { entryCount: 0, totalBytes: 0 };
    const wanted = new Set(tags.map((t) => this.tagPrefix(kind, t)));
    const prefixes = new Set(Array.from(wanted, (h) => `${kind}-${h}`));
    const matching: string[] = [];
    for (const rel of await this.listFiles()) {
      const e = pathBasename(rel);
      if (this.fileKind(rel, e) !== kind) continue;
      let matched = false;
      for (const prefix of prefixes) {
        if (e.startsWith(prefix)) {
          matched = true;
          break;
        }
      }
      if (!matched && kind === 'chapter' && this.isNumberedPage(e)) {
        // Numbered pages carry no hash in the filename — match the chapter
        // folder's hash suffix instead.
        const h = this.attributeTagHash(kind, rel, e);
        if (h && wanted.has(h)) matched = true;
      }
      if (matched) matching.push(rel);
    }
    const info = await this.statSizesParallel(matching);
    if (info.entryCount === 0) return info;
    try {
      const deleted = await this.rmParallel(matching);
      this.indexRemoveMany(deleted);
      this.invalidateSizeMemo();
      await this.pruneParentsOf(deleted);
    } catch {
      // Clearing is best-effort — a transient error shouldn't fail the call.
    }
    return info;
  }

  async clearAll(): Promise<ImageCacheSizeInfo> {
    const a = this.clear('cover');
    const b = this.clear('chapter');
    const [ra, rb] = await Promise.all([a, b]);
    return { entryCount: ra.entryCount + rb.entryCount, totalBytes: ra.totalBytes + rb.totalBytes };
  }

  /**
   * Remove LEGACY cache entries: files whose name carries only the 64-hex
   * URL hash after the kind prefix (written before the tag format existed).
   * They never show up in `listTags` / `sizeInfoByTag*`, can't be cleared by
   * tag, and the URL they were keyed by has usually been rotated away by
   * tokenized sources — so they're invisible dead weight on the cap.
   * Tagged entries (current and old URL-keyed ones) are kept.
   */
  async pruneLegacy(): Promise<ImageCacheSizeInfo> {
    await this.ensureDirs();
    const matching: string[] = [];
    for (const rel of await this.listFiles()) {
      const e = pathBasename(rel);
      // A tagged entry has an 8-hex tag hash right after `<kind>-`
      // followed by 56 more hex chars (64 total). Legacy entries have
      // the 64-hex URL hash directly after the prefix — same total
      // width, so match the tagged shape explicitly instead.
      if (/^(cover|chapter)-[0-9a-f]{8}[0-9a-f]{56}\.\w+$/.test(e)) continue;
      if (!/^(cover|chapter)-[0-9a-f]{64}\.\w+$/.test(e)) continue;
      matching.push(rel);
    }
    const info = await this.statSizesParallel(matching);
    try {
      const deleted = await this.rmParallel(matching);
      this.indexRemoveMany(deleted);
      this.invalidateSizeMemo();
      await this.pruneParentsOf(deleted);
      return { entryCount: deleted.length, totalBytes: info.totalBytes };
    } catch {
      /* best-effort */
      return info;
    }
  }
}