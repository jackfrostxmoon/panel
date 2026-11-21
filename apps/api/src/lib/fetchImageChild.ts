/**
 * Out-of-process upstream image fetcher.
 *
 * Run as a short-lived child (`bun fetchImageChild.ts '<json>'`) by
 * `SourceHttpClient.fetchImageToFile` when isolated fetching is enabled.
 * Rationale: intermittent ~400 MB native RSS grabs have been observed on
 * upstream image misses that survive even a forced full GC — the grab lives
 * below app code (Bun's fetch/streaming path). Running the fetch in a child
 * contains it: when the child exits the OS reclaims ALL of its pages, so a
 * grab can never stick to the long-lived server process.
 *
 * Self-contained by design: only node builtins, zero app imports (no logger,
 * no config) so startup stays lean and a child crash can never take server
 * state with it. The parent pre-validates the URL against the SSRF
 * allowlist; the child re-validates independently (including the final URL
 * after redirects) — a compromised or buggy caller cannot turn this into an
 * unrestricted proxy.
 *
 * Protocol: argv[2] is JSON
 * `{ url, destPath, maxBytes, timeoutMs, headers, allowedHosts }`.
 * Always prints exactly one JSON line on stdout and exits 0:
 * - `{ ok: true, bytes, contentType }` on success (bytes = file size).
 * - `{ ok: false, transient, status?, timeout?, message }` on any handled
 *   failure (`transient` mirrors the in-process retry policy: timeouts,
 *   network errors, 429/5xx; everything else is definitive).
 * Exit 2 = unusable arguments (definitive, never retried). Any other
 * nonzero exit (crash/kill) is treated as transient by the parent, bounded
 * by its retry count. Partial files are always deleted on failure.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

interface ChildRequest {
  url: string;
  destPath: string;
  maxBytes: number;
  timeoutMs: number;
  headers: Record<string, string>;
  allowedHosts: string[];
}

type ChildResult =
  | { ok: true; bytes: number; contentType: string | null }
  | { ok: false; transient: boolean; status?: number; timeout?: boolean; message: string };

function fail(
  message: string,
  opts?: { transient?: boolean; status?: number; timeout?: boolean },
): never {
  const result: ChildResult = {
    ok: false,
    transient: opts?.transient ?? false,
    message,
  };
  if (opts?.status !== undefined) result.status = opts.status;
  if (opts?.timeout !== undefined) result.timeout = opts.timeout;
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0);
}

/** Same rule as the in-process SSRF guard: exact host or subdomain, http(s) only. */
function hostAllowed(rawUrl: string, allowedHosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

async function streamBodyToFile(
  response: Response,
  destPath: string,
  maxBytes: number,
  sourceUrl: string,
): Promise<number> {
  if (!response.body) {
    await rm(destPath, { force: true }).catch(() => undefined);
    fail(`Empty response body for ${sourceUrl}.`);
  }
  await mkdir(dirname(destPath), { recursive: true });
  const stream = createWriteStream(destPath);
  let received = 0;
  try {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw { overCap: true };
      }
      if (!stream.write(value)) {
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
    await rm(destPath, { force: true }).catch(() => undefined);
    if (error !== null && typeof error === 'object' && 'overCap' in error) {
      fail(`Response for ${sourceUrl} exceeded the ${maxBytes}-byte cap.`);
    }
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.end(() => resolve());
  });
  return received;
}

async function main(): Promise<void> {
  let req: ChildRequest;
  try {
    req = JSON.parse(process.argv[2] ?? '') as ChildRequest;
  } catch {
    process.stderr.write('fetchImageChild: argv[2] must be a JSON request object.\n');
    process.exit(2);
  }
  const { url, destPath, maxBytes, timeoutMs, headers, allowedHosts } = req;
  if (
    typeof url !== 'string' ||
    typeof destPath !== 'string' ||
    !Number.isFinite(maxBytes) ||
    !Number.isFinite(timeoutMs) ||
    typeof headers !== 'object' ||
    headers === null ||
    !Array.isArray(allowedHosts)
  ) {
    process.stderr.write('fetchImageChild: malformed request object.\n');
    process.exit(2);
  }

  if (!hostAllowed(url, allowedHosts.map((h) => String(h).toLowerCase()))) {
    fail(`URL host is not allowlisted: ${url}.`);
  }

  // One timeout budget shared by every hop (the previous redirect:'follow'
  // path applied one signal to the whole chain too).
  const signal = AbortSignal.timeout(timeoutMs);

  // Redirects are followed MANUALLY, one hop at a time, with every hop
  // re-validated against the allowlist BEFORE it is requested — the
  // previous follow-then-check-final-URL pattern let a hostile source
  // bounce the Referer/User-Agent headers through an off-list host (plain
  // headers are re-sent on cross-origin redirects per the fetch spec).
  let currentUrl = url;
  let response: Response | null = null;
  for (let hop = 0; hop < 10; hop++) {
    let attempt: Response;
    try {
      attempt = await fetch(currentUrl, {
        headers,
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        fail(`Request to ${url} timed out after ${timeoutMs}ms.`, { transient: true, timeout: true });
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        fail(`Request to ${url} was aborted.`, { transient: true, timeout: true });
      }
      if (error instanceof TypeError) {
        fail(`Request to ${url} failed: ${error.message}.`, { transient: true });
      }
      fail(`Request to ${url} failed.`, { transient: false });
    }
    if (attempt.status >= 300 && attempt.status < 400) {
      const location = attempt.headers.get('location');
      if (location) {
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          fail(`Redirect Location for ${url} could not be resolved: ${location}.`);
        }
        if (!hostAllowed(nextUrl.toString(), allowedHosts.map((h) => String(h).toLowerCase()))) {
          fail(`Redirect left the allowlist: ${url} -> ${nextUrl.toString()}.`);
        }
        currentUrl = nextUrl.toString();
        continue;
      }
      // 3xx without Location — return it to the standard status handling.
      response = attempt;
      break;
    }
    response = attempt;
    break;
  }
  if (response === null) {
    // Exhausted the hop budget without reaching a non-redirect response.
    fail(`Redirect hop limit reached for ${url}.`, { transient: false });
  }

  if (!response.ok) {
    const status = response.status;
    if (status === 429 || (status >= 500 && status < 600)) {
      fail(`${url} returned transient HTTP ${status}.`, { transient: true, status });
    }
    fail(`${url} returned HTTP ${status}.`, { transient: false, status });
  }

  // Landing host was validated per hop above; keep the check as
  // belt-and-suspenders against platform quirks.
  if (response.url && !hostAllowed(response.url, allowedHosts.map((h) => String(h).toLowerCase()))) {
    fail(`Redirect left the allowlist: ${url} -> ${response.url}.`);
  }

  const contentType = response.headers.get('content-type');
  let bytes = 0;
  try {
    bytes = await streamBodyToFile(response, destPath, maxBytes, url);
  } catch (error) {
    fail(`Streaming ${url} failed: ${error instanceof Error ? error.message : String(error)}.`, {
      transient: false,
    });
  }
  const result: ChildResult = { ok: true, bytes, contentType };
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0);
}

void main().catch((error: unknown) => {
  process.stderr.write(`fetchImageChild crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
