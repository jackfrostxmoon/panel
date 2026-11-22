import { Hono } from 'hono';
import { getConnInfo } from 'hono/bun';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { ErrorCodes, ok } from '@panel/shared';
import { safeEqual, type PairedDevices } from '../lib/pairedDevices.js';
import { AppError } from '../lib/errors.js';
import { DEVICE_COOKIE } from '../middleware/accessToken.js';

const DEVICE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
/** Safety cap so a leaked pairing secret can't fill the data dir. */
const MAX_PAIRED_DEVICES = 32;

/**
 * Per-device LAN pairing endpoints.
 *
 *   POST   /api/devices/pair          exchange a pairing secret/code for this
 *                                     device's own record + HttpOnly cookie
 *   POST   /api/devices/pairing-code  mint a one-time code (Share dialog)
 *   GET    /api/devices               list paired devices (no secrets)
 *   DELETE /api/devices/:id           revoke one device
 *
 * The gate in middleware/accessToken.ts lets `/pair` through unauthenticated
 * (it carries the pairing credential in its body) and requires a paired
 * device for everything else.
 */
export function deviceRoutes(devices: PairedDevices, pairingSecret: string | undefined): Hono {
  const app = new Hono();

  app.post('/pair', async (c) => {
    if (!pairingSecret) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'Device pairing is not enabled on this server.');
    }
    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (devices.list().length >= MAX_PAIRED_DEVICES) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Too many paired devices — revoke one first (GET /api/devices).',
        undefined,
        409,
      );
    }
    // The terminal QR/link carries the long-lived pairing secret; the Share
    // dialog hands out single-use codes. Both are burned here (a secret is
    // reusable, a code is not).
    const accepted = (token !== '' && safeEqual(token, pairingSecret)) || devices.consumePairingCode(token);
    if (!accepted) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'This pairing link is invalid or has expired — scan the QR code in the server terminal again.',
        undefined,
        403,
      );
    }
    const { device, token: deviceToken } = devices.mint({
      ip: peerAddress(c),
      userAgent: c.req.header('user-agent') ?? null,
    });
    setCookie(c, DEVICE_COOKIE, deviceToken, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS,
    });
    return c.json(ok({ deviceId: device.id }), 201);
  });

  app.post('/pairing-code', (c) => {
    return c.json(ok({ code: devices.createPairingCode() }));
  });

  app.get('/', (c) => {
    return c.json(ok(devices.list()));
  });

  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    if (!devices.revoke(id)) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'Unknown device.');
    }
    // Revoking the calling device also drops its cookie immediately.
    const current = getCookie(c, DEVICE_COOKIE);
    if (current && devices.idFromToken(current) === id) {
      deleteCookie(c, DEVICE_COOKIE, { path: '/' });
    }
    return c.json(ok({ id, revoked: true }));
  });

  return app;
}

function peerAddress(c: Context): string | null {
  try {
    return getConnInfo(c)?.remote?.address ?? null;
  } catch {
    return null;
  }
}
