import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Database as BunDatabase } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';

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
  const client = new BunDatabase(dbFile, { create: true });
  client.run('PRAGMA journal_mode = WAL;');
  client.run('PRAGMA busy_timeout = 5000;');
  client.run('PRAGMA foreign_keys = ON;');
  return drizzle({ client });
}

export type Database = Awaited<ReturnType<typeof createDb>>;
