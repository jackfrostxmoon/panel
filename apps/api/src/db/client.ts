import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

/**
 * Database client factory. A factory (rather than a module-level singleton)
 * keeps tests free to point at an isolated database.
 *
 * The database is PGlite — real PostgreSQL compiled to WebAssembly running
 * in-process. No server, no Docker, no installation: data lives in a plain
 * local directory (`dataDir`), created on first start.
 */
export async function createDb(dataDir: string) {
  // PGlite's NodeFS driver mkdirs the datadir NON-recursively — a fresh
  // clone has no `data/` at all, so create the full path first.
  await mkdir(dataDir, { recursive: true });
  const client = await PGlite.create(dataDir);
  return drizzle({ client });
}

export type Database = Awaited<ReturnType<typeof createDb>>;
