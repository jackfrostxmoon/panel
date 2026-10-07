import { dirname } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { Database as BunDatabase } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';

/**
 * Open the embedded SQLite file with the app's standard pragmas.
 *
 * Fails fast with a clear message when the path is an existing directory
 * (e.g. a stale `DATABASE_URL=data/pglite` from the PostgreSQL era) instead
 * of surfacing `no such table` from an empty file later.
 */
export function openDatabase(dbFile: string): BunDatabase {
  if (existsSync(dbFile) && statSync(dbFile).isDirectory()) {
    throw new Error(
      `DATABASE_URL points at a directory (${dbFile}) — this app uses a single SQLite file. ` +
        'Set DATABASE_URL to a file path instead, e.g. "data/panel.db". ' +
        'Migrating from the old engine? Point DATABASE_URL at the new file, run `bun run db:migrate`, ' +
        'then `bun run db:import <data/.backup/*.sql.gz>`.',
    );
  }
  const client = new BunDatabase(dbFile, { create: true });
  client.run('PRAGMA journal_mode = WAL;');
  client.run('PRAGMA busy_timeout = 5000;');
  client.run('PRAGMA foreign_keys = ON;');
  return client;
}

/**
 * Database client factory. A factory (rather than a module-level singleton)
 * keeps tests free to point at an isolated database.
 *
 * The database is SQLite via Bun's built-in `bun:sqlite` — no server, no
 * install: data lives in a single local file (`dbFile`), created on first
 * start. WAL mode keeps readers concurrent with the prefetch writer;
 * `busy_timeout` makes brief write contention wait instead of failing;
 * foreign keys are enforced (cascades in the schema rely on it).
 */
export async function createDb(dbFile: string) {
  // Ensure the parent directory exists — a fresh clone has no `data/` at all.
  await mkdir(dirname(dbFile), { recursive: true });
  return drizzle({ client: openDatabase(dbFile) });
}

export type Database = Awaited<ReturnType<typeof createDb>>;
