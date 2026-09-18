/** URL helpers shared by source adapters. */

/**
 * True when `url` points at the same host (or a subdomain of it) as
 * `baseUrl`. Mirrors the SourceHttpClient allowlist semantics so a pasted
 * link can only ever resolve against the source it actually belongs to.
 */
export function isSameHost(url: string, baseUrl: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const base = new URL(baseUrl).hostname.toLowerCase();
    return host === base || host.endsWith(`.${base}`);
  } catch {
    return false;
  }
}
