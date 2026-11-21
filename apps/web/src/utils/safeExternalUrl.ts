/**
 * Scheme-safe external URL for links rendered from remote data.
 *
 * `sourceUrl` values come from scraped third-party pages — fully
 * attacker-influenced content. React's own URL sanitizer already neutralizes
 * `javascript:` hrefs, but this helper gives the app its own scheme check
 * so the invariant doesn't depend on React internals (and can be reused
 * anywhere a scraped URL becomes a link, including future non-React sinks
 * like `window.open`).
 *
 * Returns the URL unchanged for http(s), null for anything else
 * (`javascript:`, `data:`, `vbscript:`, unparseable junk) — callers render
 * the fallback (plain text) when null.
 */
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}
