import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { PGlite } from '@electric-sql/pglite';
import { loadConfig } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Migration runner — applies SQL migrations from database/migrations to the
 * local embedded database.
 * Usage: `bun run db:migrate` (optionally with DATABASE_URL set to a folder).
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '../../../../database/migrations');

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info('Running database migrations', {
    migrationsFolder,
    databaseDir: config.databaseUrl,
  });

  // PGlite mkdirs non-recursively — ensure the full path on fresh clones.
  await mkdir(config.databaseUrl, { recursive: true });
  const client = await PGlite.create(config.databaseUrl);
  const db = drizzle({ client });

  try {
    await migrate(db, { migrationsFolder });
    logger.info('Migrations applied successfully');
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  logger.error('Migration failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
