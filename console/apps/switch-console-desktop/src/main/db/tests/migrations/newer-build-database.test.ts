/**
 * A build must refuse a database migrated by a build it does not match
 * (CHOO-3384), and must never skip a migration it has not applied.
 *
 * Stable and Canary share one data directory. Canary 0.39's 0051_workspaces
 * rebuilds `agents` without `server_id`; stable 0.38.2 then skipped every
 * migration at or below the newest applied timestamp, applied nothing, reported
 * success and booted on the newer schema. `getAgents` selected
 * `agents.server_id` and the renderer was left on a blank window.
 *
 * The old build is simulated by running the real runner against the journal
 * truncated before 0051 — exactly what a 0.38.2 bundle contains. A stable
 * hotfix cut from that point is simulated by adding a migration stamped after
 * everything on main, which is what `db:generate` on a release branch produces.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  DatabaseFromNewerBuildError,
  initializeDatabase,
  type JournalEntry,
} from '@main/db/initialize';
import journal from '@root/drizzle/meta/_journal.json';

const drizzleDir = fileURLToPath(new URL('../../../../../drizzle', import.meta.url));
const sqlFiles = Object.fromEntries(
  readdirSync(drizzleDir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => [`/drizzle/${name}`, readFileSync(`${drizzleDir}/${name}`, 'utf8')])
);
const allEntries = journal.entries as JournalEntry[];
const cut = allEntries.findIndex((entry) => entry.tag === '0051_workspaces');
const olderEntries = allEntries.slice(0, cut);
const olderSqlFiles = sqlFilesFor(olderEntries);
const newestKnown = Math.max(...allEntries.map((entry) => entry.when));

const hotfix: JournalEntry = {
  idx: cut,
  when: newestKnown + 1000,
  tag: '0051_stable_hotfix',
  breakpoints: true,
};
const hotfixSqlFiles = {
  '/drizzle/0051_stable_hotfix.sql': 'CREATE TABLE `stable_hotfix` (`id` integer PRIMARY KEY);',
};

function sqlFilesFor(entries: JournalEntry[]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sqlFiles).filter(([key]) =>
      entries.some((entry) => key.endsWith(`/${entry.tag}.sql`))
    )
  );
}

function schemaAndLedger(db: Database.Database): unknown {
  return {
    schema: db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all(),
    ledger: db.prepare('SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id').all(),
  };
}

function refusal(run: () => unknown): DatabaseFromNewerBuildError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseFromNewerBuildError);
    return error as DatabaseFromNewerBuildError;
  }
  throw new Error('expected the runner to refuse the database');
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (column) => column.name
  );
}

describe('database migrated by a newer build', () => {
  let db: Database.Database;

  afterEach(() => db?.close());

  it('finds 0051 in the journal, so the older build below is really older', () => {
    expect(cut).toBeGreaterThan(0);
    expect(olderEntries.length).toBe(cut);
  });

  it('is refused by the older build instead of booting on the newer schema', () => {
    db = new Database(':memory:');
    applyMigrations(db, allEntries, sqlFiles); // the newer build (Canary)

    const error = refusal(() => applyMigrations(db, olderEntries, olderSqlFiles));
    expect(error.message).toMatch(/last opened by a newer or different version/);
  });

  it('counts how many migrations the older build does not know', () => {
    db = new Database(':memory:');
    applyMigrations(db, allEntries, sqlFiles);

    const error = refusal(() => applyMigrations(db, olderEntries, olderSqlFiles));
    expect(error.unknownMigrations).toBe(allEntries.length - olderEntries.length);
  });

  it('leaves the schema and the ledger exactly as it found them when it refuses', () => {
    db = new Database(':memory:');
    applyMigrations(db, allEntries, sqlFiles);
    const before = schemaAndLedger(db);

    refusal(() => applyMigrations(db, olderEntries, olderSqlFiles));

    expect(schemaAndLedger(db)).toEqual(before);
  });

  it('still upgrades a database from an older build, and reopens it as a no-op', () => {
    db = new Database(':memory:');
    applyMigrations(db, olderEntries, olderSqlFiles);
    expect(() => applyMigrations(db, allEntries, sqlFiles)).not.toThrow();
    expect(() => applyMigrations(db, allEntries, sqlFiles)).not.toThrow();
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as {
      n: number;
    };
    expect(n).toBe(allEntries.length);
  });
});

/**
 * Stable releases can be tagged from any commit, so a stable hotfix can carry a
 * migration main never had. drizzle-kit stamps it with the time it was
 * generated — after everything Canary has — so comparing the newest timestamps
 * says the hotfix build is the newer one. It is not: it does not know 0051.
 */
describe('database migrated by a build that diverged from this one', () => {
  let db: Database.Database;

  afterEach(() => db?.close());

  it('is refused by a stable hotfix whose own migration is stamped after Canary’s', () => {
    db = new Database(':memory:');
    applyMigrations(db, allEntries, sqlFiles); // Canary, with 0051
    const before = schemaAndLedger(db);

    const error = refusal(() =>
      applyMigrations(db, [...olderEntries, hotfix], { ...olderSqlFiles, ...hotfixSqlFiles })
    );

    expect(error.unknownMigrations).toBe(allEntries.length - olderEntries.length);
    expect(schemaAndLedger(db)).toEqual(before);
  });

  it('is refused when an unknown migration sits between known ones, not only after them', () => {
    db = new Database(':memory:');
    applyMigrations(db, allEntries, sqlFiles);
    db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(
      'from-another-branch',
      allEntries[1].when + 1
    );

    expect(refusal(() => applyMigrations(db, allEntries, sqlFiles)).unknownMigrations).toBe(1);
  });

  it('applies a migration stamped before the newest applied one instead of skipping it', () => {
    // The stable hotfix is merged back into main after 0051: main's journal is
    // [..., 0051, hotfix]. A database the hotfix build migrated has the hotfix
    // but not 0051, and the hotfix's timestamp is the higher of the two.
    db = new Database(':memory:');
    applyMigrations(db, [...olderEntries, hotfix], { ...olderSqlFiles, ...hotfixSqlFiles });
    expect(columns(db, 'agents')).toContain('server_id');

    applyMigrations(db, [...allEntries, { ...hotfix, idx: allEntries.length }], {
      ...sqlFiles,
      ...hotfixSqlFiles,
    });

    expect(columns(db, 'agents')).not.toContain('server_id');
    expect(columns(db, 'workspaces')).toContain('server_id');
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as {
      n: number;
    };
    expect(n).toBe(allEntries.length + 1);
  });
});

/** Through the entry point the app calls, with the migrations the bundle carries. */
describe('initializeDatabase on a database from a newer build', () => {
  let db: Database.Database;

  afterEach(() => db?.close());

  it('rejects before the post-migration steps touch anything', async () => {
    db = new Database(':memory:');
    await initializeDatabase(db);
    db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(
      'from-a-newer-build',
      newestKnown + 1
    );
    db.prepare("DELETE FROM kv WHERE key IN ('fts_version', 'file_index_version')").run();
    const before = schemaAndLedger(db);

    await expect(initializeDatabase(db)).rejects.toBeInstanceOf(DatabaseFromNewerBuildError);

    expect(schemaAndLedger(db)).toEqual(before);
    expect(
      db.prepare("SELECT key FROM kv WHERE key IN ('fts_version', 'file_index_version')").all()
    ).toEqual([]);
  });

  it('opens a database this build migrated itself', async () => {
    db = new Database(':memory:');
    await initializeDatabase(db);
    await expect(initializeDatabase(db)).resolves.toBe(db);
  });
});
