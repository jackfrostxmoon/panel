import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceError } from './errors.js';
import { logger } from './logger.js';
import { recordSourceRequest } from './stats.js';

/**
 * Guarded HTTP client used for ALL outbound source traffic.
 *
 * Security properties:
 *  - Only http(s) URLs.
 *  - Hostname must match the configured allowlist (exact host or subdomain)
 *    → the server can never be turned into an unrestricted proxy (SSRF).
 *  - Every request has a hard timeout.
 *  - Redirects are followed but re-validated against the allowlist.
 *  - Responses are size-capped to avoid memory abuse.
 */

export interface FetchedPage {
  body: string;
  finalUrl: string;
  status: number;
  /** Set-Cookie values from the response (for session-based sources). */
  setCookie: string[];
}

export interface FetchedImage {
  bytes: ArrayBuffer;
  contentType: string | null;
}

/**
 * Image streamed straight to disk (see `fetchImageToFile`): `bytes` is the
 * count written, not a buffer — the full image is never held in heap.
 */
export interface FetchedImageFile {
  bytes: number;
  contentType: string | null;
}

export interface SourceHttpClientOptions {
  /** e.g. ["mangakatana.com"] — subdomains are allowed automatically. */
  readonly allowedHosts: readonly string[];
  readonly timeoutMs: number;
  readonly userAgent?: string;
  /**
   * Complete replacement for the default text-request headers
   * (User-Agent/Accept/Accept-Language). Some Cloudflare setups challenge
   * specific header+fingerprint combinations, so sources can send a minimal
   * set instead.
   */
  readonly headers?: Record<string, string>;
  /** Maximum TEXT response size in bytes (HTML/JSON/sitemap, default 3 MiB). */
  readonly maxTextBytes?: number;
  /** Maximum IMAGE response size in bytes (default 16 MiB). */
  readonly maxImageBytes?: number;
  /**
   * ADDITIONAL hosts the source's image CDN may be proxied through. These
   * are UNIONED with `allowedHosts` for `fetchImage`, so covers served from
   * the source's own host keep working even when chapter images live on a
   * separate CDN host (rawuwu.net, r2d2storage.com, tnlycdn.com, …) that is
   * NOT the source domain. This keeps the SSRF guard (only declared hosts
   * are fetchable) while allowing the image proxy to work for both covers
   * and chapter pages.
   */
  readonly imageHosts?: readonly string[];
  /**
   * Number of automatic retries on a TRANSIENT failure before surfacing an
   * error to the caller. A transient failure is any fetch-level network
   * error (timeout, connection reset, DNS, TLS) or an HTTP 429/5xx — all of
   * which are common for slow or rate-limited panel CDNs. Non-transient
   * failures (other 4xx like 404) are never retried. Each attempt gets a
   * fresh `timeoutMs` budget, so retries cannot exceed
   * `(retryCount + 1) * timeoutMs` total. Defaults to SOURCE_REQUEST_RETRY_COUNT.
   */
  readonly retryCount?: number;
  /**
   * Base delay (ms) for the first retry; each subsequent attempt doubles it
   * (plus ±50% jitter so concurrent retries don't thunder-herd). Defaults to
   * SOURCE_REQUEST_RETRY_BASE_DELAY_MS.
   */
  readonly retryBaseDelayMs?: number;
  /**
   * Run upstream image fetches (`fetchImageToFile`) in a short-lived child
   * process instead of in-process. Intermittent ~400 MB native RSS grabs
   * have been observed on upstream image misses that survive even a forced
   * full GC — the grab lives below app code. A child contains it: when the
   * child exits the OS reclaims all of its pages. Defaults to true; set
   * false (IMAGE_FETCH_ISOLATED=false) to use the legacy in-process path.
   */
  readonly isolatedImageFetch?: boolean;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Default number of retries on a transient failure before surfacing an error. */
const DEFAULT_RETRY_COUNT = 2;
/** Base delay (ms) for the first retry; each attempt doubles it (+ jitter). */
const DEFAULT_RETRY_BASE_DELAY_MS = 500;

/**
 * Decide whether a fetch-level error is worth retrying.
 *
 * Retried: timeout/abort, connection/DNS/TLS failures, and HTTP 429 + 5xx —
 * all transient and common for slow or rate-limited panel CDNs.
 * Not retried: any other response (e.g. 404) — those are definitive.
 */
function isTransientError(error: unknown, status: number | null): boolean {
  if (status !== null) {
    if (status === 429 || (status >= 500 && status < 600)) return true;
  }
  if (error instanceof DOMException) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  }
  if (error instanceof TypeError) return true; // network/DNS/TLS failure
  return false;
}

/** Jittered exponential backoff, in ms. */
function backoffMs(base: number, attempt: number): number {
  const exponential = base * Math.pow(2, attempt - 1);
  // ±50% jitter so concurrent retries don't thunder-herd.
  const jitter = exponential * (0.5 + Math.random());
  return Math.round(jitter);
}

/** Internal marker for a transient failure worth retrying. Never leaves the
   * retry loop — it is mapped back to a public `SourceError` once retries are
   * exhausted. Carries the root cause + optional HTTP status so the final
   * error is accurate (timeout vs. network vs. 429/5xx). */
  class SourceNetworkError extends Error {
  constructor(
    message: string,
    readonly rootCause?: unknown,
    readonly status?: number,
    readonly isTimeout: boolean = false,
  ) {
    super(message);
    this.name = 'SourceNetworkError';
  }
}

/** Path of the isolated image-fetch worker (run as `bun <path> '<json>'`). */
const FETCH_IMAGE_CHILD_PATH = fileURLToPath(new URL('./fetchImageChild.ts', import.meta.url));

/**
 * The isolated worker itself failed (spawn error, unparsable output, crash)
 * — NOT a fetch outcome. The caller falls back to the legacy in-process
 * streaming path for this fetch. Deliberately distinct from fetch errors so
 * a 404/definitive failure is never double-fetched.
 */
class ChildInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChildInfrastructureError';
  }
}

/** Resolve a sleep promise so the retry loop can back off without a top-level await. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep that rejects when `signal` aborts first, so the retry backoff
 * never outlives a client that already went away (closed reader).
 */
function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Combine the per-attempt timeout with an external (client-disconnect)
 * signal. The attempt aborts on whichever fires first; the reason is
 * preserved so timeouts still classify as transient while client aborts
 * propagate as plain `AbortError`s the retry loop refuses to retry.
 */
function combinedSignal(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external || external.aborted) {
    return { signal: external ?? timeout, dispose: () => undefined };
  }
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([timeout, external]), dispose: () => undefined };
  }
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(external.reason);
  const onTimeoutAbort = () => controller.abort(timeout.reason);
  external.addEventListener('abort', onExternalAbort, { once: true });
  timeout.addEventListener('abort', onTimeoutAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      external.removeEventListener('abort', onExternalAbort);
      timeout.removeEventListener('abort', onTimeoutAbort);
    },
  };
}

/** True when `signal` fired — an intentional client abort, never a retryable fault. */
function isClientAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof DOMException && error.name === 'AbortError';
}

export class SourceHttpClient {
  private readonly allowedHosts: readonly string[];
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly headers: Record<string, string> | null;
  private readonly maxTextBytes: number;
  private readonly maxImageBytes: number;
  private readonly sourceName: string;
  /** Hosts fetchImage may reach: allowedHosts ∪ imageHosts (CDN extras). */
  private readonly imageHosts: readonly string[];
  /** Retries per transient failure (0 = no retry). */
  private readonly retryCount: number;
  /** Base delay (ms) for the first retry; doubles each attempt + jitter. */
  private readonly retryBaseDelayMs: number;
  /** Stream upstream image misses through an isolated child process. */
  private readonly isolatedImageFetch: boolean;

  constructor(sourceName: string, options: SourceHttpClientOptions) {
    this.sourceName = sourceName;
    this.allowedHosts = options.allowedHosts.map((h) => h.toLowerCase());
    // Image fetches may hit the source's own host (covers) AND any declared
    // CDN hosts (chapter pages) — union, never replace, so main-host covers
    // aren't SSRF-blocked when a source declares only its CDN here.
    this.imageHosts = [...this.allowedHosts, ...(options.imageHosts ?? []).map((h) => h.toLowerCase())];
    this.timeoutMs = options.timeoutMs;
    this.userAgent = options.userAgent ?? DEFAULT_UA;
    this.headers = options.headers ?? null;
    this.maxTextBytes = options.maxTextBytes ?? 3 * 1024 * 1024;
    this.maxImageBytes = options.maxImageBytes ?? 16 * 1024 * 1024;
    this.retryCount = options.retryCount ?? DEFAULT_RETRY_COUNT;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.isolatedImageFetch = options.isolatedImageFetch ?? true;
  }

  /** Text-request header block (defaults, or the source's override set). */
  private textHeaders(): Record<string, string> {
    return (
      this.headers ?? {
        'User-Agent': this.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    );
  }

  /** Like isAllowedUrl but against the source's image-CDN host list. */
  isAllowedImageUrl(rawUrl: string): boolean {
    return this.isAllowedUrlHost(rawUrl, this.imageHosts);
  }

  async fetchText(rawUrl: string, maxBytes?: number): Promise<FetchedPage> {
    return this.request(
      rawUrl,
      {
        headers: this.textHeaders(),
      },
      maxBytes,
    );
  }

  /**
   * Fetch a JSON endpoint (e.g. a SPA API). Sends `Accept: application/json`
   * so the source server returns structured data rather than HTML.
   * `extraHeaders` lets the source adapter add session cookies / auth
   * headers required by the source's private api.
   */
  async fetchJson(
    rawUrl: string,
    extraHeaders?: Record<string, string>,
    maxBytes?: number,
  ): Promise<FetchedPage> {
    return this.request(
      rawUrl,
      {
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'Accept-Language': 'en-US,en;q=0.9',
          'X-Requested-With': 'XMLHttpRequest',
          ...extraHeaders,
        },
      },
      maxBytes,
    );
  }

  /**
   * POST form-encoded fields (e.g. admin-ajax endpoints that expect
   * `application/x-www-form-urlencoded` bodies). Subject to the same
   * allowlist, timeout, redirect and size guards as fetchText.
   */
  async postForm(rawUrl: string, fields: Record<string, string>): Promise<FetchedPage> {
    return this.request(rawUrl, {
      method: 'POST',
      headers: {
        ...this.textHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields).toString(),
    });
  }

  /**
   * Fetch raw image bytes (covers / reader pages). `extraHeaders` lets the
   * source adapter add CDN-specific headers (e.g. a Referer required by
   * hotlink protection). Subject to the same allowlist, timeout, redirect
   * and size guards as every other request.
   */
  async fetchImage(
    rawUrl: string,
    extraHeaders?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<FetchedImage> {
    return this.requestBinary(rawUrl, {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        ...extraHeaders,
      },
    }, this.imageHosts, signal);
  }

  /**
   * Streaming variant of `fetchImage` for the image cache's miss path.
   * Upstream bytes go chunk-by-chunk to `destPath` (same allowlist,
   * timeout, redirect, retry and size-cap guards) so a 16 MiB image costs
   * one network chunk in heap instead of the whole file. Over-cap and
   * mid-stream failures delete the partial file and throw exactly like the
   * buffered path.
   */
  async fetchImageToFile(
    rawUrl: string,
    destPath: string,
    extraHeaders?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<FetchedImageFile> {
    return this.requestBinaryToFile(rawUrl, {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        ...extraHeaders,
      },
    }, destPath, this.imageHosts, signal);
  }

  /** Shared guard: URL must be http(s) and on the allowlist. */
  private assertAllowedUrl(
    rawUrl: string,
    hosts: readonly string[] = this.allowedHosts,
  ): void {
    if (this.isAllowedUrlHost(rawUrl, hosts)) return;
    logger.warn('Blocked request to non-allowlisted host', {
      url: rawUrl,
      source: this.sourceName,
    });
    throw new SourceError(
      this.sourceName,
      'SOURCE_UNAVAILABLE',
      'The requested URL is not allowed.',
      { url: rawUrl },
    );
  }

  private isAllowedUrlHost(
    rawUrl: string,
    hosts: readonly string[] = this.allowedHosts,
  ): boolean {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  }

  /** Shared guard + timing wrapper around fetch with timeout and redirects.
   *
   * Throws `SourceNetworkError` for any TRANSIENT failure (timeout, network
   * error, 429, 5xx) — those are the only cases the retry loop in
   * `request`/`requestBinary` will retry. Non-transient failures (other 4xx,
   * SSRF rejections) throw a public `SourceError` immediately. */
  private async doFetch(rawUrl: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    // An already-aborted client must never start an upstream fetch that
    // would hold a proxy slot for a reader that is already gone.
    signal?.throwIfAborted();
    const combined = combinedSignal(this.timeoutMs, signal);
    let response: Response;
    try {
      response = await fetch(rawUrl, {
        ...init,
        redirect: 'follow',
        signal: combined.signal,
      });
    } catch (error) {
      combined.dispose();
      // A client abort (closed reader / chapter hop) is intentional — let
      // the raw AbortError propagate so callers can tell it apart from a
      // real timeout and, crucially, so the retry loop does NOT retry it.
      if (isClientAbort(error, signal)) {
        logger.debug('Source request aborted by client disconnect', { url: rawUrl });
        throw error;
      }
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        logger.warn('Source request timed out', { url: rawUrl, timeoutMs: this.timeoutMs });
        throw new SourceNetworkError(
          `Request to ${rawUrl} timed out after ${this.timeoutMs}ms`,
          error,
          undefined,
          true,
        );
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        logger.warn('Source request aborted', { url: rawUrl });
        throw new SourceNetworkError(
          `Request to ${rawUrl} was aborted`,
          error,
          undefined,
          true,
        );
      }
      logger.error('Source request failed', {
        url: rawUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new SourceNetworkError(
        `Request to ${rawUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
        undefined,
        false,
      );
    }
    combined.dispose();
    return response;
  }

  /** Shared response validation (status + redirect target).
   *
   * Throws `SourceNetworkError` for transient HTTP statuses (429/5xx) so the
   * caller can retry; throws a public `SourceError` for definitive failures
   * (other 4xx, redirect-out-of-allowlist) which must not be retried. */
  private assertResponseOk(response: Response, rawUrl: string, hosts: readonly string[] = this.allowedHosts): void {
    if (!response.ok) {
      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        logger.warn('Source returned transient status', { url: rawUrl, status: response.status });
        throw new SourceNetworkError(
          `${rawUrl} returned transient HTTP ${response.status}`,
          undefined,
          response.status,
          false,
        );
      }
      logger.warn('Source returned non-2xx', { url: rawUrl, status: response.status });
      throw SourceError.unavailable(this.sourceName, rawUrl, response.status);
    }

    // The final URL after redirects must still be on the allowlist.
    if (response.url && !this.isAllowedUrlHost(response.url, hosts)) {
      logger.warn('Redirect left the allowlist', { url: rawUrl, finalUrl: response.url });
      throw SourceError.unavailable(this.sourceName, rawUrl);
    }
  }

  private async request(
    rawUrl: string,
    init: RequestInit,
    maxBytes: number = this.maxTextBytes,
  ): Promise<FetchedPage> {
    this.assertAllowedUrl(rawUrl);

    const startedAt = Date.now();
    const response = await this.fetchWithRetry(rawUrl, init, this.allowedHosts);

    const body = await this.readBodyWithLimit(response, maxBytes);
    logger.debug('Fetched source page', {
      url: rawUrl,
      status: response.status,
      bytes: body.length,
      durationMs: Date.now() - startedAt,
    });
    // Node 18.14+/Bun expose getSetCookie(); older runtimes just see none.
    const setCookie =
      (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    return { body, finalUrl: response.url || rawUrl, status: response.status, setCookie };
  }

  private async requestBinary(
    rawUrl: string,
    init: RequestInit,
    hosts: readonly string[] = this.allowedHosts,
    signal?: AbortSignal,
  ): Promise<FetchedImage> {
    this.assertAllowedUrl(rawUrl, hosts);

    const startedAt = Date.now();
    const response = await this.fetchWithRetry(rawUrl, init, hosts, signal);

    const contentType = response.headers.get('content-type');
    const bytes = await this.readBytesWithLimit(response, this.maxImageBytes);
    logger.debug('Fetched source image', {
      url: rawUrl,
      status: response.status,
      bytes: bytes.byteLength,
      durationMs: Date.now() - startedAt,
    });
    return { bytes, contentType };
  }

  private async requestBinaryToFile(
    rawUrl: string,
    init: RequestInit,
    destPath: string,
    hosts: readonly string[] = this.allowedHosts,
    signal?: AbortSignal,
  ): Promise<FetchedImageFile> {
    this.assertAllowedUrl(rawUrl, hosts);

    if (this.isolatedImageFetch) {
      try {
        return await this.fetchImageToFileIsolated(rawUrl, init, destPath, hosts, signal);
      } catch (error) {
        // Worker infrastructure failure only (spawn/crash/protocol) — fall
        // back to the legacy in-process path for this fetch. Fetch outcomes
        // (including definitive failures) never reach here, so a 404 is
        // never double-fetched.
        if (!(error instanceof ChildInfrastructureError)) throw error;
        logger.warn('Isolated image fetch unavailable, using in-process fallback', {
          url: rawUrl,
          error: error.message,
        });
      }
    }
    return this.requestBinaryToFileDirect(rawUrl, init, destPath, hosts, signal);
  }

  /**
   * Legacy in-process streaming fetch (also the fallback when the isolated
   * worker itself is unavailable). Unchanged behavior: chunk-by-chunk to
   * `destPath` with the byte cap enforced as bytes arrive.
   */
  private async requestBinaryToFileDirect(
    rawUrl: string,
    init: RequestInit,
    destPath: string,
    hosts: readonly string[] = this.allowedHosts,
    signal?: AbortSignal,
  ): Promise<FetchedImageFile> {
    const startedAt = Date.now();
    const response = await this.fetchWithRetry(rawUrl, init, hosts, signal);

    // The image cache stages into an existing directory, but be tolerant:
    // creating it here keeps this method safe for standalone callers.
    await mkdir(dirname(destPath), { recursive: true });

    const contentType = response.headers.get('content-type');
    let bytes = 0;
    try {
      bytes = await this.streamBodyToFile(response, destPath, this.maxImageBytes, signal);
    } catch (error) {
      await rm(destPath, { force: true }).catch(() => undefined);
      throw error;
    }
    logger.debug('Streamed source image to disk', {
      url: rawUrl,
      status: response.status,
      bytes,
      durationMs: Date.now() - startedAt,
      isolated: false,
    });
    return { bytes, contentType };
  }

  /**
   * Upstream image fetch in an isolated child process (see
   * fetchImageChild.ts). Same allowlist, timeout-per-attempt, retry and
   * size-cap guards as the in-process path; each attempt spawns a fresh
   * child, so any native memory grabbed below app code dies with it.
   */
  private async fetchImageToFileIsolated(
    rawUrl: string,
    init: RequestInit,
    destPath: string,
    hosts: readonly string[],
    signal?: AbortSignal,
  ): Promise<FetchedImageFile> {
    const startedAt = Date.now();
    try {
      const result = await this.fetchIsolatedWithRetries(rawUrl, init, destPath, hosts, signal);
      recordSourceRequest(this.sourceName, Date.now() - startedAt, true);
      return result;
    } catch (error) {
      recordSourceRequest(this.sourceName, Date.now() - startedAt, false);
      throw error;
    }
  }

  /** Retry loop around one isolated fetch per attempt (mirrors doFetchWithRetries). */
  private async fetchIsolatedWithRetries(
    rawUrl: string,
    init: RequestInit,
    destPath: string,
    hosts: readonly string[],
    signal?: AbortSignal,
  ): Promise<FetchedImageFile> {
    for (let attempt = 1; attempt <= this.retryCount + 1; attempt++) {
      signal?.throwIfAborted();
      try {
        return await this.spawnFetchChild(rawUrl, init, destPath, hosts, signal);
      } catch (error) {
        if (isClientAbort(error, signal)) throw error;
        if (!(error instanceof SourceNetworkError) || !isTransientError(error.rootCause, error.status ?? null)) {
          throw error;
        }
        const attemptsLeft = this.retryCount + 1 - attempt;
        if (attemptsLeft <= 0) throw this.toPublicError(error, rawUrl);
        const delay = backoffMs(this.retryBaseDelayMs, attempt);
        logger.warn('Retrying isolated image fetch after transient failure', {
          url: rawUrl,
          attempt,
          maxAttempts: this.retryCount + 1,
          delayMs: delay,
          status: error.status,
          error: error.message,
        });
        await sleepOrAbort(delay, signal);
      }
    }
    throw SourceError.unavailable(this.sourceName, rawUrl);
  }

  /**
   * One isolated fetch attempt. Resolves the child's outcome; throws
   * `ChildInfrastructureError` (→ in-process fallback) only when the worker
   * mechanism itself failed, `SourceNetworkError` for retryable fetch
   * failures, or a public `SourceError` for definitive ones.
   */
  private async spawnFetchChild(
    rawUrl: string,
    init: RequestInit,
    destPath: string,
    hosts: readonly string[],
    signal?: AbortSignal,
  ): Promise<FetchedImageFile> {
    const rawHeaders = init.headers as Record<string, string> | Headers | undefined;
    // init.headers is a plain object at every call site, but normalize a
    // Headers instance defensively — spreading one yields {} and would
    // silently drop the Referer hotlink-protection header.
    const headers: Record<string, string> =
      rawHeaders instanceof Headers ? Object.fromEntries(rawHeaders.entries()) : { ...rawHeaders };
    const payload = JSON.stringify({
      url: rawUrl,
      destPath,
      maxBytes: this.maxImageBytes,
      timeoutMs: this.timeoutMs,
      headers,
      allowedHosts: [...hosts],
    });
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn([process.execPath, FETCH_IMAGE_CHILD_PATH, payload], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });
    } catch (error) {
      throw new ChildInfrastructureError(
        `Failed to spawn image fetch worker: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }

    const startedAt = Date.now();
    try {
      const outcome = await new Promise<
        | { kind: 'ok'; bytes: number; contentType: string | null }
        | { kind: 'transient'; status: number | null; timeout: boolean; message: string }
        | { kind: 'definitive'; status: number | null; message: string }
        | { kind: 'infra'; message: string }
      >((resolve, reject) => {
        let settled = false;
        const done = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(killer);
          signal?.removeEventListener('abort', onAbort);
          fn();
        };
        // Backstop: the child enforces timeoutMs itself, but a hung worker
        // must never hold a proxy slot forever.
        const killer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // Already exited.
          }
          done(() =>
            reject(
              new SourceNetworkError(
                `Request to ${rawUrl} timed out (worker backstop)`,
                undefined,
                undefined,
                true,
              ),
            ),
          );
        }, this.timeoutMs + 10_000);
        const onAbort = (): void => {
          try {
            child.kill();
          } catch {
            // Already exited.
          }
          done(() => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')));
        };
        if (signal) {
          if (signal.aborted) {
            try {
              child.kill();
            } catch {
              // Already exited.
            }
            clearTimeout(killer);
            reject(signal.reason);
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }
        void (async () => {
          try {
            const stdout = child.stdout;
            if (!(stdout instanceof ReadableStream)) {
              done(() => reject(new ChildInfrastructureError('Image fetch worker stdout unavailable.')));
              return;
            }
            const out = await new Response(stdout).text();
            const exitCode = await child.exited;
            if (out.length > 65536) {
              done(() => reject(new ChildInfrastructureError('Image fetch worker printed oversize output.')));
              return;
            }
            let parsed: unknown = null;
            try {
              parsed = JSON.parse((out.trim().split('\n')[0] ?? '') || 'null');
            } catch {
              parsed = null;
            }
            if (!parsed || typeof parsed !== 'object' || (parsed as { ok?: unknown }).ok === undefined) {
              // Usage bug (exit 2) is ours — definitive. Anything else is a
              // crash/kill: transient and bounded by the retry count.
              if (exitCode === 2) {
                done(() => reject(SourceError.unavailable(this.sourceName, rawUrl)));
              } else {
                done(
                  () =>
                    reject(
                      new SourceNetworkError(
                        `Image fetch worker exited with code ${exitCode}`,
                        undefined,
                        undefined,
                        false,
                      ),
                    ),
                );
              }
              return;
            }
            const body = parsed as {
              ok: boolean;
              bytes?: unknown;
              contentType?: unknown;
              transient?: unknown;
              status?: unknown;
              timeout?: unknown;
              message?: unknown;
            };
            if (body.ok === true) {
              const bytes = body.bytes;
              if (typeof bytes !== 'number') {
                done(() => reject(new ChildInfrastructureError('Image fetch worker returned malformed success.')));
                return;
              }
              done(() =>
                resolve({
                  kind: 'ok',
                  bytes,
                  contentType: typeof body.contentType === 'string' ? body.contentType : null,
                }),
              );
              return;
            }
            const status = typeof body.status === 'number' ? body.status : null;
            const message = typeof body.message === 'string' ? body.message : `Request to ${rawUrl} failed.`;
            if (body.transient === true) {
              done(() =>
                reject(new SourceNetworkError(message, undefined, status ?? undefined, body.timeout === true)),
              );
            } else {
              done(() => reject(SourceError.unavailable(this.sourceName, rawUrl, status ?? undefined)));
            }
          } catch (error) {
            done(
              () =>
                reject(
                  new ChildInfrastructureError(
                    `Image fetch worker I/O failed: ${error instanceof Error ? error.message : String(error)}.`,
                  ),
                ),
            );
          }
        })();
      });

      if (outcome.kind === 'infra') {
        throw new ChildInfrastructureError(outcome.message);
      }
      if (outcome.kind === 'transient') {
        throw new SourceNetworkError(outcome.message, undefined, outcome.status ?? undefined, outcome.timeout);
      }
      if (outcome.kind === 'definitive') {
        throw SourceError.unavailable(this.sourceName, rawUrl, outcome.status ?? undefined);
      }
      // Defense in depth: the child enforces the cap, but verify the landed
      // file before the cache trusts it.
      let size = -1;
      try {
        size = (await stat(destPath)).size;
      } catch {
        size = -1;
      }
      if (size < 0 || size !== outcome.bytes || size > this.maxImageBytes) {
        await rm(destPath, { force: true }).catch(() => undefined);
        throw SourceError.unavailable(this.sourceName, rawUrl);
      }
      logger.debug('Streamed source image to disk', {
        url: rawUrl,
        status: 200,
        bytes: outcome.bytes,
        durationMs: Date.now() - startedAt,
        isolated: true,
      });
      return { bytes: outcome.bytes, contentType: outcome.contentType };
    } finally {
      // Belt and suspenders: never leave a worker behind on any path.
      try {
        child.kill();
      } catch {
        // Already exited.
      }
    }
  }

  /**
   * Pipe a response body to disk chunk by chunk (backpressure via `drain`),
   * enforcing the byte cap as bytes arrive. Only one network chunk is ever
   * held in heap. A client abort surfaces promptly via the per-chunk check
   * (the socket abort also rejects the reader); anything else propagates
   * raw, exactly like the buffered reader — the caller deletes the partial
   * file.
   */
  private async streamBodyToFile(
    response: Response,
    destPath: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<number> {
    if (!response.body) {
      await writeFile(destPath, new Uint8Array(0));
      return 0;
    }
    const stream = createWriteStream(destPath);
    let received = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel().catch(() => undefined);
          logger.warn('Source response exceeded size limit', {
            url: response.url,
            maxBodyBytes: maxBytes,
          });
          throw SourceError.unavailable(this.sourceName, response.url);
        }
        signal?.throwIfAborted();
        const chunk: Uint8Array = value;
        if (!stream.write(chunk)) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = (): void => {
              stream.off('error', onError);
              resolve();
            };
            const onError = (error: unknown): void => {
              stream.off('drain', onDrain);
              reject(error);
            };
            stream.once('drain', onDrain);
            stream.once('error', onError);
          });
        }
      }
    } catch (error) {
      stream.destroy();
      throw error;
    }
    await new Promise<void>((resolve, reject) => {
      stream.once('error', reject);
      stream.end(() => resolve());
    });
    return received;
  }

  /**
   * Retry loop around `doFetch` + `assertResponseOk` for transient failures.
   *
   * Each attempt gets a FRESH `timeoutMs` budget (a retry that waits out the
   * full timeout then times out would exceed the user's latency expectation).
   * Transient failures sleep in jittered exponential backoff before the next
   * attempt; definitive failures (SSRF rejections, other 4xx) propagate
   * immediately. The final error maps to the public `SourceError` shape the
   * rest of the codebase expects (timeout vs. unavailable vs. upstream status).
   */
  private async fetchWithRetry(
    rawUrl: string,
    init: RequestInit,
    hosts: readonly string[],
    signal?: AbortSignal,
  ): Promise<Response> {
    const startedAt = Date.now();
    try {
      const response = await this.doFetchWithRetries(rawUrl, init, hosts, signal);
      recordSourceRequest(this.sourceName, Date.now() - startedAt, true);
      return response;
    } catch (error) {
      recordSourceRequest(this.sourceName, Date.now() - startedAt, false);
      throw error;
    }
  }

  private async doFetchWithRetries(
    rawUrl: string,
    init: RequestInit,
    hosts: readonly string[],
    signal?: AbortSignal,
  ): Promise<Response> {
    for (let attempt = 1; attempt <= this.retryCount + 1; attempt++) {
      // Never start (or retry) for a reader that already went away.
      signal?.throwIfAborted();
      try {
        const response = await this.doFetch(rawUrl, init, signal);
        this.assertResponseOk(response, rawUrl, hosts);
        return response;
      } catch (error) {
        // Intentional client aborts propagate raw and are never retried.
        if (isClientAbort(error, signal)) throw error;
        // Only transient failures (timeout, network error, 429, 5xx) are
        // retried. Definitive failures (SSRF rejections, other 4xx, redirects
        // out of the allowlist) propagate unchanged — retrying those would
        // either loop forever or hammer the source.
        if (!(error instanceof SourceNetworkError) || !isTransientError(error.rootCause, error.status ?? null)) {
          throw error;
        }
        const attemptsLeft = this.retryCount + 1 - attempt;
        if (attemptsLeft <= 0) throw this.toPublicError(error, rawUrl);

        const delay = backoffMs(this.retryBaseDelayMs, attempt);
        logger.warn('Retrying source request after transient failure', {
          url: rawUrl,
          attempt,
          maxAttempts: this.retryCount + 1,
          delayMs: delay,
          status: error.status,
          error: error.message,
        });
        await sleepOrAbort(delay, signal);
      }
    }
    // Unreachable — the loop always throws or returns.
    throw SourceError.unavailable(this.sourceName, rawUrl);
  }

  /** Map a transient failure into the public error shape once retries are done. */
  private toPublicError(error: SourceNetworkError, rawUrl: string): unknown {
    if (error.isTimeout || !error.status) {
      return SourceError.timeout(this.sourceName, rawUrl);
    }
    return SourceError.unavailable(this.sourceName, rawUrl, error.status);
  }

  private async readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) return response.text();
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let received = 0;
    let result = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        logger.warn('Source response exceeded size limit', {
          url: response.url,
          maxBodyBytes: maxBytes,
        });
        throw SourceError.unavailable(this.sourceName, response.url);
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  }

  private async readBytesWithLimit(response: Response, maxBytes: number): Promise<ArrayBuffer> {
    if (!response.body) {
      return new ArrayBuffer(0);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        logger.warn('Source response exceeded size limit', {
          url: response.url,
          maxBodyBytes: maxBytes,
        });
        throw SourceError.unavailable(this.sourceName, response.url);
      }
      chunks.push(value);
    }
    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out.buffer;
  }
}
