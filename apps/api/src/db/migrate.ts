import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { loadConfig } from '../config.js';
import { logger } from '../lib/logger.js';
import { openDatabase } from './client.js';

/**
 * Migration runner — applies SQL migrations from database/migrations to the
 * local embedded database.
 * Usage: `bun run db:migrate` (optionally with DATABASE_URL set to a file).
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '../../../../database/migrations');

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info('Running database migrations', {
    migrationsFolder,
    databaseFile: config.databaseUrl,
  });

  // Ensure the parent directory exists on fresh clones.
  await mkdir(dirname(config.databaseUrl), { recursive: true });
  const client = openDatabase(config.databaseUrl);
  const db = drizzle({ client });

  try {
    migrate(db, { migrationsFolder });
    logger.info('Migrations applied successfully');
  } finally {
    client.close();
  }
}

main().catch((error) => {
  logger.error('Migration failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
