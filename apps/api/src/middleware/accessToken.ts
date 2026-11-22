import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { getConnInfo } from 'hono/bun';
import { ErrorCodes, fail } from '@panel/shared';
import { safeEqual, type PairedDevices } from '../lib/pairedDevices.js';

/**
 * Device gate for non-localhost callers.
 *
 * Pairing is per device (see lib/pairedDevices.ts): the web client trades the
 * pairing secret from the terminal QR/link (`?token=…`, or a one-time code
 * minted by the Share dialog) for an HttpOnly `panel-device` cookie that the
 * browser then sends on every request.
 *
 *   - requests from a loopback peer (the host PC) pass freely;
 *   - a paired device passes (cookie, or `X-Panel-Token` / `?token=` for
 *     scripted callers);
 *   - a request carrying a valid pairing credential may load the app shell
 *     (it pairs itself before rendering); the pair endpoint validates its own
 *     body so it stays reachable for the first, cookie-less request;
 *   - everything else is refused. `/api/*` keeps the JSON error envelope;
 *     a document navigation gets a truly EMPTY page, so an unpaired device
 *     never loads the app or any data. Static assets stay open (they carry no
 *     user data) so a freshly paired page can finish booting.
 *
 * With no pairing secret configured (`ACCESS_TOKEN` unset) the gate is off and
 * the server binds loopback (see `BIND_ALL` in index.ts).
 */
export interface DeviceGateOptions {
  devices: PairedDevices;
  /** ACCESS_TOKEN — the pairing secret printed in the terminal QR/link. */
  pairingSecret: string | undefined;
}

/** Cookie that carries this device's token (HttpOnly, set by /api/devices/pair). */
export const DEVICE_COOKIE = 'panel-device';

/** Served instead of the SPA to an unpaired device — deliberately blank. */
const EMPTY_DOCUMENT =
  '<!doctype html><html><head><meta charset="utf-8"><title></title></head><body></body></html>';

export function deviceGate({ devices, pairingSecret }: DeviceGateOptions): MiddlewareHandler {
  return async (c, next) => {
    if (!pairingSecret) return next();

    if (isLoopbackPeer(c)) return next();

    const deviceToken = getCookie(c, DEVICE_COOKIE);

    // Any of these may carry this device's token: the HttpOnly cookie (the
    // normal path), `X-Panel-Token` (scripted callers) or `?token=` (legacy
    // image URLs and pasted links). Check every `token` query value — the
    // first-match semantics of `query()` would hide a valid later value.
    const candidates = [
      deviceToken,
      c.req.header('x-panel-token'),
      ...(c.req.queries('token') ?? []),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    for (const candidate of candidates) {
      if (devices.verify(candidate)) return next();
    }

    const pairing = candidates.some(
      (value) => safeEqual(value, pairingSecret) || devices.checkPairingCode(value),
    );

    const path = c.req.path;
    // The pair endpoint authenticates itself from the credential in its body
    // (the client has not received a cookie yet), so it must stay reachable.
    if (path === '/api/devices/pair') return next();

    if (pairing && !path.startsWith('/api/')) {
      // The shell may load (it pairs itself before rendering — see main.tsx).
      return next();
    }

    if (path.startsWith('/api/')) {
      return c.json(
        fail(
          ErrorCodes.VALIDATION_ERROR,
          'Unauthorized — pair this device from the host PC (scan the QR in the server terminal).',
        ),
        403,
      );
    }

    if (isDocumentNavigation(c)) {
      return c.html(EMPTY_DOCUMENT, 403, { 'Cache-Control': 'no-store' });
    }

    return next();
  };
}

/** True when the TCP peer is this machine (loopback address on IPv4/IPv6). */
function isLoopbackPeer(c: Context): boolean {
  try {
    const address = getConnInfo(c)?.remote?.address;
    if (!address) return false;
    const normalized = address.replace(/^::ffff:/, '');
    return normalized === '127.0.0.1' || normalized === '::1';
  } catch {
    // No conn info available — treat as remote (fail closed when a token is set).
    return false;
  }
}

/** The browser tells us this is a page load (as opposed to a fetch/asset). */
function isDocumentNavigation(c: Context): boolean {
  const dest = c.req.header('sec-fetch-dest');
  if (dest) return dest === 'document';
  return (c.req.header('accept') ?? '').includes('text/html');
}
