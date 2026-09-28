import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from './logger.js';

/**
 * Single-instance guard for the embedded database.
 *
 * PGlite allows a single opener per data directory, but on some platforms
 * a second opener fails only later (or corrupts shared state instead of
 * refusing) — e.g. `bun run dev` (:3001) and `bun run lan` (:80) started
 * together both open `data/pglite`, risking torn reads and WASM aborts.
 * This lock refuses the second boot with a clear message instead.
 *
 * The lock lives next to the data directory (`<databaseUrl>.lock`), so
 * different DATABASE_URLs may still run side by side. It stores the
 * owner's PID: a lock pointing at a dead process is stale (kill -9,
 * crash, power cut) and is taken over; a lock pointing at a live
 * process — or at ourselves (hot reload re-runs startup in the same
 * process) — is respected.
 */

interface InstanceLock {
  pid: number;
  startedAt: string;
  port: number;
}

function lockPath(databaseUrl: string): string {
  return `${databaseUrl}.lock`;
}

/** True when a process with this pid exists (cross-platform). */
function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs error checking without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we may not signal it.
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return true;
    return false;
  }
}

async function readLock(path: string): Promise<InstanceLock | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<InstanceLock>;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    return { pid: parsed.pid, startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '', port: typeof parsed.port === 'number' ? parsed.port : 0 };
  } catch {
    return null;
  }
}

/**
 * Claim the instance lock, exiting the process when another live API
 * already holds it. Returns a release function for clean shutdown.
 */
export async function acquireInstanceLock(
  databaseUrl: string,
  port: number,
): Promise<() => Promise<void>> {
  const path = lockPath(databaseUrl);
  const existing = await readLock(path);
  if (existing && existing.pid !== process.pid && isAlive(existing.pid)) {
    logger.error('Another API process is already using this database', {
      pid: existing.pid,
      port: existing.port || undefined,
      databaseDir: databaseUrl,
    });
    logger.error(
      'Stop the other server first (only one of `bun run dev` / `bun run lan` ' +
        'may run at a time — both open the same embedded database).',
    );
    process.exit(1);
  }
  if (existing) {
    logger.info('Taking over stale instance lock', {
      oldPid: existing.pid,
      databaseDir: databaseUrl,
    });
  }
  // The data directory itself is created later by createDb — ensure the
  // lock's parent exists here so a first boot on a fresh path works.
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), port } satisfies InstanceLock),
    'utf8',
  );

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    // Only remove our own lock — never a successor's.
    const current = await readLock(path);
    if (current && current.pid === process.pid) {
      await rm(path, { force: true });
    }
  };
}
