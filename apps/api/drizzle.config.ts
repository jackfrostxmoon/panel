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
 * The database is SQLite (embedded via `bun:sqlite`), so the dialect is
 * `sqlite` and the credentials are a local file path — resolved against the
 * repo root, matching config.ts. Generation is offline (schema → SQL only).
 */

const here = dirname(fileURLToPath(import.meta.url));
const dataFileInput = process.env.DATABASE_URL ?? 'data/panel.db';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: '../../database/migrations',
  dbCredentials: {
    url: isAbsolute(dataFileInput) ? dataFileInput : resolve(here, '..', '..', dataFileInput),
  },
  verbose: true,
});
