/**
 * An older build must refuse a database migrated by a newer build (CHOO-3384).
 *
 * Stable and Canary share one data directory. Canary 0.39's 0051_workspaces
 * rebuilds `agents` without `server_id`; stable 0.38.2 then skipped every
 * migration at or below the newest applied timestamp, applied nothing, reported
 * success and booted on the newer schema. `getAgents` selected
 * `agents.server_id` and the renderer was left on a blank window.
 *
 * The old build is simulated by running the real runner against the journal
 * truncated before 0051 — exactly what a 0.38.2 bundle contains.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  DatabaseFromNewerBuildError,
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
const olderSqlFiles = Object.fromEntries(
  Object.entries(sqlFiles).filter(([key]) =>
    olderEntries.some((entry) => key.endsWith(`/${entry.tag}.sql`))
  )
);

describe('database migrated by a newer build', () => {
  let db: Database.Database;

  afterEach(() => db?.close());

  it('finds 0051 in the journal, so the older build below is really older', () => {
    expect(cut).toBeGreaterThan(0);
  });

  it('is refused by the older build instead of booting on the newer schema', () => {
    db = new Database(':memory:');
    applyMigrations(db, allEntries, sqlFiles); // the newer build (Canary)

    expect(() => applyMigrations(db, olderEntries, olderSqlFiles)).toThrow(
      DatabaseFromNewerBuildError
    );
    expect(() => applyMigrations(db, olderEntries, olderSqlFiles)).toThrow(
      /last opened by a newer version/
    );
  });

  it('counts how many migrations the older build does not know', () => {
    db = new Database(':memory:');
    applyMigrations(db, allEntries, sqlFiles);
    try {
      applyMigrations(db, olderEntries, olderSqlFiles);
      expect.unreachable();
    } catch (error) {
      expect((error as DatabaseFromNewerBuildError).unknownMigrations).toBe(
        allEntries.length - olderEntries.length
      );
    }
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
