import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Read a dump file, transparently decompressing `.sql.gz` backups (the
 * format the on-exit auto-backup writes). Plain `.sql` files are passed
 * through unchanged.
 *
 * Read as binary (not UTF-8 text) — a gzip stream contains bytes outside
 * the ASCII range, and decoding it as text first would corrupt the magic
 * bytes and break the decompression check below.
 */
function readDumpFile(file: Awaited<ReturnType<typeof Bun.file>>): Promise<string> {
  return file.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      return gunzipSync(Buffer.from(bytes)).toString('utf8');
    }
    return Buffer.from(bytes).toString('utf8');
  });
}

/**
 * One-shot data import from a `pg_dump` export (COPY ... FROM stdin blocks).
 *
 * Usage:
 *   bun run db:import [path/to/export.sql] [--force]
 *
 *  - Applies migrations first (idempotent), then loads every COPY block in
 *    foreign-key-safe table order, in 500-row INSERT batches.
 *  - Aborts if the database already holds panel rows unless `--force` is
 *    passed (which wipes the local data directory and starts over).
 *
 * The dump path resolves from the first CLI argument, then the DUMP_PATH
 * env var, then `panel_viewer_export.sql` at the repo root (see config).
 * Both plain `.sql` and gzip `.sql.gz` (the on-exit backup format) are
 * accepted — the gzip magic bytes are detected automatically.
 *
 * The dump format parsed here is PostgreSQL COPY TEXT: tab-separated fields,
 * `\N` = NULL, backslash escapes (`\\`, `\t`, `\n`, `\r`, `\b`, `\f`).
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '../../../../database/migrations');

const BATCH_SIZE = 500;

const INT_COLUMNS = new Set([
  'page',
  'total_pages',
  'cached_pages',
  'failed_pages',
  'rating',
  'interval_ms',
]);
const FLOAT_COLUMNS = new Set(['chapter_number']);
const BOOL_COLUMNS = new Set(['has_more', 'is_default', 'only_missing']);

/** Tables in an order that satisfies every foreign key. */
const TABLE_ORDER = [
  'panel',
  'chapters',
  'bookmarks',
  'bookmark_folders',
  'bookmark_folder_items',
  'chapter_bookmarks',
  'reading_progress',
  'reading_list',
  'panel_ratings',
  'tags',
  'panel_tags',
  'chapter_pages',
  'list_cache',
  'recently_viewed',
  'prefetch_jobs',
];

function unescapeCopyField(field: string): string | null {
  if (field === '\\N') return null;
  let out = '';
  for (let i = 0; i < field.length; i++) {
    const ch = field[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = field[++i];
    switch (next) {
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'v': out += '\v'; break;
      case undefined: out += '\\'; break;
      default: out += next; break; // '\\' → '\', '\N' (literal) → 'N', etc.
    }
  }
  return out;
}

function convertValue(column: string, value: string | null): string | number | boolean | null {
  if (value === null) return null;
  if (INT_COLUMNS.has(column)) return Number.parseInt(value, 10);
  if (FLOAT_COLUMNS.has(column)) return Number.parseFloat(value);
  if (BOOL_COLUMNS.has(column)) return value === 't';
  return value;
}

interface CopyBlock {
  table: string;
  columns: string[];
  rows: string[][];
}

function parseDump(text: string): Map<string, CopyBlock> {
  const blocks = new Map<string, CopyBlock>();
  // pg_dump writes CRLF; strip a trailing \r so the COPY regex, the `\.`
  // terminator, and tab-split field values all see clean lines.
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  let current: CopyBlock | null = null;
  // COPY public.<table> (col, ...) FROM stdin;
  const copyRe = /^COPY (?:public\.)?(\w+) \((.+)\) FROM stdin;$/;
  for (const line of lines) {
    if (current) {
      if (line === '\\.') {
        current = null;
        continue;
      }
      current.rows.push(line.split('\t'));
      continue;
    }
    const match = copyRe.exec(line);
    if (match) {
      const table = match[1];
      const cols = match[2];
      if (table === undefined || cols === undefined) continue;
      // The drizzle bookkeeping schema travels with the dump but is owned
      // by the migrator — never import it.
      if (table === '__drizzle_migrations') continue;
      current = { table, columns: cols.split(',').map((c) => c.trim()), rows: [] };
      const existing = blocks.get(table);
      if (existing) {
        // Same table appearing twice would be ambiguous — fail, don't merge.
        throw new Error(`Duplicate COPY block for table "${table}" in dump`);
      }
      blocks.set(table, current);
    }
  }
  if (current) throw new Error(`Unterminated COPY block for table "${current.table}"`);
  return blocks;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const cliPath = args.find((a) => !a.startsWith('--'));

  const config = loadConfig();

  // CLI argument wins, then DUMP_PATH env var, then the repo-root default.
  const dumpPath = cliPath ?? config.dumpPath;

  if (force) {
    logger.info('Force flag set — wiping local database directory', {
      databaseDir: config.databaseUrl,
    });
    await rm(config.databaseUrl, { recursive: true, force: true });
  }

  const dumpFile = Bun.file(dumpPath);
  if (!(await dumpFile.exists())) {
    logger.error('Dump file not found', { dumpPath });
    process.exit(1);
  }

  logger.info('Parsing dump', { dumpPath });
  const dump = await readDumpFile(dumpFile);
  const blocks = parseDump(dump);

  // PGlite mkdirs non-recursively — ensure the full path on fresh clones.
  await mkdir(config.databaseUrl, { recursive: true });
  const client = await PGlite.create(config.databaseUrl);
  const db = drizzle({ client });
  try {
    await migrate(db, { migrationsFolder });

    const countResult = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM panel`,
    );
    const count = countResult.rows[0]?.count ?? '0';
    if (Number(count) > 0 && !force) {
      logger.error(
        'Database already contains panel rows — refusing to import on top. ' +
          'Re-run with --force to wipe and re-import.',
      );
      process.exit(1);
    }

    const summary: Array<{ table: string; rows: number }> = [];
    for (const table of TABLE_ORDER) {
      const block = blocks.get(table);
      if (!block || block.rows.length === 0) {
        summary.push({ table, rows: 0 });
        continue;
      }
      if (block.rows.some((r) => r.length !== block.columns.length)) {
        throw new Error(`Column count mismatch in COPY block for "${table}"`);
      }
      const colList = block.columns.map((c) => `"${c}"`).join(', ');
      for (let i = 0; i < block.rows.length; i += BATCH_SIZE) {
        const batch = block.rows.slice(i, i + BATCH_SIZE);
        const params: Array<string | number | boolean | null> = [];
        const tuples = batch.map((row) => {
          const placeholders = row.map((field, colIdx) => {
            params.push(convertValue(block.columns[colIdx]!, unescapeCopyField(field)));
            return `$${params.length}`;
          });
          return `(${placeholders.join(', ')})`;
        });
        await client.query(`INSERT INTO "${table}" (${colList}) VALUES ${tuples.join(', ')}`, params);
      }
      summary.push({ table, rows: block.rows.length });
      logger.info('Imported table', { table, rows: block.rows.length });
    }

    const unknown = [...blocks.keys()].filter((t) => !TABLE_ORDER.includes(t));
    if (unknown.length > 0) {
      throw new Error(`Dump contains unexpected tables (schema drift?): ${unknown.join(', ')}`);
    }

    logger.info('Import complete — all tables loaded', {
      tables: summary.length,
      totalRows: summary.reduce((n, s) => n + s.rows, 0),
    });
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  logger.error('Import failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
