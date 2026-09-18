import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration.
 *
 *  - `bun run db:generate`  → emit SQL migrations into ../../database/migrations
 *  - `bun run db:migrate`   → apply them (src/db/migrate.ts)
 *  - `bun run db:studio`    → open Drizzle Studio for inspection
 *
 * The database is PGlite (embedded PostgreSQL), so the dialect stays
 * `postgresql` with the `pglite` driver and the credentials are a local
 * folder path — resolved against the repo root, matching config.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dataDirInput = process.env.DATABASE_URL ?? 'data/pglite';

export default defineConfig({
  dialect: 'postgresql',
  driver: 'pglite',
  schema: './src/db/schema.ts',
  out: '../../database/migrations',
  dbCredentials: {
    url: isAbsolute(dataDirInput) ? dataDirInput : resolve(here, '..', '..', dataDirInput),
  },
  verbose: true,
});
