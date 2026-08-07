import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { log } from '@main/lib/logger';
import journal from '@root/drizzle/meta/_journal.json';

// Vite bundles all migration SQL files at build time — no runtime path resolution needed.
// Each value is the raw SQL string content of the file.
const sqlFiles = import.meta.glob('@root/drizzle/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

type JournalEntry = { idx: number; when: number; tag: string; breakpoints: boolean };

/**
 * Bundled migration SQL that the journal does not list.
 *
 * The runner iterates the journal, so a `.sql` file missing from it is not
 * "pending" — it is invisible, and can never be applied on any machine while the
 * app boots reporting success with the table absent. Migration 0046 shipped in
 * exactly that state (CHOO-1809): the SQL and its snapshot were committed and
 * the journal entry was not, which is only detectable by looking for the
 * mismatch, never by running the migrations.
 *
 * Exported for the test that locks the invariant in; the runner asserts it at
 * boot because it is a packaging mistake, not a recoverable condition.
 */
export function orphanedMigrationTags(sqlKeys: string[], journalTags: string[]): string[] {
  const known = new Set(journalTags);
  return sqlKeys
    .map(migrationTagFromKey)
    .filter((tag): tag is string => !!tag && !known.has(tag))
    .sort();
}

/** A bundled SQL file's migration tag — its basename without the extension. */
function migrationTagFromKey(key: string): string | null {
  const base = key.split('/').at(-1);
  return base?.endsWith('.sql') ? base.slice(0, -'.sql'.length) : null;
}

function runBundledMigrations(connection: BetterSqlite3.Database): void {
  const migrationLog = log.child({ component: 'db-migration' });
  const startedAt = Date.now();
  const applied: string[] = [];

  connection.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    )
  `);

  const entries = (journal as { entries: JournalEntry[] }).entries;

  const orphans = orphanedMigrationTags(
    Object.keys(sqlFiles),
    entries.map((entry) => entry.tag)
  );
  if (orphans.length) {
    throw new Error(
      `Migration SQL is not registered in the journal: ${orphans.join(', ')}. ` +
        `The journal drives which migrations run, so these would never be applied. ` +
        `Add the entry to drizzle/meta/_journal.json (or regenerate with db:generate).`
    );
  }

  // Resolved by exact tag rather than substring: `0012_foo` would otherwise also
  // match a bundled `0012_foo_bar.sql`, and whichever the glob happened to list
  // first would be applied under the other's name.
  const sqlByTag = new Map(
    Object.keys(sqlFiles).map((key) => [migrationTagFromKey(key), key] as const)
  );

  const lastRow = connection
    .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')
    .get() as { created_at: number } | undefined;
  const lastTimestamp = lastRow?.created_at ?? 0;

  // Apply migrations with foreign keys disabled. SQLite's table-recreation
  // pattern (CREATE __new / copy / DROP / RENAME) used to drop columns that are
  // part of a foreign key would otherwise trigger implicit cascade-deletes on
  // `DROP TABLE`. The pragma is a no-op inside a transaction, so toggle it here
  // (outside the migration transaction) and restore it afterwards.
  connection.pragma('foreign_keys = OFF');
  try {
    // A failed migration is unrecoverable and cannot be reconstructed after the
    // fact, so which one was being applied is recorded as it happens.
    connection.transaction(() => {
      for (const entry of entries) {
        if (entry.when <= lastTimestamp) continue;

        const sqlKey = sqlByTag.get(entry.tag);
        if (!sqlKey) throw new Error(`Missing bundled SQL for migration: ${entry.tag}`);

        const sql = sqlFiles[sqlKey];
        const hash = createHash('sha256').update(sql).digest('hex');

        for (const stmt of sql.split('--> statement-breakpoint')) {
          const trimmed = stmt.trim();
          if (trimmed) connection.exec(trimmed);
        }

        connection
          .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
          .run(hash, entry.when);
        applied.push(entry.tag);
      }
    })();

    if (applied.length) {
      migrationLog.info('Applied database migrations', {
        event: 'db_migration_applied',
        migrations: applied,
        durationMs: Date.now() - startedAt,
      });
    }
  } catch (error) {
    migrationLog.error('Database migration failed', {
      event: 'db_migration_failed',
      applied,
      failedAfter: applied.at(-1) ?? '(none)',
      durationMs: Date.now() - startedAt,
      error: String(error),
    });
    throw error;
  } finally {
    connection.pragma('foreign_keys = ON');
  }
}

/**
 * Creates the FTS5 full-text search virtual table used by the command palette.
 * This is managed outside the Drizzle migration system because Drizzle cannot
 * generate FTS5 virtual table DDL. The table is version-gated via the `kv`
 * table so it can be safely dropped and recreated when the schema changes.
 */
function ensureSearchIndex(connection: BetterSqlite3.Database): void {
  // Bump this version string whenever the FTS schema changes — the table is
  // dropped and recreated, and backfill() + seedCommands() repopulate it.
  const SEARCH_INDEX_VERSION = '5';

  const row = connection.prepare(`SELECT value FROM kv WHERE key = 'fts_version'`).get() as
    | { value: string }
    | undefined;

  if (row?.value !== SEARCH_INDEX_VERSION) {
    connection.exec(`DROP TABLE IF EXISTS search_index`);
    connection.exec(`
      CREATE VIRTUAL TABLE search_index USING fts5(
        -- UNINDEXED: the type is a discriminator, not content. Indexed under a
        -- trigram tokenizer it made its own literal searchable, so "ses" matched
        -- every session and "com" every command through this column alone.
        item_type   UNINDEXED,
        item_id     UNINDEXED,
        location_id UNINDEXED,
        session_id  UNINDEXED,
        title,
        keywords,
        tokenize = 'trigram case_sensitive 0'
      )
    `);
    connection
      .prepare(
        `INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('fts_version', ?, unixepoch())`
      )
      .run(SEARCH_INDEX_VERSION);
  }
}

/**
 * Drops the location file index. It existed to back file results in the
 * command palette; those are gone, and nothing else ever read it. An existing
 * database still carries the tables and their rows, so they are removed here
 * rather than left behind as a write-only index. Version-gated via `kv` like
 * the tables were, so this runs once per database.
 */
function dropFileIndex(connection: BetterSqlite3.Database): void {
  const FILE_INDEX_VERSION = 'dropped';

  const row = connection.prepare(`SELECT value FROM kv WHERE key = 'file_index_version'`).get() as
    | { value: string }
    | undefined;

  if (row?.value === FILE_INDEX_VERSION) return;

  connection.exec(`DROP TABLE IF EXISTS location_file_index`);
  connection.exec(`DROP TABLE IF EXISTS workspace_file_index_meta`);
  connection.exec(`DROP TABLE IF EXISTS location_file_index_meta`);
  connection
    .prepare(
      `INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('file_index_version', ?, unixepoch())`
    )
    .run(FILE_INDEX_VERSION);
}

/**
 * Runs all pending migrations against the provided SQLite connection (or the
 * app's shared singleton when called without arguments). Call this once in
 * main.ts before any db queries run.
 *
 * Accepts an explicit connection so migration tests and fixture generators can
 * pass an in-memory database without pulling in the Electron-dependent client
 * module at import time.
 *
 * Returns the connection that was used.
 */
export async function initializeDatabase(
  connection?: BetterSqlite3.Database
): Promise<BetterSqlite3.Database> {
  // Lazily import the app singleton only when no explicit connection is given.
  // This keeps the module importable in non-Electron environments (Vitest).
  const conn = connection ?? (await import('./client')).sqlite;
  runBundledMigrations(conn);
  ensureSearchIndex(conn);
  dropFileIndex(conn);
  return conn;
}
