import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { PGlite } from '@electric-sql/pglite';
import { loadConfig } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Recovery script for a wedged embedded database.
 *
 * Symptom: `bun run dev` fails with
 *   "Local database could not be opened ... Aborted(). Build with -sASSERTIONS ..."
 * pointing at `data/pglite`. PGlite (embedded PostgreSQL) allows a single
 * opener and aborts on a stale lock or torn WAL after an unclean shutdown
 * (killed `bun --hot`, power loss, ...).
 *
 * Usage:
 *   bun run db:recover           # reset only if the database fails to open
 *   bun run db:recover --force   # reset even if the database opens fine
 *   bun run db:recover [dump]    # reset, then import this pg_dump export
 *                                # (defaults to DUMP_PATH when the file exists)
 *
 * What it does:
 *   1. Refuses while the API is reachable (stop `bun run dev` first — the
 *      embedded database allows a single opener).
 *   2. Probes the database (`PGlite.create` + `select 1`). Healthy and no
 *      `--force` → nothing to do, exit 0.
 *   3. Renames the wedged directory to `data/pglite-corrupt-YYYYMMDD-HHMMSS`
 *      (a backup — your data is never deleted outright).
 *   4. Recreates the directory, applies migrations (`database/migrations`).
 *   5. Imports the dump when one exists (skipped otherwise — fresh library).
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

async function probeOpen(dataDir: string): Promise<boolean> {
  let client: PGlite | undefined;
  try {
    client = await PGlite.create(dataDir);
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    // create() either throws (nothing to close) or hands back an open
    // client — never leave a second opener behind.
    await client?.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const cliDumpPath = args.find((a) => !a.startsWith('--'));

  const config = loadConfig();
  const dataDir = config.databaseUrl;

  if (await isApiAlive(config.port)) {
    logger.error('API is still running — stop `bun run dev` first', {
      port: config.port,
    });
    logger.error(
      'The embedded database allows a single opener; resetting underneath ' +
        'a live process would corrupt it again.',
    );
    process.exit(1);
  }

  if (existsSync(dataDir)) {
    logger.info('Probing local database', { databaseDir: dataDir });
    if (await probeOpen(dataDir)) {
      if (!force) {
        logger.info('Database opens fine — nothing to recover (pass --force to reset anyway)');
        return;
      }
      logger.info('Database opens fine, but --force was passed — resetting anyway');
    } else {
      logger.error('Database failed to open — will back up and rebuild', {
        databaseDir: dataDir,
      });
    }
  } else {
    logger.info('No database directory yet — will create it', { databaseDir: dataDir });
  }

  // Backup: rename (fast, atomic on one volume) so nothing is ever deleted
  // outright. Suffix with -N on the (unlikely) timestamp collision. The
  // rename is retried — on Windows a transient lock (antivirus/indexer
  // scanning the just-written postmaster.pid) can EPERM the first attempt.
  let backupDir = join(dirname(dataDir), `pglite-corrupt-${timestamp()}`);
  if (existsSync(dataDir)) {
    let candidate = backupDir;
    for (let n = 2; existsSync(candidate); n++) candidate = `${backupDir}-${n}`;
    backupDir = candidate;
    let renamed = false;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 5 && !renamed; attempt++) {
      try {
        await rename(dataDir, backupDir);
        renamed = true;
      } catch (error) {
        lastError = error;
        if (attempt < 5) await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    if (!renamed) {
      logger.error('Could not move the wedged database aside', {
        from: dataDir,
        to: backupDir,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });
      logger.error(
        'Something still holds the folder open: stop `bun run dev`, kill any ' +
          'stale bun.exe, then re-run `bun run db:recover`.',
      );
      process.exit(1);
    }
    logger.info('Backed up wedged database', { from: dataDir, to: backupDir });
  }

  // Rebuild: fresh directory + migrations (same as `bun run db:migrate`).
  await mkdir(dataDir, { recursive: true });
  const client = await PGlite.create(dataDir);
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
    logger.info('Migrations applied successfully');
  } finally {
    await client.close();
  }

  // Import: only when a dump file actually exists (fresh library otherwise).
  const dumpPath = cliDumpPath ?? config.dumpPath;
  if (existsSync(dumpPath)) {
    logger.info('Importing dump', { dumpPath });
    const importArgs = ['run', 'src/db/import.ts'];
    if (cliDumpPath) importArgs.push(cliDumpPath);
    const result = spawnSync('bun', importArgs, { cwd: apiDir, stdio: 'inherit' });
    if (result.status !== 0) {
      logger.error('Import failed — database is migrated but empty', {
        dumpPath,
        backupDir: existsSync(backupDir) ? backupDir : undefined,
      });
      process.exit(1);
    }
  } else {
    logger.info('No dump file found — skipping import (empty library)', { dumpPath });
  }

  // Verify: the exact operation that was failing must now succeed.
  if (!(await probeOpen(dataDir))) {
    logger.error('Recovery failed — rebuilt database still does not open', {
      databaseDir: dataDir,
      backupDir: existsSync(backupDir) ? backupDir : undefined,
    });
    process.exit(1);
  }
  logger.info('Recovery complete — database opens. Run `bun run dev` to start.', {
    databaseDir: dataDir,
    backupDir: existsSync(backupDir) ? backupDir : undefined,
  });
}

main().catch((error) => {
  logger.error('Recovery failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
