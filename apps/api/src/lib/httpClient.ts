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
  /** Maximum IMAGE response size in bytes (default 8 MiB). */
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
    this.maxImageBytes = options.maxImageBytes ?? 8 * 1024 * 1024;
    this.retryCount = options.retryCount ?? DEFAULT_RETRY_COUNT;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
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
