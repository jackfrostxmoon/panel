import { sql } from 'drizzle-orm';
import type { BackupExportScope } from '@panel/shared';
import type { Database } from '../db/client.js';

/**
 * Full-database SQL dump in pg_dump COPY format, shared by the
 * GET /api/backup/export route (and compatible with the `bun run db:import`
 * CLI, which parses the same COPY blocks).
 *
 * Export reads every user-data table and emits one COPY block per non-empty
 * table; import parses those blocks back and INSERTs them with
 * ON CONFLICT DO NOTHING, so restoring the same file twice never duplicates
 * anything.
 */

/** Tables in an order that satisfies every foreign key. */
export const BACKUP_TABLE_ORDER = [
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

const BATCH_SIZE = 200;
const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

/** Pure-cache tables skipped by a minimal (bookmarks-only) export. */
const MINIMAL_EXCLUDED_TABLES = new Set(['chapter_pages', 'list_cache', 'prefetch_jobs']);

/** User-data tables holding a `panel_id` reference (for minimal filtering). */
const PANEL_REF_TABLES = [
  'bookmarks',
  'chapter_bookmarks',
  'reading_progress',
  'recently_viewed',
  'reading_list',
  'panel_ratings',
  'panel_tags',
];

/** User-data tables holding a `chapter_id` reference (for minimal filtering). */
const CHAPTER_REF_TABLES = ['chapter_bookmarks', 'reading_progress'];

/**
 * Collect every id in `column` across `tables`. Tables that don't exist
 * yet (older databases) are treated as empty rather than failing the export.
 */
async function collectReferencedIds(
  db: Database,
  tables: string[],
  column: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const table of tables) {
    if (!IDENTIFIER_RE.test(table) || !IDENTIFIER_RE.test(column)) continue;
    try {
      const result = await db.execute(sql.raw(`SELECT "${column}" AS "id" FROM "${table}"`));
      for (const row of result.rows as Record<string, unknown>[]) {
        if (typeof row['id'] === 'string') ids.add(row['id']);
      }
    } catch {
      // Missing table on an older database — treat as zero rows.
    }
  }
  return ids;
}

/** Escape a text value for PostgreSQL COPY TEXT format. */
function escapeCopyField(value: string): string {
  let out = String();
  for (const ch of value) {
    switch (ch) {
      case '\b': out += '\\b'; break;
      case '\f': out += '\\f'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      case '\v': out += '\\v'; break;
      case '\\': out += '\\\\'; break;
      default: out += ch; break;
    }
  }
  return out;
}

/** Render one cell of a COPY data line. */
function formatCopyValue(value: unknown): string {
  if (value === null || value === undefined) return '\\N';
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '\\N';
  if (value instanceof Date) return escapeCopyField(value.toISOString());
  if (typeof value === 'object') return escapeCopyField(JSON.stringify(value));
  return escapeCopyField(String(value));
}

/**
 * Dump every table as pg_dump-style COPY blocks. Empty tables are skipped
 * (the importer treats a missing block as zero rows).
 *
 * `minimal` exports bookmark data only: the cache tables (`chapter_pages`,
 * `list_cache`, `prefetch_jobs`) are skipped and `panel` / `chapters` /
 * `panel_tags` rows are limited to IDs referenced by user data, so the file
 * stays small while restoring every bookmark, folder, rating, tag, chapter
 * mark and reading position.
 */
export async function buildSqlDump(
  db: Database,
  scope: BackupExportScope = 'full',
): Promise<{ dump: string; tables: Record<string, number> }> {
  const exportedAt = new Date().toISOString();
  const chunks: string[] = [
    '-- Panel Viewer database dump',
    `-- Exported at ${exportedAt}`,
    '-- Format: PostgreSQL COPY blocks. Restore via the Bookmarks page Import',
    '-- action (POST /api/backup/import) or `bun run db:import --force <file>`.',
  ];
  if (scope === 'minimal') {
    chunks.push('-- Scope: minimal (bookmarks only — cache tables excluded).');
  }
  const tables: Record<string, number> = {};
  const keepPanelIds =
    scope === 'minimal' ? await collectReferencedIds(db, PANEL_REF_TABLES, 'panel_id') : null;
  const keepChapterIds =
    scope === 'minimal' ? await collectReferencedIds(db, CHAPTER_REF_TABLES, 'chapter_id') : null;
  for (const table of BACKUP_TABLE_ORDER) {
    const columnsResult = await db.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} ORDER BY ordinal_position`,
    );
    const columns = columnsResult.rows.map((r) => r.column_name);
    if (columns.length === 0) {
      tables[table] = 0;
      continue;
    }
    if (scope === 'minimal' && MINIMAL_EXCLUDED_TABLES.has(table)) {
      tables[table] = 0;
      continue;
    }
    const data = await db.execute(sql.raw(`SELECT * FROM "${table}"`));
    let rows = data.rows as Record<string, unknown>[];
    if (scope === 'minimal' && table === 'panel' && keepPanelIds) {
      rows = rows.filter((row) => typeof row['id'] === 'string' && keepPanelIds.has(row['id']));
    } else if (scope === 'minimal' && table === 'chapters' && keepChapterIds) {
      rows = rows.filter(
        (row) => typeof row['id'] === 'string' && keepChapterIds.has(row['id']),
      );
    } else if (scope === 'minimal' && table === 'panel_tags' && keepPanelIds) {
      rows = rows.filter(
        (row) => typeof row['panel_id'] === 'string' && keepPanelIds.has(row['panel_id']),
      );
    }
    tables[table] = rows.length;
    if (rows.length === 0) continue;
    chunks.push(`COPY public.${table} (${columns.join(', ')}) FROM stdin;`);
    for (const row of rows) {
      chunks.push(columns.map((c) => formatCopyValue(row[c])).join('\t'));
    }
    chunks.push('\\.');
  }
  return { dump: `${chunks.join('\n')}\n`, tables };
}

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
      default: out += next; break;
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
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  let current: CopyBlock | null = null;
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
      if (table === '__drizzle_migrations') continue;
      if (blocks.has(table)) {
        throw new Error(`Duplicate COPY block for table "${table}" in dump`);
      }
      current = { table, columns: cols.split(',').map((c) => c.trim()), rows: [] };
      blocks.set(table, current);
    }
  }
  if (current) throw new Error(`Unterminated COPY block for table "${current.table}"`);
  return blocks;
}

/** Render one INSERT literal (values arrive pre-validated from parseDump). */
function toLiteral(column: string, value: string | number | boolean | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid numeric value for column "${column}"`);
    return String(value);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Restore a dump produced by buildSqlDump. Inserts run in FK-safe table
 * order with ON CONFLICT DO NOTHING, so re-importing is idempotent.
 * Returns per-table row counts processed.
 */
export async function restoreSqlDump(
  db: Database,
  text: string,
): Promise<Record<string, number>> {
  const blocks = parseDump(text);
  if (blocks.size === 0) {
    throw new Error('No bookmark data found in that file — is it a panel-viewer .sql export?');
  }
  const unknown = [...blocks.keys()].filter((t) => !BACKUP_TABLE_ORDER.includes(t));
  if (unknown.length > 0) {
    throw new Error(`Dump contains unexpected tables: ${unknown.join(', ')}`);
  }
  const counts: Record<string, number> = {};
  for (const table of BACKUP_TABLE_ORDER) {
    const block = blocks.get(table);
    if (!block || block.rows.length === 0) {
      counts[table] = 0;
      continue;
    }
    if (!IDENTIFIER_RE.test(table) || block.columns.some((c) => !IDENTIFIER_RE.test(c))) {
      throw new Error(`Invalid identifiers in COPY block for "${table}"`);
    }
    if (block.rows.some((r) => r.length !== block.columns.length)) {
      throw new Error(`Column count mismatch in COPY block for "${table}"`);
    }
    const colList = block.columns.map((c) => `"${c}"`).join(', ');
    for (let i = 0; i < block.rows.length; i += BATCH_SIZE) {
      const batch = block.rows.slice(i, i + BATCH_SIZE);
      const tuples = batch.map((row) => {
        const literals = row.map((field, colIdx) => {
          const column = block.columns[colIdx]!;
          return toLiteral(column, convertValue(column, unescapeCopyField(field)));
        });
        return `(${literals.join(', ')})`;
      });
      await db.execute(
        sql.raw(`INSERT INTO "${table}" (${colList}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`),
      );
    }
    counts[table] = block.rows.length;
  }
  return counts;
}
