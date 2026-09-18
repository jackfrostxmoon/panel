import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename as pathBasename } from 'node:path';
import { existsSync, readFileSync, statSync, statfsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';

export type ImageKind = 'cover' | 'chapter';

/** Bounds for a user-supplied custom cap (see `setCustomCapBytes`). */
export const MIN_CUSTOM_CAP_BYTES = 64 * 1024 * 1024;
export const MAX_CUSTOM_CAP_BYTES = 1024 * 1024 * 1024 * 1024;

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
 * to the per-panel folder name its files belong in (see
 * `imageCacheFolders.panelFolderName`). Return null when the tag can't be
 * attributed — the file is written flat in the cache root as before.
 */
export type ImageFolderResolver = (tag: string, kind: ImageKind) => Promise<string | null>;

export interface ImageCacheDeps {
  dir: string;
  maxFraction: number;
  minBytes: number;
  maxBytes: number;
  resolveFolder?: ImageFolderResolver;
  /**
   * Path of the JSON file persisting the user-supplied custom cap
   * (`{ "maxBytes": number | null }`). Defaults to a sibling of the cache
   * dir (NOT inside it — clear/evict operations must never delete it, and
   * it must not count toward the cached size).
   */
  settingsPath?: string;
}

/**
 * On-disk cache for proxied cover / chapter images.
 *
 * Files are named `<kind>-<tagHash><entryHash>.<ext>` and live in per-panel
 * folders (`<Title> [<source>-<hash>]/`, see `imageCacheFolders`) when the
 * write-time provenance tag can be attributed to a panel; unattributable
 * files (no tag, or a tag with no panel row) stay flat in the cache root.
 * The `tagHash` (8 hex chars) is `sha256(tag).slice(0,8)` where `tag` is the
 * provenance string passed at write time (e.g. `mk:solo-leveling.21708` for a
 * cover, `mk:solo-leveling.21708~c200` for a chapter). The `entryHash` (56
 * hex chars) is usually `sha256(url).slice(0,56)`; for reader pages the
 * caller passes a STABLE key (`<chapterId>#p<index>`) instead, so the entry
 * keeps its identity even when the source rotates tokenized image URLs.
 * Together tag + entry hashes stay 64 hex chars wide.
 *
 * The tag prefix lets us list, size, and selectively delete every file that
 * came from a given source / panel / chapter without scanning the whole
 * directory (folder names are for humans — every programmatic operation
 * still keys on the filename prefix, so it works identically inside folders
 * and in the flat root). The cap is computed relative to the container's
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
   * Tag → folder-name memo (process lifetime). Folder names embed the
   * stable tag hash, so a panel keeps one folder even if its title is
   * re-cached under a different spelling mid-process; across restarts a
   * renamed title starts a new folder while the old files keep serving
   * through the recursive index until the cap evicts them.
   */
  private folderCache = new Map<string, string | null>();
  /** Folders already created on disk this process (skips repeat mkdirs). */
  private foldersEnsured = new Set<string>();

  /**
   * User-supplied cap override (bytes), replacing the computed
   * disk-relative cap while set. Persisted to `settingsPath` so it
   * survives restarts; `null` means "automatic" (computed from disk).
   */
  private customCapBytes: number | null = null;
  private readonly settingsPath: string;

  constructor(private readonly deps: ImageCacheDeps) {
    this.settingsPath =
      deps.settingsPath ?? join(dirname(deps.dir), '.imagecache-settings.json');
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
   * Per-panel folder for a provenance tag, via the injected resolver.
   * Memoized; null means "write flat". The resolver is our own DB-backed
   * lookup, but the result is still validated as a single safe path
   * segment so a hostile title can never escape the cache root.
   */
  private async resolveFolder(tag: string, kind: ImageKind): Promise<string | null> {
    const cached = this.folderCache.get(tag);
    if (cached !== undefined) return cached;
    let folder: string | null = null;
    try {
      folder = (await this.deps.resolveFolder?.(tag, kind)) ?? null;
    } catch {
      // Resolver failure — fall through to the flat layout below.
    }
    if (
      !folder ||
      folder === '.' ||
      folder === '..' ||
      folder.includes('/') ||
      folder.includes('\\') ||
      folder.length > 120
    ) {
      folder = null;
    }
    this.folderCache.set(tag, folder);
    return folder;
  }

  /**
   * Every cached file as a root-relative path (`folder/file` or `file`),
   * `.tmp` partials excluded. The cache is one level of per-panel folders
   * plus the legacy flat root — one recursive walk covers both.
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

  /** Remove newly-empty per-panel folders (tidiness after clears/eviction). */
  private async pruneEmptyDirs(): Promise<void> {
    let top;
    try {
      top = await readdir(this.deps.dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of top) {
      if (!d.isDirectory()) continue;
      const full = join(this.deps.dir, d.name);
      try {
        const inner = await readdir(full);
        if (inner.length === 0) await rmdir(full);
      } catch {
        // Best-effort — a transient error shouldn't fail the caller.
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

  async getOrCreate(
    url: string,
    fetcher: () => Promise<{ bytes: ArrayBuffer; contentType: string | null }>,
    kind: ImageKind,
    tag: string | null = null,
    stableKey: string | null = null,
  ): Promise<ImageCacheEntry> {
    await this.ensureDirs();
    const inFlightKey = `${kind}|${tag ?? ''}|${stableKey ?? ''}|${url}`;
    const existing = this.inFlight.get(inFlightKey);
    if (existing) return existing;

    // Serve from disk if already cached — no upstream hit on revisit. This is
    // what makes covers survive a browser close/reopen (the browser cache is
    // gone in incognito, but the on-disk cache on the server is not).
    const cached = await this.readFromDisk(kind, url, tag, stableKey);
    if (cached) return cached;

    const promise = this.doFetch(url, fetcher, kind, tag, stableKey);
    this.inFlight.set(inFlightKey, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(inFlightKey);
    }
  }

  /**
   * Probe-only check: is the file for this (kind, tag, stableKey) tuple on
   * disk right now? Used by the chapter downloader to skip pages that are
   * already cached so a partial previous run can be resumed cheaply without
   * hammering the source (and re-tripping its rate limit). The check mirrors
   * the `readFromDisk` stable-key lookup exactly — same hash, same prefix —
   * so a "yes" here guarantees `getOrCreate` would return that file
   * immediately on the next call.
   *
   * Returns `false` when no `tag`/`stableKey` is provided (no key to look
   * up by), or when the directory does not exist yet. Cheap: an O(1)
   * index hit after the one-time warm-up (the downloader probes every
   * page of a chapter in parallel — a per-probe directory scan would
   * serialize hundreds of syscalls).
   */
  async hasEntry(
    kind: ImageKind,
    tag: string,
    stableKey: string,
  ): Promise<boolean> {
    if (!tag || !stableKey) return false;
    await this.ensureIndexPopulated();
    if (!this.indexStems) return false;
    const stem = `${kind}-${this.tagPrefix(kind, tag)}${this.keySuffix(stableKey)}`;
    if (this.indexStems.has(stem)) return true;
    // File written by another process after our warm-up — one filtered
    // recursive scan also heals the index as a side effect.
    return (await this.readdirFiltered(kind, tag, stableKey, '')) !== null;
  }

  /**
   * Look up a previously-cached file.
   *
   *   1. Stable-key shape `<kind>-<tagHash><keyHash><ext>` — chapter
   *      pages written via the modern download path. One Map.get per
   *      candidate extension (cheap; the loop stops at the first hit).
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
            await statSync(fullPath);
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
            await statSync(fullPath);
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
    fetcher: () => Promise<{ bytes: ArrayBuffer; contentType: string | null }>,
    kind: ImageKind,
    tag: string | null,
    stableKey: string | null = null,
  ): Promise<ImageCacheEntry> {
    const { bytes, contentType } = await fetcher();
    const filename = this.filename(kind, url, contentType, tag, stableKey);
    // Organize attributable files into per-panel folders; unattributable
    // ones (no tag, or a tag with no panel row) stay flat as before.
    const folder = tag ? await this.resolveFolder(tag, kind) : null;
    let dir = this.deps.dir;
    if (folder) {
      dir = join(this.deps.dir, folder);
      if (!this.foldersEnsured.has(folder)) {
        await mkdir(dir, { recursive: true });
        this.foldersEnsured.add(folder);
      }
    }
    const tmpPath = join(dir, `${filename}.tmp`);
    const finalPath = join(dir, filename);
    await writeFile(tmpPath, Buffer.from(bytes));
    await rm(finalPath, { force: true });
    await rename(tmpPath, finalPath);
    // Mirror the new file into the in-memory index so the next read is
    // a hashmap hit instead of a directory scan (see readFromDisk).
    // Skip when the index hasn't been warmed yet — the first walk
    // will pick this file up naturally.
    this.indexWrite(folder ? join(folder, filename) : filename);
    await this.evictIfNeeded();
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
   * partial writes that escaped the `.tmp` cleanup).
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
    await this.evictIfNeeded();
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

  private async persistCustomCap(): Promise<void> {
    await mkdir(dirname(this.settingsPath), { recursive: true });
    await writeFile(
      this.settingsPath,
      JSON.stringify({ maxBytes: this.customCapBytes }, null, 2) + '\n',
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
    let total = 0;
    for (const rel of await this.listFiles()) {
      try {
        total += statSync(join(this.deps.dir, rel)).size;
      } catch {
        // Unreadable entry — skip it.
      }
    }
    return total;
  }

  private async evictIfNeeded(): Promise<void> {
    const cap = this.getCapBytes();
    const total = await this.dirSize();
    if (total <= cap) return;

    try {
      const files = (await this.listFiles())
        .map((rel) => {
          const p = join(this.deps.dir, rel);
          try {
            const st = statSync(p);
            return { path: p, rel, atime: st.atimeMs, mtime: st.mtimeMs, size: st.size };
          } catch {
            // Unreadable entry — skip it.
            return null;
          }
        })
        .filter((e): e is NonNullable<typeof e> => e !== null)
        // Oldest access time first — evict cold entries.
        .sort((a, b) => a.atime - b.atime || a.mtime - b.mtime);

      let remaining = total;
      for (const e of files) {
        if (remaining <= cap) break;
        await rm(e.path, { force: true });
        // Mirror the eviction into the in-memory index so subsequent
        // reads don't try to look up a path that's no longer on
        // disk. The directory-scan fallback in `readFromDisk` would
        // catch this anyway, but removing eagerly keeps the index
        // honest.
        this.indexRemove(e.rel);
        remaining -= e.size;
      }
      await this.pruneEmptyDirs();
    } catch {
      // Eviction is best-effort — a transient error shouldn't fail the write.
    }
  }

  async sizeInfo(kind: ImageKind): Promise<ImageCacheSizeInfo> {
    await this.ensureDirs();
    let entryCount = 0;
    let totalBytes = 0;
    const prefix = `${kind}-`;
    for (const rel of await this.listFiles()) {
      const e = pathBasename(rel);
      if (!e.startsWith(prefix)) continue;
      try {
        totalBytes += statSync(join(this.deps.dir, rel)).size;
        entryCount += 1;
      } catch {
        // Unreadable entry — skip it.
      }
    }
    return { entryCount, totalBytes };
  }

  /**
   * Aggregate per-tag size breakdown for the given kind. Reads the directory
   * once, groups by the 8-hex-char tag prefix, and returns one row per tag.
   * The `tag` field is the 8-hex hash; callers that want the original
   * provenance string need to keep a separate map (we don't reverse the
   * hash because it's not necessary for clear-by-tag — we filter by
   * prefix instead). Legacy files (no tag prefix) are skipped.
   */
  async listTags(kind: ImageKind): Promise<ImageCacheTagSummary[]> {
    await this.ensureDirs();
    const prefix = `${kind}-`;
    const tagMap = new Map<string, { entryCount: number; totalBytes: number }>();
    for (const rel of await this.listFiles()) {
      const e = pathBasename(rel);
      if (!e.startsWith(prefix)) continue;
      // Tag prefix is exactly 8 hex chars after `<kind>-`. Legacy files
      // (64-hex-char URL hash directly after kind prefix) have no tag
      // prefix; skip them so they don't pollute the per-tag breakdown.
      const tagHash = e.slice(prefix.length, prefix.length + 8);
      if (!/^[0-9a-f]{8}$/.test(tagHash)) continue;
      try {
        const size = statSync(join(this.deps.dir, rel)).size;
        const cur = tagMap.get(tagHash) ?? { entryCount: 0, totalBytes: 0 };
        cur.entryCount += 1;
        cur.totalBytes += size;
        tagMap.set(tagHash, cur);
      } catch {
        // Unreadable entry — skip it.
      }
    }
    return Array.from(tagMap.entries())
      .map(([tag, v]) => ({ tag, ...v }))
      .sort((a, b) => b.totalBytes - a.totalBytes);
  }

  /** Size of every file matching the given tag prefix. */
  async sizeInfoByTag(kind: ImageKind, tag: string): Promise<ImageCacheSizeInfo> {
    await this.ensureDirs();
    const tagHash = this.tagPrefix(kind, tag);
    const prefix = `${kind}-${tagHash}`;
    let entryCount = 0;
    let totalBytes = 0;
    for (const rel of await this.listFiles()) {
      const e = pathBasename(rel);
      if (!e.startsWith(prefix)) continue;
      try {
        totalBytes += statSync(join(this.deps.dir, rel)).size;
        entryCount += 1;
      } catch {
        // Unreadable entry — skip it.
      }
    }
    return { entryCount, totalBytes };
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
    for (const tag of tags) {
      const hash = this.tagPrefix(kind, tag);
      result.set(hash, { tag: hash, entryCount: 0, totalBytes: 0 });
    }
    const prefix = `${kind}-`;
    for (const rel of await this.listFiles()) {
      const e = pathBasename(rel);
      if (!e.startsWith(prefix)) continue;
      // Tag prefix is exactly 8 hex chars after `<kind>-`. Legacy files
      // (64-hex-char URL hash directly after the kind prefix) have no tag
      // prefix; skip them so they don't pollute the per-tag breakdown.
      const tagHash = e.slice(prefix.length, prefix.length + 8);
      if (!/^[0-9a-f]{8}$/.test(tagHash) || !wanted.has(tagHash)) continue;
      const row = result.get(tagHash)!;
      try {
        row.totalBytes += statSync(join(this.deps.dir, rel)).size;
        row.entryCount += 1;
      } catch {
        // Unreadable entry — skip it.
      }
    }
    return Array.from(result.values());
  }

  async clear(kind: ImageKind): Promise<ImageCacheSizeInfo> {
    const info = await this.sizeInfo(kind);
    if (info.entryCount === 0) return info;
    const prefix = `${kind}-`;
    try {
      for (const rel of await this.listFiles()) {
        const e = pathBasename(rel);
        if (!e.startsWith(prefix)) continue;
        await rm(join(this.deps.dir, rel), { force: true });
        this.indexRemove(rel);
      }
      await this.pruneEmptyDirs();
    } catch {
      // Clearing is best-effort — a transient error shouldn't fail the call.
    }
    return info;
  }

  /**
   * Clear every file matching the given provenance tag. The tag is hashed
   * the same way as on write, so the caller passes the original provenance
   * string (e.g. `mk:solo-leveling.21708`) and we find all matching files by
   * their 8-hex prefix.
   */
  async clearByTag(kind: ImageKind, tag: string): Promise<ImageCacheSizeInfo> {
    const info = await this.sizeInfoByTag(kind, tag);
    if (info.entryCount === 0) return info;
    const tagHash = this.tagPrefix(kind, tag);
    const prefix = `${kind}-${tagHash}`;
    try {
      for (const rel of await this.listFiles()) {
        const e = pathBasename(rel);
        if (!e.startsWith(prefix)) continue;
        await rm(join(this.deps.dir, rel), { force: true });
        this.indexRemove(rel);
      }
      await this.pruneEmptyDirs();
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
    let entryCount = 0;
    let totalBytes = 0;
    for (const rel of await this.listFiles()) {
      const e = pathBasename(rel);
      // A tagged entry has an 8-hex tag hash right after `<kind>-`
      // followed by 56 more hex chars (64 total). Legacy entries have
      // the 64-hex URL hash directly after the prefix — same total
      // width, so match the tagged shape explicitly instead.
      if (/^(cover|chapter)-[0-9a-f]{8}[0-9a-f]{56}\.\w+$/.test(e)) continue;
      if (!/^(cover|chapter)-[0-9a-f]{64}\.\w+$/.test(e)) continue;
      const p = join(this.deps.dir, rel);
      try {
        totalBytes += statSync(p).size;
      } catch {
        /* unreadable — still try to remove */
      }
      try {
        await rm(p, { force: true });
        this.indexRemove(rel);
        entryCount += 1;
      } catch {
        /* best-effort */
      }
    }
    await this.pruneEmptyDirs();
    return { entryCount, totalBytes };
  }
}