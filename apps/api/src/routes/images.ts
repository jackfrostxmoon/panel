import { Hono } from 'hono';
import { extname } from 'node:path';
import { ErrorCodes, ok } from '@panel/shared';
import { AppError, SourceError } from '../lib/errors.js';
import { recordImageResult } from '../lib/stats.js';
import {
  MAX_CUSTOM_CAP_BYTES,
  MAX_UPSTREAM_CONCURRENCY,
  MIN_CUSTOM_CAP_BYTES,
  MIN_UPSTREAM_CONCURRENCY,
  type ImageCache,
  type ImageCacheSizeInfo,
  type ImageCacheTagSummary,
  type ImageKind,
} from '../lib/imageCache.js';
import type { SourceRegistry } from '../sources/registry.js';

/**
 * Choose the most useful `Content-Type` header for a cached image.
 *
 * Upstream often returns `application/octet-stream` for image responses
 * (MangaKatana, Rawkuma, …) — the browser then has to MIME-sniff the body
 * on every request, which adds tens of milliseconds per page in paged
 * reading mode (one fetch+decode per page turn) and defeats some HTTP
 * cache key optimisations.
 *
 * We pick the stored Content-type when it is a real image type, and
 * otherwise derive one from the on-disk file extension. The cache filename
 * already carries the extension picked from the upstream's content-type at
 * write time, so a `.jpg` on disk really is JPEG; reading it back as
 * `image/jpeg` is correct.
 */
function pickContentType(stored: string | null, path: string): string {
  // Normalise the non-standard `image/jpg` (some servers send it) to the
  // canonical `image/jpeg`. Done first so the `image/*` pass-through below
  // doesn't accidentally emit the typo.
  const normalisedStored =
    stored === 'image/jpg' ? 'image/jpeg' : stored;
  if (normalisedStored && normalisedStored.startsWith('image/')) {
    return normalisedStored;
  }
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.avif':
      return 'image/avif';
    default:
      // Last resort — covers the `.bin` fallback the cache uses when the
      // upstream sent no content-type and the URL had no extension.
      return 'application/octet-stream';
  }
}

/**
 * Resolves a set of chapter global ids to the global ids of the panel they
 * belong to. Injected so the tags-size endpoint can attribute chapter pages
 * to the panel that owns them (chapter ids and panel ids are different
 * provenance strings with different tag hashes).
 */
export type ChapterTagResolver = (
  chapterIds: readonly string[],
) => Promise<Map<string, string>>;

/**
 * Resolves a panel global id to the global ids of its chapters. Injected so
 * the clear-by-tag endpoint can expand a panel-level tag to that panel's
 * chapter pages (chapter files are tagged with the *chapter* id, so clearing
 * by panel id alone would otherwise match nothing and report a false 0).
 */
export type PanelChapterResolver = (panelId: string) => Promise<string[]>;

/**
 * Resolves a set of panel global ids to the global ids of each panel's
 * chapters. Injected so the tags-size endpoint can attribute every on-disk
 * chapter file to its panel — not just the chapters the client sent (which
 * only covers chapters opened in the current session), so per-panel totals
 * stay accurate on a fresh load too.
 */
export type ChaptersByPanelsResolver = (
  panelIds: readonly string[],
) => Promise<Map<string, string[]>>;

/**
 * Image proxy for sources whose CDNs block direct browser access
 * (hotlink protection via Referer checks). Only sources implementing
 * PanelSource.fetchImage can be proxied; URL validation happens inside
 * the adapter's guarded HTTP client (allowlist, timeout, size cap).
 *
 * Every proxied image is persisted to the on-disk ImageCache, so repeated
 * requests (covers on revisit, reader pages already viewed) are served
  * from disk with no upstream hit. Cached images live in the on-disk
 * `imagecache` volume and survive restarts while the server runs.
 *
 * Covers and chapter images use SEPARATE cache subdirectories so the
 * clear-control can purge one without the other:
 *   GET    /api/source-image/cover?source=<name>&u=<url-encoded upstream image url>
 *   GET    /api/source-image/chapter?source=<name>&u=<url-encoded upstream image url>
 *   GET    /api/source-image?source=<name>&u=…  (legacy adapter form; chapter cache default)
 *   DELETE /api/source-image/cache?what=cover|chapter|both
 */
export function sourceImageRoutes(
  registry: SourceRegistry,
  imageCache: ImageCache,
  resolveChapterTags: ChapterTagResolver,
  resolvePanelChapterIds: PanelChapterResolver = async () => [],
  resolveChaptersByPanels: ChaptersByPanelsResolver = async () => new Map(),
): Hono {
  const app = new Hono();

  /**
   * Clear chapter pages for one tag. A chapter id clears exactly that
   * chapter; a panel id additionally expands to every chapter the panel
   * owns (via the metadata cache's chapter rows). The expansion only runs
   * when the exact tag matched zero files, so chapter-level clears never
   * widen beyond the requested chapter.
   */
  async function clearChapterTag(tag: string): Promise<ImageCacheSizeInfo> {
    const direct = await imageCache.clearByTag('chapter', tag);
    if (direct.entryCount > 0) return direct;
    let total = direct;
    for (const chapterId of await resolvePanelChapterIds(tag)) {
      const info = await imageCache.clearByTag('chapter', chapterId);
      total = {
        entryCount: total.entryCount + info.entryCount,
        totalBytes: total.totalBytes + info.totalBytes,
      };
    }
    return total;
  }

  /**
   * Validate a provenance tag passed via `?tag=…`. The tag identifies the
   * source/manga/chapter the image belongs to so it can be cleared later.
   * Strict regex: two-letter source code, colon, then a global-id-shaped
   * token (alphanumeric + `_-+.~`). Source slugs can be long (mangakatana
   * uses the full title as the id — 96+ chars is normal), so the id part
   * allows up to 200 chars (256 total). The charset is what blocks
   * directory-traversal (`../`), null bytes, and other shell/URL tricks.
   *
   * With `lenient` (image GET routes and the read-only tags-size query), an
   * invalid tag returns null instead of throwing — the image or read-only
   * size lookup still works, it just loses the cache attribution. A broken
   * cover because of a provenance-string quirk is worse than an unattributed
   * cache entry. Strict callers (clear-by-tag, single-tag size) keep throwing
   * so a malformed tag can't silently widen a destructive operation.
   */
  function parseTag(raw: string | undefined, opts: { lenient?: boolean } = {}): string | null {
    if (!raw) return null;
    const decoded = decodeURIComponent(raw);
    const invalid =
      decoded.length > 256 ||
      !/^[a-z]{2}:[A-Za-z0-9_\-+.~]{1,200}(~[A-Za-z0-9_\-+.~]{1,120})?$/.test(decoded);
    if (invalid) {
      if (opts.lenient) return null;
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Parameter "tag" must look like "<source>:<id>" (e.g. mk:solo-leveling.21708).',
      );
    }
    return decoded;
  }

  /** Validate a list of provenance tags — every entry must be a string. */
  function stringArray(raw: unknown, field: string): string[] {
    if (!Array.isArray(raw)) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `"${field}" must be an array of provenance tag strings.`,
      );
    }
    const out: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'string') {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          `Every entry in "${field}" must be a string provenance tag.`,
        );
      }
      out.push(entry);
    }
    return out;
  }

  /**
   * Classify an image-fetch failure. An SSRF-allowlist rejection means the
   * source moved its images to a host we don't trust yet (a CDN move) —
   * distinct from upstream timeouts/5xx (a dead or sick host). The message
   * match is against our own client's rejection text in lib/httpClient.ts.
   */
  function isAllowlistRejection(error: unknown): boolean {
    return (
      error instanceof SourceError &&
      error.code === ErrorCodes.SOURCE_UNAVAILABLE &&
      /not allowed/i.test(error.message)
    );
  }

  async function serveImage(
    sourceName: string,
    rawUrl: string,
    kind: ImageKind,
    tag: string | null,
    pageIdx: number | null = null,
  ) {
    const source = registry.get(sourceName);
    if (!source.fetchImage) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Source "${sourceName}" does not support image proxying.`,
      );
    }

    // Cache key = upstream URL. The reader appends ?_retry=<ts> on reloads
    // to bust the browser cache — strip it so the cache key is stable.
    const cacheUrl = rawUrl.replace(/[?&]_retry=\d+/, '');

    // Reader pages additionally pass ?p=<page index>. Together with the
    // chapter tag this forms a STABLE cache key that does not depend on the
    // (often tokenized, rotating) upstream URL — so a downloaded chapter
    // stays cached even when the site hands out fresh tokens.
    const stableKey =
      tag !== null && pageIdx !== null ? `${tag}#p${pageIdx}` : null;

    const entry = await imageCache
      .getOrCreate(
        cacheUrl,
        () => source.fetchImage!(cacheUrl),
        kind,
        tag,
        stableKey,
      )
      .then(
        (hit) => {
          recordImageResult(sourceName, true, false);
          return hit;
        },
        (error) => {
          recordImageResult(sourceName, false, isAllowlistRejection(error));
          throw error;
        },
      );
return new Response(Bun.file(entry.path), {
      headers: {
        // Pick the best MIME type we can: prefer the one we stored at fetch
        // time (which usually echoes the upstream's `Content-Type`), but
        // fall back to the extension-derived type when the upstream sent
        // something generic like `application/octet-stream` (MangaKatana,
        // Rawkuma and friends do this for image responses — it forces the
        // browser into a slow generic-decode path instead of the optimised
        // image decoders). `image/jpeg` for `.jpg`/`.jpeg` lets the
        // browser skip MIME sniffing on repeat requests and keeps the
        // HTTP cache key stable across re-downloads.
        'Content-Type': pickContentType(entry.contentType, entry.path),
        // Covers and reader pages are effectively immutable: the cache key
        // is a hash of the upstream URL (or a stable chapter-page key), so a
        // rotated upstream URL gets a new key — the cached file never goes
        // stale. `immutable` tells the browser to skip conditional
        // revalidation entirely for 24h; `stale-while-revalidate` lets it
        // serve the cached copy instantly while revalidating in the
        // background.
        'Cache-Control': 'public, max-age=86400, immutable, stale-while-revalidate=86400',
      },
    });
  }

  /**
   * Validate the optional `?p=<page index>` param. Only non-negative
   * integers (up to 4 digits) are accepted; anything else means "no stable
   * key" and the entry falls back to URL-based caching.
   */
  function parsePageIdx(raw: string | undefined): number | null {
    if (!raw) return null;
    if (!/^\d{1,4}$/.test(raw)) return null;
    return Number.parseInt(raw, 10);
  }

  app.get('/cover', async (c) => {
    const sourceName = c.req.query('source');
    const rawUrl = c.req.query('u');
    if (!sourceName || !rawUrl) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Missing "source" or "u" query parameter.',
      );
    }
    const tag = parseTag(c.req.query('tag'), { lenient: true });
    return serveImage(sourceName, rawUrl, 'cover', tag);
  });

  /**
   * Legacy form emitted by adapters that rewrite their own image URLs (and by
   * persisted `chapter_pages` rows that still carry those URLs — the offline
   * fallback). Kind-less, so it feeds the chapter cache (the dominant case);
   * new URLs should use /cover or /chapter explicitly.
   */
  app.get('/', async (c) => {
    const sourceName = c.req.query('source');
    const rawUrl = c.req.query('u');
    if (!sourceName || !rawUrl) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Missing "source" or "u" query parameter.',
      );
    }
    const kindParam = c.req.query('kind');
    if (kindParam && kindParam !== 'cover' && kindParam !== 'chapter') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Parameter "kind" must be one of: cover, chapter.',
      );
    }
    const tag = parseTag(c.req.query('tag'), { lenient: true });
    return serveImage(
      sourceName,
      rawUrl,
      (kindParam as ImageKind | undefined) ?? 'chapter',
      tag,
      parsePageIdx(c.req.query('p')),
    );
  });

  app.get('/chapter', async (c) => {
    const sourceName = c.req.query('source');
    const rawUrl = c.req.query('u');
    if (!sourceName || !rawUrl) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Missing "source" or "u" query parameter.',
      );
    }
    const tag = parseTag(c.req.query('tag'), { lenient: true });
    return serveImage(
      sourceName,
      rawUrl,
      'chapter',
      tag,
      parsePageIdx(c.req.query('p')),
    );
  });

  app.get('/cache', async (c) => {
    const what = (c.req.query('what') as ImageKind | 'both' | undefined) ?? 'both';
    if (what !== 'cover' && what !== 'chapter' && what !== 'both') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Parameter "what" must be one of: cover, chapter, both.',
      );
    }
    const info = what === 'both'
      ? { cover: await imageCache.sizeInfo('cover'), chapter: await imageCache.sizeInfo('chapter') }
      : { [what]: await imageCache.sizeInfo(what) };
    // Flat shape the client can read directly: total across all kinds.
    const cover = info.cover ?? { entryCount: 0, totalBytes: 0 };
    const chapter = info.chapter ?? { entryCount: 0, totalBytes: 0 };
    return c.json(
      ok({
        cover,
        chapter,
        entryCount: cover.entryCount + chapter.entryCount,
        totalBytes: cover.totalBytes + chapter.totalBytes,
        // The disk-relative cap (bavail*bsize * maxFraction, clamped). Lets the
        // client draw a "how full is the cache" progress bar.
        capBytes: imageCache.getCapBytes(),
      }),
    );
  });

  /**
   * Read the cache size limit. `capBytes` is the effective cap (what the
   * Usage bar and eviction enforce); `customMaxBytes` is the persisted user
   * override (`null` = automatic); `computedCapBytes` is the automatic
   * disk-relative value the override replaces while set.
   */
  app.get('/cache/limit', async (c) => {
    return c.json(
      ok({
        customMaxBytes: imageCache.getCustomCapBytes(),
        computedCapBytes: imageCache.getComputedCapBytes(),
        capBytes: imageCache.getCapBytes(),
      }),
    );
  });

  /**
   * Set (`{ "maxBytes": <int> }`) or clear (`{ "maxBytes": null }`,
   * back to automatic) the custom cache size limit. Persisted beside the
   * cache dir so it survives restarts, and enforced immediately — lowering
   * the cap below current usage evicts cold entries right away.
   */
  app.put('/cache/limit', async (c) => {
    let body: { maxBytes?: unknown };
    try {
      body = (await c.req.json()) as { maxBytes?: unknown };
    } catch {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Request body must be valid JSON.');
    }
    const { maxBytes } = body;
    if (maxBytes !== null && maxBytes !== undefined) {
      if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes)) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Field "maxBytes" must be an integer number of bytes, or null.');
      }
      if (maxBytes < MIN_CUSTOM_CAP_BYTES || maxBytes > MAX_CUSTOM_CAP_BYTES) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          `Field "maxBytes" must be between ${MIN_CUSTOM_CAP_BYTES} and ${MAX_CUSTOM_CAP_BYTES} bytes (64 MB – 1 TB), or null.`,
        );
      }
    }
    try {
      await imageCache.setCustomCapBytes(maxBytes ?? null);
    } catch (error) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        error instanceof Error ? error.message : 'Could not update the cache size limit.',
      );
    }
    return c.json(
      ok({
        customMaxBytes: imageCache.getCustomCapBytes(),
        computedCapBytes: imageCache.getComputedCapBytes(),
        capBytes: imageCache.getCapBytes(),
      }),
    );
  });

  /**
   * Read the upstream-fetch concurrency. `concurrency` is the effective
   * value (what the proxy semaphore enforces); `customConcurrency` is the
   * persisted user override (`null` = env default); `defaultConcurrency`
   * is the startup (`IMAGE_PROXY_CONCURRENCY`) value the override replaces
   * while set. `min`/`max` bound the settable range.
   */
  app.get('/cache/concurrency', async (c) => {
    return c.json(
      ok({
        customConcurrency: imageCache.getCustomUpstreamConcurrency(),
        defaultConcurrency: imageCache.getDefaultUpstreamConcurrency(),
        concurrency: imageCache.getUpstreamConcurrency(),
        min: MIN_UPSTREAM_CONCURRENCY,
        max: MAX_UPSTREAM_CONCURRENCY,
      }),
    );
  });

  /**
   * Set (`{ "concurrency": <int 1–32> }`) or clear (`{ "concurrency": null }`,
   * back to the env default) the upstream-fetch concurrency. Persisted
   * beside the cache dir so it survives restarts, and enforced immediately
   * — lowering it below the in-flight count just pauses new acquisitions
   * until active fetches drain. Settable from the reader settings panel so
   * the "All at once" preload throughput can be compared live.
   */
  app.put('/cache/concurrency', async (c) => {
    let body: { concurrency?: unknown };
    try {
      body = (await c.req.json()) as { concurrency?: unknown };
    } catch {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Request body must be valid JSON.');
    }
    const { concurrency } = body;
    if (concurrency !== null && concurrency !== undefined) {
      if (typeof concurrency !== 'number' || !Number.isInteger(concurrency)) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Field "concurrency" must be an integer number of fetches, or null.');
      }
      if (concurrency < MIN_UPSTREAM_CONCURRENCY || concurrency > MAX_UPSTREAM_CONCURRENCY) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          `Field "concurrency" must be between ${MIN_UPSTREAM_CONCURRENCY} and ${MAX_UPSTREAM_CONCURRENCY}, or null.`,
        );
      }
    }
    try {
      await imageCache.setUpstreamConcurrency(concurrency ?? null);
    } catch (error) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        error instanceof Error ? error.message : 'Could not update the upstream concurrency.',
      );
    }
    return c.json(
      ok({
        customConcurrency: imageCache.getCustomUpstreamConcurrency(),
        defaultConcurrency: imageCache.getDefaultUpstreamConcurrency(),
        concurrency: imageCache.getUpstreamConcurrency(),
        min: MIN_UPSTREAM_CONCURRENCY,
        max: MAX_UPSTREAM_CONCURRENCY,
      }),
    );
  });

  /**
   * Per-tag breakdown for a given kind. Returns one row per provenance tag
   * (the 8-hex hash prefix) sorted by size desc. The frontend correlates
   * this with the tags it has sent to the API (e.g. via recently-viewed
   * localStorage and the source list) to display "which panel takes the
   * most space".
   */
  app.get('/cache/tags', async (c) => {
    const kind = c.req.query('kind') as ImageKind | undefined;
    if (kind !== 'cover' && kind !== 'chapter') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Parameter "kind" must be one of: cover, chapter.',
      );
    }
    return c.json(ok({ kind, tags: await imageCache.listTags(kind) }));
  });

  /**
   * Size of a single tag — used by the chapter-drill-in modal to show file
   * count + bytes for one panel or one chapter before the user decides to
   * clear it.
   */
  app.get('/cache/tag', async (c) => {
    const kind = c.req.query('kind') as ImageKind | undefined;
    if (kind !== 'cover' && kind !== 'chapter') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Parameter "kind" must be one of: cover, chapter.',
      );
    }
    const tag = parseTag(c.req.query('tag'));
    if (!tag) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Missing or invalid "tag" parameter.',
      );
    }
    return c.json(ok({ kind, tag, ...(await imageCache.sizeInfoByTag(kind, tag)) }));
  });

  /**
   * Total cached footprint for a set of panel. The client sends two lists:
   * the panel ids (covers are tagged with the panel id) and the chapter ids
   * (chapter pages are tagged with the chapter id). Chapter ids are resolved
   * to their panel id server-side via the chapters table, because a chapter
   * id (`mr:x~c1`) and its panel id (`mr:x`) are different provenance strings
   * with different tag hashes — the per-panel size query can only match
   * chapter pages once they've been attributed to the panel that owns them.
   *
   * One row per panel (cover + chapter pages merged), with zeroed rows for
   * panel with no cached files. Reads each kind's directory once (not one
   * readdir per tag) so the cache-settings page can show every bookmarked
   * panel's total footprint in a single round-trip instead of N.
   *
   * Tags are validated individually via `parseTag` (same shape as the proxy's
   * `?tag=` param) so a malformed entry is a 400 rather than a silent skip.
   */
  app.post('/cache/tags-size', async (c) => {
    let body: { panelTags?: unknown; chapterTags?: unknown };
    try {
      body = (await c.req.json()) as { panelTags?: unknown; chapterTags?: unknown };
    } catch {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Request body must be valid JSON.');
    }
    const panelTags = stringArray(body.panelTags, 'panelTags');
    const chapterTags = stringArray(body.chapterTags, 'chapterTags');
    if (panelTags.length === 0 && chapterTags.length === 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must contain at least one of "panelTags" or "chapterTags" arrays.',
      );
    }
    if (panelTags.length + chapterTags.length > 200) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Too many tags — maximum 200 per request.',
      );
    }
    const uniquePanel = Array.from(new Set(panelTags.map((t) => parseTag(t, { lenient: true })).filter((t): t is string => t !== null)));
    const uniqueChapters = Array.from(new Set(chapterTags.map((t) => parseTag(t, { lenient: true })).filter((t): t is string => t !== null)));
    // Resolve chapter ids → panel ids. Chapters whose panel row is missing
    // (source never fetched) drop out — same as a chapter with no pages.
    const chapterToPanel = await resolveChapterTags(uniqueChapters);
    // Chapter files are tagged with the *chapter* id, so query the chapter
    // kind by chapter ids; then remap each chapter row's tag hash to the
    // panel id's tag hash (the two are different provenance strings with
    // different hashes) so the merged row is keyed by the panel.
    const chapterHashToPanelHash = new Map<string, string>();
    for (const [chapterId, panelId] of chapterToPanel) {
      chapterHashToPanelHash.set(imageCache.tagHash(chapterId), imageCache.tagHash(panelId));
    }
    const [cover, chapter] = await Promise.all([
      imageCache.sizeInfoByTagSum('cover', uniquePanel),
      imageCache.sizeInfoByTagSum('chapter', uniqueChapters),
    ]);
    // Merge the two kinds per panel so the client gets one row per panel.
    // Cover rows are keyed by the panel id hash directly — keep them as-is.
    // Chapter rows need remapping to their panel's hash, then get added on.
    const byTag = new Map<string, ImageCacheTagSummary>();
    for (const row of cover) byTag.set(row.tag, row);
    // Hashes already merged below — the follow-up sweep over every on-disk
    // chapter file must skip these so no file is counted twice.
    const countedChapterHashes = new Set<string>();
    for (const row of chapter) {
      const panelHash = chapterHashToPanelHash.get(row.tag);
      if (!panelHash) continue; // chapter tag we couldn't attribute — skip
      countedChapterHashes.add(row.tag);
      const existing = byTag.get(panelHash) ?? { tag: panelHash, entryCount: 0, totalBytes: 0 };
      existing.entryCount += row.entryCount;
      existing.totalBytes += row.totalBytes;
      byTag.set(panelHash, existing);
    }
    // The client only sends chapters opened in the current session, so
    // chapter files from earlier sessions would be missing from every
    // panel total. Sweep every on-disk chapter tag and attribute the ones
    // still uncounted via the metadata cache's chapter rows for the
    // requested panels.
    const onDiskChapterTags = await imageCache.listTags('chapter');
    const onDiskByHash = new Map(onDiskChapterTags.map((row) => [row.tag, row]));
    const chaptersByPanel = await resolveChaptersByPanels(uniquePanel);
    for (const [panelId, chapterIds] of chaptersByPanel) {
      const panelHash = imageCache.tagHash(panelId);
      for (const chapterId of chapterIds) {
        const hash = imageCache.tagHash(chapterId);
        if (countedChapterHashes.has(hash)) continue;
        const onDisk = onDiskByHash.get(hash);
        if (!onDisk) continue;
        countedChapterHashes.add(hash);
        const existing = byTag.get(panelHash) ?? { tag: panelHash, entryCount: 0, totalBytes: 0 };
        existing.entryCount += onDisk.entryCount;
        existing.totalBytes += onDisk.totalBytes;
        byTag.set(panelHash, existing);
      }
    }
    return c.json(ok({ sizes: Array.from(byTag.values()) }));
  });

  app.delete('/cache', async (c) => {
    const what = (c.req.query('what') as ImageKind | 'both' | undefined) ?? 'both';
    if (what !== 'cover' && what !== 'chapter' && what !== 'both') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Parameter "what" must be one of: cover, chapter, both.',
      );
    }
    // If a tag is provided, clear only that tag's files (one source / panel /
    // chapter). Otherwise, fall back to the kind-level clear.
    const tag = parseTag(c.req.query('tag'));
    if (tag) {
      if (what === 'both') {
        const a = await imageCache.clearByTag('cover', tag);
        const b = await clearChapterTag(tag);
        return c.json(
          ok({
            what,
            tag,
            entryCount: a.entryCount + b.entryCount,
            totalBytes: a.totalBytes + b.totalBytes,
            cover: a,
            chapter: b,
          }),
        );
      }
      if (what === 'chapter') {
        const info = await clearChapterTag(tag);
        return c.json(ok({ what, tag, ...info }));
      }
      const info = await imageCache.clearByTag(what, tag);
      return c.json(ok({ what, tag, ...info }));
    }
    const info = what === 'both' ? await imageCache.clearAll() : await imageCache.clear(what);
    return c.json(ok({ what, ...info }));
  });

  /**
   * Prune LEGACY cache entries — files written before the tag format existed
   * (`<kind>-<64-hex URL hash>`). They are invisible to the per-tag views,
   * can't be cleared per panel/chapter, and their URL keys have usually been
   * rotated away by tokenized sources. Safe: worst case the next read
   * re-fetches those images from upstream.
   */
  app.delete('/cache/legacy', async (c) => {
    const info = await imageCache.pruneLegacy();
    return c.json(ok({ what: 'legacy', cleared: info.entryCount, ...info }));
  });

  /**
   * Probe which pages of a chapter are already on disk.
   *
   * Body: `{ chapterTag: string, totalPages: number }`.
   * Returns: `{ chapterTag, totalPages, cached: number[], missing: number[] }`
   * (`cached`/`missing` are 0-based page indices).
   *
   * Used by the chapter downloader so a partial previous run can resume
   * cheaply: pages already on disk are skipped, only the missing ones are
   * fetched from upstream. Without this, a retry of a 37-page chapter whose
   * first 20 pages already cached would re-fetch all 37 — re-tripping the
   * source's rate limit and wasting time. The check is an O(1) index hit
   * after warm-up, so a chapter with ~200 pages probes in well under a
   * millisecond.
   *
   * Pages are looked up by their STABLE key (`<chapterTag>#p<index>`) — the
   * same key the proxy writes on `?p=` requests — so a "yes" here
   * guarantees `getOrCreate` would return the cached file immediately on
   * the next call.
   */
  app.post('/cache/has-chapter-pages', async (c) => {
    let body: { chapterTag?: unknown; totalPages?: unknown };
    try {
      body = (await c.req.json()) as { chapterTag?: unknown; totalPages?: unknown };
    } catch {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Request body must be valid JSON.');
    }
    const chapterTag = parseTag(
      typeof body.chapterTag === 'string' ? body.chapterTag : undefined,
    );
    if (!chapterTag) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Parameter "chapterTag" must look like "<source>:<id>" (e.g. mk:solo-leveling.21708~c200).',
      );
    }
    if (typeof body.totalPages !== 'number' || !Number.isInteger(body.totalPages) || body.totalPages < 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Parameter "totalPages" must be a non-negative integer.',
      );
    }
    if (body.totalPages > 2000) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Parameter "totalPages" must be <= 2000.',
      );
    }
    // Probe every page index in parallel. `hasEntry` is an O(1) index hit
    // after warm-up, so this stays bounded even for long chapters.
    const probes = Array.from({ length: body.totalPages }, async (_, pageIdx) => {
      const stableKey = `${chapterTag}#p${pageIdx}`;
      const hit = await imageCache.hasEntry('chapter', chapterTag, stableKey);
      return { pageIdx, hit };
    });
    const settled = await Promise.all(probes);
    const cached: number[] = [];
    const missing: number[] = [];
    for (const { pageIdx, hit } of settled) {
      (hit ? cached : missing).push(pageIdx);
    }
    return c.json(ok({ chapterTag, totalPages: body.totalPages, cached, missing }));
  });

  /**
   * Batch version of the probe above: disk truth for many chapters in one
   * round-trip.
   *
   * Body: `{ chapters: [{ chapterTag: string, totalPages: number }] }`
   * (max 200 chapters per request, same batch cap as the other bulk
   * endpoints; `totalPages` ≤ 2000 each).
   * Returns: `{ results: Record<chapterTag, { chapterTag, totalPages, cachedCount }> }`
   * (`cachedCount` = pages actually on disk right now).
   *
   * The details page uses this to verify "done" claims: a prefetch job
   * row is a historical record — it still says `completed 31/31` after
   * the files were cleared, evicted, or manually deleted, so the row
   * alone makes the chapter badge lie ("Already cached (31 / 31)" with
   * an empty folder). Counts (not indices) keep the payload small.
   */
  app.post('/cache/has-chapters-pages', async (c) => {
    let body: { chapters?: unknown };
    try {
      body = (await c.req.json()) as { chapters?: unknown };
    } catch {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Request body must be valid JSON.');
    }
    if (!Array.isArray(body.chapters) || body.chapters.length === 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Request body must contain a non-empty "chapters" array.',
      );
    }
    if (body.chapters.length > 200) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Too many chapters — maximum 200 per request.',
      );
    }
    const entries: Array<{ chapterTag: string; totalPages: number }> = [];
    for (const entry of body.chapters) {
      if (typeof entry !== 'object' || entry === null) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          'Every entry in "chapters" must be an object with "chapterTag" and "totalPages".',
        );
      }
      const { chapterTag: rawTag, totalPages } = entry as {
        chapterTag?: unknown;
        totalPages?: unknown;
      };
      const chapterTag = parseTag(typeof rawTag === 'string' ? rawTag : undefined);
      if (!chapterTag) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          'Every "chapterTag" must look like "<source>:<id>" (e.g. mk:solo-leveling.21708~c200).',
        );
      }
      if (
        typeof totalPages !== 'number' ||
        !Number.isInteger(totalPages) ||
        totalPages < 0 ||
        totalPages > 2000
      ) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          'Every "totalPages" must be an integer between 0 and 2000.',
        );
      }
      entries.push({ chapterTag, totalPages });
    }
    // Dedupe repeat tags (a chapter listed twice shouldn't double-probe).
    const seen = new Set<string>();
    const unique = entries.filter((e) => {
      if (seen.has(e.chapterTag)) return false;
      seen.add(e.chapterTag);
      return true;
    });
    const results: Record<string, { chapterTag: string; totalPages: number; cachedCount: number }> =
      {};
    await Promise.all(
      unique.map(async ({ chapterTag, totalPages }) => {
        let cachedCount = 0;
        if (totalPages > 0) {
          const probes = await Promise.all(
            Array.from({ length: totalPages }, (_, pageIdx) =>
              imageCache.hasEntry('chapter', chapterTag, `${chapterTag}#p${pageIdx}`),
            ),
          );
          cachedCount = probes.filter(Boolean).length;
        }
        results[chapterTag] = { chapterTag, totalPages, cachedCount };
      }),
    );
    return c.json(ok({ results }));
  });

  return app;
}