/**
 * Tiny synchronous SHA-256 implementation (FIPS 180-4) for the browser.
 *
 * Used by the image-cache settings page to correlate chapter global-ids
 * (e.g. `mk:solo-leveling.21708~c200`) with the on-disk 8-hex-char cache
 * tag hash that the API's `ImageCache` derives via `createHash('sha256')`.
 *
 * The browser ships `crypto.subtle.digest('SHA-256', …)` but it is
 * Promise-only, which would force the drill-in dialog to render chapters
 * in a flash-of-empty state. SHA-256 is fast on small UTF-8 strings (a
 * few hundred chapter ids is microseconds), so an in-JS synchronous
 * implementation gives the UI a steady first paint without a network
 * round-trip.
 *
 * Returns the lowercase hex digest. NOT a general-purpose crypto
 * primitive — kept here so the cache-tag correlation is reproducible
 * across server and client without a dependency on Node's `node:crypto`.
 */

function rotr(n: number, x: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Pack four 8-bit values into a 32-bit big-endian word. */
function toWord32(bs: number[], offset: number): number {
  return ((bs[offset]! & 0xff) << 24) |
    ((bs[offset + 1]! & 0xff) << 16) |
    ((bs[offset + 2]! & 0xff) << 8) |
    (bs[offset + 3]! & 0xff);
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of a UTF-8 string. Returns lowercase hex (64 chars). */
export function sha256Hex(input: string): string {
  // Encode UTF-8 bytes.
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let c = input.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0xd800 || c >= 0xe000) {
      bytes.push(
        0xe0 | (c >> 12),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    } else {
      // Surrogate pair → code point.
      i++;
      const lo = input.charCodeAt(i);
      c = 0x10000 + (((c & 0x3ff) << 10) | (lo & 0x3ff));
      bytes.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    }
  }

  const bitLen = bytes.length * 8;
  // Append 0x80, pad with zeros until length ≡ 56 (mod 64), append 64-bit length.
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // Length as 64-bit big-endian. JS bitwise ops are 32-bit, so high word is 0 for strings we care about.
  const hi = Math.floor(bitLen / 0x100000000) >>> 0;
  const lo = (bitLen >>> 0) as number;
  bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
  bytes.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

  // Initial hash values (FIPS 180-4 §5.3.3).
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let chunk = 0; chunk < bytes.length; chunk += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = toWord32(bytes, chunk + t * 4);
    }
    for (let t = 16; t < 64; t++) {
      const w15 = w[t - 15]!;
      const w2 = w[t - 2]!;
      const s0 = rotr(7, w15) ^ rotr(18, w15) ^ (w15 >>> 3);
      const s1 = rotr(17, w2) ^ rotr(19, w2) ^ (w2 >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let cc = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let t = 0; t < 64; t++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t]! + w[t]!) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & cc) ^ (b & cc);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = cc;
      cc = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + cc) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return (
    h0.toString(16).padStart(8, '0') +
    h1.toString(16).padStart(8, '0') +
    h2.toString(16).padStart(8, '0') +
    h3.toString(16).padStart(8, '0') +
    h4.toString(16).padStart(8, '0') +
    h5.toString(16).padStart(8, '0') +
    h6.toString(16).padStart(8, '0') +
    h7.toString(16).padStart(8, '0')
  );
}

/**
 * 8-hex-char cache tag prefix for an image-cache provenance id, matching
 * the server-side `ImageCache.tagPrefix` (`sha256(tag).slice(0, 8)`).
 *
 * Memoized: the cache page hashes every panel id on every render (plus
 * per sort comparison), so without this hundreds of titles re-pay the
 * synchronous hash on each keystroke/focus and typing lags for seconds.
 * Bounded (FIFO eviction past the cap) so a huge library can't pin memory.
 */
const tagPrefixMemo = new Map<string, string>();
const TAG_PREFIX_MEMO_MAX = 5000;

export function cacheTagPrefix(tag: string): string {
  const hit = tagPrefixMemo.get(tag);
  if (hit !== undefined) return hit;
  const prefix = sha256Hex(tag).slice(0, 8);
  tagPrefixMemo.set(tag, prefix);
  if (tagPrefixMemo.size > TAG_PREFIX_MEMO_MAX) {
    const oldest = tagPrefixMemo.keys().next();
    if (!oldest.done) tagPrefixMemo.delete(oldest.value);
  }
  return prefix;
}