import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { BackupExportScope } from '@panel/shared';
import { logger } from '../lib/logger.js';
import { buildSqlDump } from '../lib/backupDump.js';
import type { Database } from './client.js';

/**
 * Auto-backup: writes a SQL dump (COPY-block format) to a
 * timestamped, gzip-compressed `.sql.gz` in `backupDir`. Written on every
 * clean shutdown and, while the server runs, every BACKUP_INTERVAL_MS
 * (see the periodic timer in `index.ts`).
 *
 * Why SQL and not the raw database file? The app already produces and
 * round-trips this exact format — `buildSqlDump` here, `restoreSqlDump` in
 * the Bookmarks page Import action, and the `bun run db:import` CLI all
 * share the same COPY-block parser. A backup in that format is therefore
 * directly restorable through the app's own tooling with no extra binary.
 *
 * The SQL is gzipped because a full dump is tens of MB of text — without
 * compression it would balloon the backup folder on every shutdown.
 *
 * `scope` mirrors the Bookmarks page export dialog: `full` dumps every
 * table including caches, `minimal` dumps bookmark data only (and gets a
 * `-minimal` filename infix so the two flavours are distinguishable).
 *
 * Every shutdown writes a new timestamped file and nothing is ever deleted
 * automatically — manage disk usage manually when needed.
 */

function localDateStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function hourStamp(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}-${mm}`;
}

export async function writeBackup(
  db: Database,
  backupDir: string,
  scope: BackupExportScope = 'full',
): Promise<string | null> {
  if (!backupDir) return null;
  await mkdir(backupDir, { recursive: true });

  const { dump, tables } = await buildSqlDump(db, scope);
  const buf = gzipSync(Buffer.from(dump, 'utf8'));

  const now = new Date();
  const infix = scope === 'minimal' ? '-minimal' : '';
  const name = `backup${infix}-${localDateStamp(now)}-${hourStamp(now)}.sql.gz`;
  const dest = join(backupDir, name);
  await writeFile(dest, buf);

  logger.info('Database backup written', { path: dest, bytes: buf.length, scope, tables });
  return dest;
}