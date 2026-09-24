import type { BackupExportScope } from '@panel/shared';
import { loadConfig } from '../config.js';
import { logger } from '../lib/logger.js';
import { writeBackup } from './backup.js';
import { createDb } from './client.js';

/**
 * Standalone on-demand backup — dumps the embedded database to a
 * timestamped, gzip-compressed `.sql.gz` in the backup directory without
 * starting the API server.
 *
 * Usage:
 *   bun run backup [full|minimal]
 *   bun run backup --backup-scope=minimal
 *
 * Scope precedence: CLI argument/flag > BACKUP_SCOPE env var > default
 * `full` (mirrors BACKUP_SCOPE in .env.example). `backup.bat` passes the
 * scope explicitly (defaulting to `minimal`, like `lan.bat`).
 */

function pickScope(args: string[]): BackupExportScope {
  const flagPrefix = '--backup-scope=';
  const flag = args.find((a) => a.startsWith(flagPrefix));
  const raw =
    (flag ? flag.slice(flagPrefix.length) : args.find((a) => !a.startsWith('--'))) ??
    process.env.BACKUP_SCOPE ??
    'full';
  const scope = raw.toLowerCase();
  if (scope !== 'full' && scope !== 'minimal') {
    logger.error('Invalid backup scope. Use "full" or "minimal".', { scope: raw });
    process.exit(1);
  }
  return scope;
}

async function main(): Promise<void> {
  const scope = pickScope(process.argv.slice(2));
  const config = loadConfig();

  let db: Awaited<ReturnType<typeof createDb>>;
  try {
    db = await createDb(config.databaseUrl);
  } catch (error) {
    logger.error('Local database could not be opened', {
      error: error instanceof Error ? error.message : String(error),
      databaseDir: config.databaseUrl,
    });
    logger.error(
      'If another API process is running, stop it first (the embedded database allows a single opener).',
    );
    process.exit(1);
  }

  try {
    const dest = await writeBackup(db, config.backupDir, scope);
    if (!dest) {
      logger.error('Backups are disabled (BACKUP_DIR is empty) — nothing was written.');
      process.exit(1);
    }
    logger.info('Backup complete', { path: dest, scope });
  } finally {
    await db.$client.close();
  }
}

main().catch((error) => {
  logger.error('Backup failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
