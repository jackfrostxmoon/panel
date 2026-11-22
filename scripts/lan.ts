/**
 * Bun-only LAN entry point: serve the built web app + API on one port
 * (default 80) so other devices on the same network can open the app
 * with a bare IP, e.g. `http://192.168.100.196` — no `:port`, no Docker.
 *
 * Usage:
 *   bun run lan                  # build web, then serve on port 80
 *   bun run lan -- --silent      # suppress API logs (useful for running in a tray/autostart)
 *   bun run lan -- --port 8080    # non-privileged fallback (then open http://<ip>:8080)
 *   bun run lan -- --smol        # low-memory API runtime (smaller JS heap,
 *                              # more frequent GC — for RAM-constrained hosts)
 *   bun run lan -- --backup-scope minimal  # on-exit auto-backup dumps
 *                              # bookmark data only (no caches); default is full
 *
 * The `--smol` flag (or `BUN_SMOL=1` in the environment, which `lan.bat`
 * sets from its optional second argument) starts the API child as
 * `bun --smol …`: Bun's small-footprint JSC mode. Measured effect on the
 * grid + chapter paths is small (most RSS lives outside the JS heap), but
 * it lowers the baseline and never hurts a single-user server.
 *
 * On-exit auto-backup scope precedence: `--backup-scope` flag >
 * `BACKUP_SCOPE` env var > default `full` (see BACKUP_SCOPE in
 * .env.example). `lan.bat` asks Full/Minimal on every launch unless given
 * `full`/`minimal` as its first argument.
 *
 * Security posture: the API child runs with NODE_ENV=production (locks CORS
 * to the allowlist + same-host origins) and BIND_ALL=1 (opt-in to LAN
 * binding). An ACCESS_TOKEN is always provided — an env-set one wins;
 * otherwise a random 32-hex token is generated once and persisted in
 * `data/lan-token` — so LAN callers must be paired devices (see
 * apps/api/src/lib/pairedDevices.ts), while the host PC (loopback) stays
 * pairing-free. The printed LAN link carries `?token=…` for one-tap pairing
 * on phones, and a scannable QR of that link is rendered right in the
 * terminal (uses apps/web's qrcode package; suppressed in --silent mode like
 * the other launcher logs).
 *
 * Port precedence: `--port` flag > `LAN_PORT` env var > default 80.
 * NOTE: the generic `PORT` env var is intentionally ignored here because Bun
 * auto-loads `.env` (which sets `PORT=3001` for dev) into process.env — so a
 * plain `bun run lan` would otherwise silently serve 3001 instead of 80.
 * The chosen port is passed explicitly to the API child, which overrides
 * the `.env` value (real env wins over dotenv files).
 *
 * Notes:
 * - The API already binds 0.0.0.0 and serves apps/web/dist when it exists
 *   (see apps/api/src/index.ts), so one process serves everything.
 * - Port 80 is privileged on macOS/Linux (run with sudo) and may need an
 *   Administrator terminal + a firewall "Allow" prompt on first run
 *   on Windows. If binding fails, re-run with `-- --port 8080`.
 */
import { networkInterfaces } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === `--${name}` && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function pickLanAddress(): string | null {
  const candidates: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      candidates.push(a.address);
    }
  }
  const rank = (ip: string): number => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  candidates.sort((x, y) => rank(x) - rank(y));
  return candidates[0] ?? null;
}

const rawPort = parseArg('port') ?? process.env.LAN_PORT ?? '80';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid port: ${rawPort}. Use 1-65535.`);
  process.exit(1);
}

const silent = hasFlag('silent');
// Low-memory API runtime: `--smol` flag or `BUN_SMOL=1` env (the latter is
// how `lan.bat` opts in — batch-arg parsing only handles one positional).
const smol =
  hasFlag('smol') || process.env.BUN_SMOL === '1' || process.env.BUN_SMOL === 'true';
const backupScope = parseArg('backup-scope') ?? process.env.BACKUP_SCOPE ?? 'full';
if (backupScope !== 'full' && backupScope !== 'minimal') {
  console.error(`Invalid backup scope: ${backupScope}. Use "full" or "minimal".`);
  process.exit(1);
}

/**
 * Pairing secret for LAN devices. An ACCESS_TOKEN set in the environment
 * wins; otherwise one is generated once (32 hex chars) and persisted in
 * `data/lan-token` so restarts keep the same secret — existing pairings (one
 * record per device in `data/devices/`) stay valid. A device takes the
 * secret from the printed link/QR once and receives its own token; the
 * secret itself is never stored on the device. Loopback (the host PC) needs
 * no pairing at all.
 */
function loadOrCreateLanToken(): string {
  const fromEnv = process.env.ACCESS_TOKEN;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const tokenPath = 'data/lan-token';
  try {
    if (existsSync(tokenPath)) {
      const existing = readFileSync(tokenPath, 'utf8').trim();
      if (existing.length >= 16) return existing;
    }
  } catch {
    // Unreadable — regenerate below.
  }
  const token = randomBytes(16).toString('hex');
  try {
    mkdirSync('data', { recursive: true });
    writeFileSync(tokenPath, `${token}\n`, 'utf8');
  } catch {
    // Best-effort persistence; the freshly generated token still works
    // for this run (printed below).
  }
  return token;
}

const accessToken = loadOrCreateLanToken();

/**
 * Terminal QR code for the pairing link (scan with a phone camera → opens
 * the LAN URL with the token pre-filled → the app pairs on first load).
 *
 * `qrcode` is a dependency of apps/web (the Share dialog uses it) and is
 * not hoisted to the root workspace, so it is required through the web
 * package's resolution context — no extra install. Best-effort: a QR
 * failure just skips the picture, the plain link is always printed.
 */
async function renderPairingQr(url: string): Promise<string | null> {
  try {
    const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
    const QRCode = webRequire('qrcode') as {
      toString: (text: string, opts?: Record<string, unknown>) => Promise<string>;
    };
    // `small: true` renders half-height blocks (~2× denser) so the code
    // fits a normal terminal window and still scans reliably.
    return await QRCode.toString(url, { type: 'terminal', small: true, margin: 1 });
  } catch {
    return null;
  }
}
const log = silent
  ? {
      info: () => {},
      error: (...args: unknown[]) => console.error(...args),
    }
  : { info: console.info, error: (...args: unknown[]) => console.error(...args) };

// Always build first so the served app matches the current source — a stale
// dist (e.g. from a previous `bun run build` before an edit) can never win.
log.info('[lan] Building web app…');
const build = spawnSync('bun', ['run', 'build'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (build.status !== 0) {
  log.error('[lan] Web build failed — not starting the server.');
  process.exit(build.status ?? 1);
}

const lan = pickLanAddress();
const displayHost = (host: string): string =>
  port === 80 ? `http://${host}` : `http://${host}:${port}`;
log.info(`[lan] Starting server on port ${port} (all interfaces)…`);
log.info(`[lan] On-exit auto-backup scope: ${backupScope}`);
log.info('[lan] Security: NODE_ENV=production, CORS locked to this host, LAN devices must be paired');
if (lan) {
  const pairingUrl = `${displayHost(lan)}?token=${accessToken}`;
  log.info(`[lan] On this PC:      ${displayHost('localhost')}`);
  log.info(`[lan] Other devices:   ${pairingUrl}  ← open this on phones/tablets`);
  log.info('[lan] (The ?token= pairs that device once; it gets its own cookie afterwards.)');
  // Scan-to-pair QR right in the terminal (suppressed in --silent mode
  // like every other launcher log). Build the QR before spawning the
  // server so it's on screen while the API boots.
  const qr = await renderPairingQr(pairingUrl);
  if (qr) {
    log.info(`\n[lan] Scan to pair:${'\n'}${qr}`);
  } else {
    log.info('[lan] (QR code unavailable — use the link above or the Share dialog QR.)');
  }
} else {
  log.info('[lan] Could not detect a LAN address — use `ipconfig` / `ip addr` to find it.');
}
if (port === 80 && process.platform !== 'win32') {
  log.info('[lan] Port 80 needs privileges on macOS/Linux — re-run with sudo if binding fails.');
}

if (smol) {
  log.info('[lan] Low-memory mode (--smol): API runs with a smaller JS heap.');
}

let child: ReturnType<typeof spawn>;
let shuttingDown = false;
let capturedStderr = '';

function startChild(): void {
  capturedStderr = '';
  child = spawn('bun', [...(smol ? ['--smol'] : []), 'apps/api/src/index.ts'], {
    // In silent mode the child's stdout is discarded (no request logs) but
    // stderr is captured — a startup failure or unhandled error would
    // otherwise vanish with the rest of the output.
    stdio: silent ? ['ignore', 'ignore', 'pipe'] : 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      PORT: String(port),
      BACKUP_SCOPE: backupScope,
      // Security posture (see SECURITY_REMEDIATIONS R1/R2):
      //  - production → CORS locked to the allowlist + same-host origins
      //    (dev's echo-any-origin matcher must never serve the LAN).
      //  - BIND_ALL=1 → 0.0.0.0 binding is now an explicit opt-in.
      //  - ACCESS_TOKEN → the pairing secret devices exchange for their own
      //    record; loopback (the host PC) stays open.
      NODE_ENV: 'production',
      BIND_ALL: '1',
      ACCESS_TOKEN: accessToken,
    },
  });
  if (silent && child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      capturedStderr += chunk.toString();
    });
  }
  child.on('exit', (code, signal) => {
    // Ctrl+C / SIGTERM is the normal way to stop the server — exit cleanly
    // instead of re-raising the signal (which surfaces as `exited with code 1`).
    if (shuttingDown) return;
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    // Surface captured stderr so a crash isn't silent.
    if (silent && capturedStderr.trim()) {
      process.stderr.write(capturedStderr);
    }
    process.exit(code ?? 1);
  });
}

startChild();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    shuttingDown = true;
    if (!child.killed) child.kill(sig);
    else process.exit(0);
  });
}
