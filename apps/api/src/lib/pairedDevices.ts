import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Per-device LAN pairing records.
 *
 * Every device that pairs gets its own file under the devices directory
 * (`DEVICES_DIR`, default `data/devices/`):
 *
 *   data/devices/<deviceId>.json          { id, createdAt, lastSeenAt, ip, userAgent, tokenHash }
 *   data/devices/pairing/<codeHash>.json  { createdAt, expiresAt }  ← one-time codes
 *
 * The raw device token is never written to disk — only its SHA-256 hash — so
 * reading the data directory can't be used to impersonate a phone. Pairing
 * codes are short-lived, single-use, and also stored hashed.
 *
 * Devices are identified by a `<id>.<secret>` token:
 *   - the server sets it as an HttpOnly `panel-device` cookie (see
 *     middleware/accessToken.ts) — browsers send it on documents, fetches and
 *     `<img>` requests alike, so the web app never stores a token in JS;
 *   - `X-Panel-Token` / `?token=` are still accepted for scripted callers.
 *
 * Revoking a device is just deleting its file (the server picks the change up
 * on the next request) or calling `revoke()`.
 */

export interface PairedDevice {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
}

interface StoredDevice extends PairedDevice {
  tokenHash: string;
}

interface PairingCodeRecord {
  createdAt: string;
  expiresAt: string;
}

/** One-time pairing codes (Share dialog) live 15 minutes. */
const PAIRING_CODE_TTL_MS = 15 * 60_000;
/** `lastSeenAt` is persisted at most once a minute per device. */
const TOUCH_THROTTLE_MS = 60_000;
/**
 * Re-read the directory at most this often when a token is unknown, so files
 * deleted (or copied in) outside this process take effect without a restart
 * while an unauthenticated flood can't turn every request into a disk walk.
 */
const RELOAD_MS = 2_000;

const PAIRING_SUBDIR = 'pairing';
const TOKEN_RE = /^([a-f0-9]{12})\.([a-f0-9]{32})$/;
const CODE_RE = /^[a-f0-9]{32}$/;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time string comparison (length is not a secret here). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class PairedDevices {
  private readonly records = new Map<string, StoredDevice>();
  private readonly lastTouchAt = new Map<string, number>();
  private loadedAt = 0;

  constructor(private readonly dir: string) {}

  private get pairingDir(): string {
    return join(this.dir, PAIRING_SUBDIR);
  }

  /** Load (or refresh) the on-disk records into memory. */
  private ensureLoaded(force = false): void {
    const now = Date.now();
    if (!force && now - this.loadedAt < RELOAD_MS) return;
    this.loadedAt = now;
    this.records.clear();
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return; // No directory yet — no paired devices.
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const record = readDeviceFile(join(this.dir, entry));
      if (record) this.records.set(record.id, record);
    }
  }

  /**
   * Validate a device token. Returns the matching record (with `lastSeenAt`
   * refreshed) or null. Unknown ids trigger a throttled disk reload so a
   * device paired by another process (or a deleted file) is seen promptly.
   */
  verify(token: string): PairedDevice | null {
    const parsed = TOKEN_RE.exec(token);
    if (!parsed) return null;
    const [, id, secret] = parsed;
    let record = this.lookup(id!);
    if (!record) record = this.lookup(id!, true);
    if (!record) return null;
    if (!safeEqual(record.tokenHash, sha256(secret!))) return null;
    // A manually deleted file must revoke immediately — without this, a
    // record already loaded in memory would keep working until restart.
    if (!existsSync(join(this.dir, `${record.id}.json`))) {
      this.records.delete(record.id);
      this.lastTouchAt.delete(record.id);
      return null;
    }
    this.touch(record);
    return toPublic(record);
  }

  private lookup(id: string, force = false): StoredDevice | undefined {
    this.ensureLoaded(force);
    return this.records.get(id);
  }

  /** Device id behind a token, without validating the secret. */
  idFromToken(token: string): string | null {
    return TOKEN_RE.exec(token)?.[1] ?? null;
  }

  /** Create a device record and return its raw token (shown nowhere but the cookie). */
  mint(meta: { ip: string | null; userAgent: string | null }): {
    device: PairedDevice;
    token: string;
  } {
    const id = randomBytes(6).toString('hex');
    const secret = randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    const record: StoredDevice = {
      id,
      createdAt: now,
      lastSeenAt: now,
      ip: meta.ip,
      userAgent: meta.userAgent,
      tokenHash: sha256(secret),
    };
    mkdirSync(this.dir, { recursive: true });
    // Write-then-rename so a crash mid-write can't leave a half-parsed file.
    const tmp = join(this.dir, `.${id}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    renameSync(tmp, join(this.dir, `${id}.json`));
    this.records.set(id, record);
    this.loadedAt = Date.now();
    return { device: toPublic(record), token: `${id}.${secret}` };
  }

  /** Paired devices, newest first. Never exposes token hashes. */
  list(): PairedDevice[] {
    this.ensureLoaded(true);
    return [...this.records.values()]
      .map(toPublic)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  revoke(id: string): boolean {
    if (!/^[a-f0-9]{12}$/.test(id)) return false;
    const file = join(this.dir, `${id}.json`);
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    this.records.delete(id);
    this.lastTouchAt.delete(id);
    return true;
  }

  /* --- One-time pairing codes (Share dialog) ------------------------------ */

  /** Mint a single-use pairing code (valid for 15 minutes). */
  createPairingCode(): string {
    const code = randomBytes(16).toString('hex');
    const now = Date.now();
    const record: PairingCodeRecord = {
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PAIRING_CODE_TTL_MS).toISOString(),
    };
    mkdirSync(this.pairingDir, { recursive: true });
    this.prunePairingCodes(now);
    writeFileSync(this.pairingCodeFile(code), `${JSON.stringify(record)}\n`, 'utf8');
    return code;
  }

  /** True when the code exists and hasn't expired (does not consume it). */
  checkPairingCode(code: string): boolean {
    if (!CODE_RE.test(code)) return false;
    const file = this.pairingCodeFile(code);
    try {
      const record = JSON.parse(readFileSync(file, 'utf8')) as PairingCodeRecord;
      if (Date.parse(record.expiresAt) <= Date.now()) {
        rmSync(file, { force: true });
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Validate and burn a pairing code — the second use always fails. */
  consumePairingCode(code: string): boolean {
    if (!this.checkPairingCode(code)) return false;
    try {
      rmSync(this.pairingCodeFile(code), { force: true });
      return true;
    } catch {
      return false;
    }
  }

  private pairingCodeFile(code: string): string {
    return join(this.pairingDir, `${sha256(code)}.json`);
  }

  private prunePairingCodes(now: number): void {
    let entries: string[];
    try {
      entries = readdirSync(this.pairingDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const file = join(this.pairingDir, entry);
      try {
        const record = JSON.parse(readFileSync(file, 'utf8')) as PairingCodeRecord;
        if (Date.parse(record.expiresAt) <= now) rmSync(file, { force: true });
      } catch {
        rmSync(file, { force: true });
      }
    }
  }

  private touch(record: StoredDevice): void {
    const now = Date.now();
    if (now - (this.lastTouchAt.get(record.id) ?? 0) < TOUCH_THROTTLE_MS) return;
    this.lastTouchAt.set(record.id, now);
    record.lastSeenAt = new Date(now).toISOString();
    try {
      writeFileSync(
        join(this.dir, `${record.id}.json`),
        `${JSON.stringify(record, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // Best-effort — a read-only data dir still authenticates the device.
    }
  }
}

function toPublic(record: StoredDevice): PairedDevice {
  return {
    id: record.id,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    ip: record.ip,
    userAgent: record.userAgent,
  };
}

function readDeviceFile(file: string): StoredDevice | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredDevice>;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.lastSeenAt !== 'string' ||
      typeof parsed.tokenHash !== 'string'
    ) {
      return null;
    }
    return {
      id: parsed.id,
      createdAt: parsed.createdAt,
      lastSeenAt: parsed.lastSeenAt,
      ip: typeof parsed.ip === 'string' ? parsed.ip : null,
      userAgent: typeof parsed.userAgent === 'string' ? parsed.userAgent : null,
      tokenHash: parsed.tokenHash,
    };
  } catch {
    return null; // Malformed/partial file — ignore it rather than crash boot.
  }
}
