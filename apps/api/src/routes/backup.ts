import { Hono } from 'hono';
import { z } from 'zod';
import { ErrorCodes, ok } from '@panel/shared';
import type { Database } from '../db/client.js';
import { AppError } from '../lib/errors.js';
import { buildSqlDump, restoreSqlDump } from '../lib/backupDump.js';

const importBackupSchema = z.object({
  sql: z.string().min(1).max(200_000_000),
});

const exportQuerySchema = z.object({
  scope: z.enum(['full', 'minimal']).optional().default('full'),
});

const MAX_DUMP_BYTES = 200_000_000;

/**
 * Full-database backup as a pg_dump-compatible .sql dump.
 *
 *   GET  /api/backup/export — raw `application/sql` download (NOT the JSON
 *          envelope: dumps are tens of MB, and JSON-escaping the payload
 *          doubles peak memory on both ends). `?scope=minimal` exports
 *          bookmark data only (no reader/search/prefetch caches);
 *          default is `?scope=full`.
 *   POST /api/backup/import — raw dump (`application/sql` / `text/plain`)
 *          or the JSON envelope `{ sql }` → `{ tables }`.
 *
 * The dump is the same COPY-block format `bun run db:import` reads, so a
 * file exported here can also seed a fresh clone from the CLI. Import is
 * idempotent (ON CONFLICT DO NOTHING) — restoring twice never duplicates.
 */
export function backupRoutes(db: Database): Hono {
  const app = new Hono();

  app.get('/export', async (c) => {
    const parsed = exportQuerySchema.safeParse({ scope: c.req.query('scope') ?? undefined });
    if (!parsed.success) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid export scope. Use "full" or "minimal".');
    }
    const scope = parsed.data.scope;
    const { dump } = await buildSqlDump(db, scope);
    const date = new Date().toISOString().slice(0, 10);
    const filename =
      scope === 'minimal'
        ? `panel-viewer-bookmarks-${date}.sql`
        : `panel-viewer-backup-${date}.sql`;
    c.header('Content-Type', 'application/sql');
    c.header('Content-Disposition', `attachment; filename="${filename}"`);
    return c.body(dump);
  });

  app.post('/import', async (c) => {
    const contentType = c.req.header('content-type') ?? '';
    let dump: string;
    if (contentType.includes('application/json')) {
      const body = await c.req.json().catch(() => null);
      const parsed = importBackupSchema.safeParse(body);
      if (!parsed.success) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid backup payload.', {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      dump = parsed.data.sql;
    } else {
      dump = await c.req.text();
      if (!dump || dump.length > MAX_DUMP_BYTES) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          'Invalid backup file (empty or larger than 200 MB).',
        );
      }
    }
    let tables: Record<string, number>;
    try {
      tables = await restoreSqlDump(db, dump);
    } catch (error) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        error instanceof Error ? error.message : 'Could not restore that backup file.',
      );
    }
    return c.json(ok({ tables }));
  });

  return app;
}
