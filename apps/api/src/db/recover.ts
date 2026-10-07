import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { loadConfig } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Recovery script for a wedged embedded database.
 *
 * Symptom: `bun run dev` fails with
 *   "Local database could not be opened ..." pointing at `data/panel.db`
 * (SQLite file with a torn WAL after an unclean shutdown — killed
 * `bun --hot`, power loss, ...).
 *
 * Usage:
 *   bun run db:recover           # reset only if the database fails to open
 *   bun run db:recover --force   # reset even if the database opens fine
 *   bun run db:recover [dump]    # reset, then import this COPY-block export
 *                                # (without it: DUMP_PATH when the file exists,
 *                                # otherwise the newest non-empty backup in
 *                                # the backup dir — empty test-boot dumps skipped)
 *
 * What it does:
 *   1. Refuses while the API is reachable (stop `bun run dev` first —
 *      rebuilding underneath a live process would corrupt it again).
 *   2. Probes the database (open + `select 1`). Healthy and no
 *      `--force` → nothing to do, exit 0.
 *   3. Renames the wedged file to `<name>-corrupt-YYYYMMDD-HHMMSS`
 *      (a backup — your data is never deleted outright).
 *   4. Recreates the file, applies migrations (`database/migrations`).
 *   5. Restores data: CLI dump, else DUMP_PATH, else the newest backup in
 *      the backup dir that actually holds rows (fresh library if none).
 *   6. Re-opens the database and runs `select 1` to prove it works.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(here, '..', '..');
const migrationsFolder = resolve(here, '../../../../database/migrations');

function timestamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

async function isApiAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    // Any HTTP response (even an error envelope) means a live opener.
    return res.status > 0;
  } catch {
    return false;
  }
}

async function probeOpen(dbFile: string): Promise<boolean> {
  let client: Database | undefined;
  try {
    // Read-only without create: a missing file fails instead of booting empty.
    client = new Database(dbFile, { readonly: true });
    client.query('select 1').get();
    return true;
  } catch {
    return false;
  } finally {
    try {
      client?.close();
    } catch {
      // Already closed.
    }
  }
}

/** Timestamped backups this tooling writes: `backup[-minimal]-YYYY-MM-DD-HH-MM.sql.gz`. */
const BACKUP_FILE_RE = /^backup(?:-minimal)?-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.sql\.gz$/;

/**
 * Newest backup in `backupDir` that actually holds rows, or null.
 *
 * Newest-first by filename (timestamps sort chronologically). Files whose
 * COPY blocks hold zero data rows — e.g. dumps written while booting an
 * empty database during testing — are skipped, so recovery never
 * "restores" an empty library over real bookmark data.
 */
async function latestBackupWithData(backupDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(backupDir);
  } catch {
    return null;
  }
  const candidates = entries.filter((e) => BACKUP_FILE_RE.test(e)).sort().reverse();
  for (const name of candidates) {
    const full = join(backupDir, name);
    try {
      const raw = await Bun.file(full).arrayBuffer();
      const bytes = new Uint8Array(raw);
      const text =
        bytes[0] === 0x1f && bytes[1] === 0x8b
          ? gunzipSync(Buffer.from(bytes)).toString('utf8')
          : Buffer.from(bytes).toString('utf8');
      let inCopy = false;
      let rows = 0;
      for (const line of text.split('\n')) {
        const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (inCopy) {
          if (clean === '\\.') inCopy = false;
          else rows++;
        } else if (/^COPY (?:public\.)?\w+ \(.+\) FROM stdin;$/.test(clean)) {
          inCopy = true;
        }
        if (rows > 0) break;
      }
      if (rows > 0) return full;
      logger.info('Skipping empty backup', { dumpPath: full });
    } catch (error) {
      logger.info('Skipping unreadable backup', {
        dumpPath: full,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const cliDumpPath = args.find((a) => !a.startsWith('--'));

  const config = loadConfig();
  const dbFile = config.databaseUrl;

  if (await isApiAlive(config.port)) {
    logger.error('API is still running — stop `bun run dev` first', {
      port: config.port,
    });
    logger.error(
      'Rebuilding underneath a live process would corrupt the database again.',
    );
    process.exit(1);
  }

  if (existsSync(dbFile)) {
    logger.info('Probing local database', { databaseFile: dbFile });
    if (await probeOpen(dbFile)) {
      if (!force) {
        logger.info('Database opens fine — nothing to recover (pass --force to reset anyway)');
        return;
      }
      logger.info('Database opens fine, but --force was passed — resetting anyway');
    } else {
      logger.error('Database failed to open — will back up and rebuild', {
        databaseFile: dbFile,
      });
    }
  } else {
    logger.info('No database file yet — will create it', { databaseFile: dbFile });
  }

  // Backup: rename (fast, atomic on one volume) so nothing is ever deleted
  // outright. Suffix with -N on the (unlikely) timestamp collision. The
  // rename is retried — on Windows a transient lock (antivirus/indexer
  // scanning the just-written WAL) can EPERM the first attempt.
  const base = basename(dbFile);
  let asidePath = join(dirname(dbFile), `${base}-corrupt-${timestamp()}`);
  if (existsSync(dbFile)) {
    let candidate = asidePath;
    for (let n = 2; existsSync(candidate); n++) candidate = `${asidePath}-${n}`;
    asidePath = candidate;
    let moved = false;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 5 && !moved; attempt++) {
      try {
        await rename(dbFile, asidePath);
        moved = true;
      } catch (error) {
        lastError = error;
        if (attempt < 5) await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    if (!moved) {
      // Node's rename can EPERM while a plain move succeeds (transient
      // antivirus/indexer lock on the just-written WAL). Fall back to
      // copy + delete before giving up.
      logger.info('Rename blocked — falling back to copy + delete', {
        from: dbFile,
        to: asidePath,
      });
      try {
        await cp(dbFile, asidePath, { recursive: true });
        await rm(dbFile, { force: true });
        if (existsSync(dbFile)) throw new Error('file still present after delete');
        moved = true;
      } catch (copyError) {
        lastError = copyError;
      }
    }
    if (!moved) {
      logger.error('Could not move the wedged database aside', {
        from: dbFile,
        to: asidePath,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });
      logger.error(
        'Something still holds the file open: stop `bun run dev`, kill any ' +
          'stale bun.exe, then re-run `bun run db:recover`.',
      );
      process.exit(1);
    }
    // Leave no stale WAL sidecars behind for the fresh file.
    await rm(`${dbFile}-wal`, { force: true });
    await rm(`${dbFile}-shm`, { force: true });
    logger.info('Backed up wedged database', { from: dbFile, to: asidePath });
  }

  // Rebuild: fresh file + migrations (same as `bun run db:migrate`).
  await mkdir(dirname(dbFile), { recursive: true });
  const client = new Database(dbFile, { create: true });
  client.run('PRAGMA journal_mode = WAL;');
  client.run('PRAGMA busy_timeout = 5000;');
  client.run('PRAGMA foreign_keys = ON;');
  try {
    migrate(drizzle({ client }), { migrationsFolder });
    logger.info('Migrations applied successfully');
  } finally {
    client.close();
  }

  // Restore: CLI dump wins, then DUMP_PATH, then the newest backup that
  // actually holds rows (never an empty dump — that would wipe the library
  // by "restoring" nothing).
  let dumpPath = cliDumpPath ?? null;
  if (!dumpPath && existsSync(config.dumpPath)) dumpPath = config.dumpPath;
  if (!dumpPath) {
    logger.info('No dump configured — looking for the latest backup', {
      backupDir: config.backupDir,
    });
    const latest = await latestBackupWithData(config.backupDir);
    if (latest) {
      logger.info('Restoring latest backup', { dumpPath: latest });
      dumpPath = latest;
    }
  }
  if (dumpPath) {
    logger.info('Importing dump', { dumpPath });
    const result = spawnSync('bun', ['run', 'src/db/import.ts', dumpPath], {
      cwd: apiDir,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      logger.error('Import failed — database is migrated but empty', {
        dumpPath,
        backupFile: existsSync(asidePath) ? asidePath : undefined,
      });
      process.exit(1);
    }
  } else {
    logger.info('No dump or backup found — starting with an empty library');
  }

  // Verify: the exact operation that was failing must now succeed.
  if (!(await probeOpen(dbFile))) {
    logger.error('Recovery failed — rebuilt database still does not open', {
      databaseFile: dbFile,
      backupFile: existsSync(asidePath) ? asidePath : undefined,
    });
    process.exit(1);
  }
  logger.info('Recovery complete — database opens. Run `bun run dev` to start.', {
    databaseFile: dbFile,
    backupFile: existsSync(asidePath) ? asidePath : undefined,
  });
}

main().catch((error) => {
  logger.error('Recovery failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
