/**
 * Batch-id minting for prefetch queue batches.
 *
 * Extracted pure (no React, no DOM) so the insecure-origin fallback is
 * unit-testable: `crypto.randomUUID()` exists ONLY in secure contexts
 * (https / localhost). The app is routinely opened over plain-LAN HTTP
 * (phone on hotspot → `http://192.168.x.x:5173`), where `randomUUID` is
 * `undefined` and a direct call throws a TypeError that kills the whole
 * download before any network request fires.
 *
 * `crypto.getRandomValues`, by contrast, is available in BOTH secure and
 * insecure contexts — so the fallback below keeps batch downloads working
 * everywhere.
 */

/** UUIDv4 from `getRandomValues` (works in insecure contexts too). */
function uuidv4Fallback(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // RFC 4122 section 4.4: version + variant bits.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/** Mint a batch id. Never throws, even on insecure (plain-HTTP LAN) origins. */
export function newBatchId(): string {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Ignore and fall through — some browsers throw instead of
    // returning undefined on odd configurations.
  }
  return uuidv4Fallback();
}
