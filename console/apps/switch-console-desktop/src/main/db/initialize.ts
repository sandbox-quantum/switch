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

export type JournalEntry = { idx: number; when: number; tag: string; breakpoints: boolean };

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

/**
 * The database has migrations applied that this build does not know about: it
 * was last opened by a newer build, or one that diverged from this one —
 * Canary or a build from source, which share the stable channel's data
 * directory, or a stable hotfix tagged off main (CHOO-3384).
 *
 * Opening it anyway means booting on a schema this build was not written for:
 * the first query that touches a changed table fails, and the renderer is left
 * on a blank window. Refusing with a clear message is the only safe outcome, as
 * downgrading a schema is not something the migrations can do.
 */
export class DatabaseFromNewerBuildError extends Error {
  readonly unknownMigrations: number;
  /** The file that was refused — not always in the data folder (SWITCHDASH_DB_FILE). */
  readonly databasePath: string;

  constructor(unknownTimestamps: number[], newestKnown: number, databasePath: string) {
    super(
      `The database was last opened by a newer or different version of the app: it has ` +
        `${unknownTimestamps.length} migration(s) this version does not know about ` +
        `(ledger timestamps ${unknownTimestamps.join(', ')}; newest known ${newestKnown}).`
    );
    this.name = 'DatabaseFromNewerBuildError';
    this.unknownMigrations = unknownTimestamps.length;
    this.databasePath = databasePath;
  }
}

function runBundledMigrations(connection: BetterSqlite3.Database): void {
  applyMigrations(connection, (journal as { entries: JournalEntry[] }).entries, sqlFiles);
}

/**
 * Applies `entries` (journal order) from `sqlFiles` to `connection`.
 *
 * Exported so tests can run the runner against an older journal — the way an
 * older build sees a database — without rebuilding the bundle.
 */
export function applyMigrations(
  connection: BetterSqlite3.Database,
  entries: JournalEntry[],
  sqlFiles: Record<string, string>
): void {
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

  // Each ledger row is matched to its journal entry by timestamp, rather than
  // treating the newest timestamp as "everything up to here is applied". A
  // high-water mark cannot see a migration from a build that diverged from this
  // one (a stable hotfix stamped after Canary's newest looks like the newer
  // build), and it skips an entry stamped below a migration applied out of
  // order — both boot the app on a schema it was not written for.
  const appliedTimestamps = new Set(
    (
      connection.prepare('SELECT created_at FROM __drizzle_migrations').all() as {
        created_at: number;
      }[]
    ).map((row) => Number(row.created_at))
  );
  const knownTimestamps = new Set(entries.map((entry) => entry.when));
  const unknownTimestamps = [...appliedTimestamps]
    .filter((timestamp) => !knownTimestamps.has(timestamp))
    .sort((a, b) => a - b);
  if (unknownTimestamps.length) {
    const newestKnown = Math.max(0, ...knownTimestamps);
    migrationLog.error('Database was migrated by a newer or different build', {
      event: 'db_migration_newer_schema',
      databasePath: connection.name,
      unknownTimestamps,
      newestKnown,
      unknownMigrations: unknownTimestamps.length,
    });
    throw new DatabaseFromNewerBuildError(unknownTimestamps, newestKnown, connection.name);
  }

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
        if (appliedTimestamps.has(entry.when)) continue;

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

const PROVIDER_CONFIGS_KEY = 'providerConfigs';
const PROVIDER_CONFIGS_SCRUB_KEY = 'provider_configs_scrub';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What a saved `providerConfigs` value held, by name only: never a value. */
function providerConfigNames(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { unreadable: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { unreadable: true };
  const providers = Object.entries(parsed as Record<string, unknown>).map(([provider, config]) => {
    const fields = config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
    const env =
      fields.env && typeof fields.env === 'object' ? Object.keys(fields.env as object) : [];
    return {
      provider,
      envNames: env.filter((name) => ENV_NAME.test(name)),
      otherEnvEntries: env.filter((name) => !ENV_NAME.test(name)).length,
      extraArgs: typeof fields.extraArgs === 'string' && fields.extraArgs.trim() !== '',
    };
  });
  return { providers };
}

/**
 * Deletes the per-provider "Environment variables" and "Additional parameters"
 * earlier builds saved in `app_settings` and never applied to a launch. They
 * were plaintext and the obvious place to paste an API key, so the database is
 * vacuumed and its WAL truncated afterwards: a deleted row otherwise lingers in
 * free space, and an edited one in older copies of its page. Until that has
 * succeeded a `kv` marker stays behind and the next launch tries again.
 */
export function dropProviderConfigs(connection: BetterSqlite3.Database): void {
  const scrubLog = log.child({ component: 'db-migration' });
  const row = connection
    .prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get(PROVIDER_CONFIGS_KEY) as { value: string } | undefined;
  const pending =
    connection.prepare(`SELECT 1 FROM kv WHERE key = ?`).get(PROVIDER_CONFIGS_SCRUB_KEY) !==
    undefined;
  if (!row && !pending) return;

  if (row) {
    const previous = connection.pragma('secure_delete', { simple: true }) as number;
    connection.pragma('secure_delete = ON');
    try {
      connection.transaction(() => {
        connection.prepare(`DELETE FROM app_settings WHERE key = ?`).run(PROVIDER_CONFIGS_KEY);
        connection
          .prepare(
            `INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, 'pending', unixepoch())`
          )
          .run(PROVIDER_CONFIGS_SCRUB_KEY);
      })();
    } finally {
      connection.pragma(`secure_delete = ${previous}`);
    }
    scrubLog.warn(
      'Deleted the saved provider environment variables and additional parameters, which no launch ever applied',
      { event: 'provider_settings_dropped', ...providerConfigNames(row.value) }
    );
  }

  try {
    connection.exec('VACUUM');
  } catch (error) {
    scrubLog.error(
      'Could not vacuum the database after deleting the saved provider settings; older copies of their values may remain in it until the next launch tries again',
      { event: 'provider_settings_scrub_failed', stage: 'vacuum', error: String(error) }
    );
    return;
  }
  const [checkpoint] = connection.pragma('wal_checkpoint(TRUNCATE)') as {
    busy: number;
    log: number;
    checkpointed: number;
  }[];
  if (!checkpoint || checkpoint.busy !== 0) {
    scrubLog.error(
      'Could not checkpoint the database after deleting the saved provider settings; their values may remain in the write-ahead log until the next launch tries again',
      { event: 'provider_settings_scrub_failed', stage: 'checkpoint', checkpoint }
    );
    return;
  }
  connection.prepare(`DELETE FROM kv WHERE key = ?`).run(PROVIDER_CONFIGS_SCRUB_KEY);
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
  // After the migrations, which refuse a database from a newer build before
  // writing to it: switching the journal mode writes the file header.
  conn.pragma('journal_mode = WAL');
  ensureSearchIndex(conn);
  dropFileIndex(conn);
  dropProviderConfigs(conn);
  return conn;
}
