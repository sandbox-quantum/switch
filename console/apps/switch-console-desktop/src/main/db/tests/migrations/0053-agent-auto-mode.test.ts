/**
 * Migration 0053 — auto mode, the provider's own automatic review.
 *
 * Runs the real migration runner over `pre-0053.db` (the baseline fixture at
 * 0052), and the SQL over a hand-built table for the bypass setting, which the
 * baseline's agents all have off.
 *
 * Agents that already exist keep the behaviour they had: auto mode reads as
 * off for every one of them, and their bypass setting is untouched. New agents
 * get auto mode from the code that creates them, not from the column.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFixture } from '@tooling/utils/db';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const MIGRATION_SQL = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../drizzle/0053_agent_auto_mode.sql'
  ),
  'utf8'
);

describe('migration 0053: agent auto mode', () => {
  it('turns auto mode off for every agent the upgrade meets', async () => {
    const fixture = await openFixture('pre-0053');
    try {
      expect(fixture.sqlite.prepare('SELECT id, auto_mode FROM agents ORDER BY id').all()).toEqual([
        { id: 'a9e70001-0000-0000-0000-000000000000', auto_mode: 0 },
        { id: 'a9e70002-0000-0000-0000-000000000000', auto_mode: 0 },
        { id: 'a9e70003-0000-0000-0000-000000000000', auto_mode: 0 },
      ]);
    } finally {
      fixture.close();
    }
  });

  it('keeps each agent’s bypass setting as it was', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE agents (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          auto_approve INTEGER DEFAULT false NOT NULL
        );
        INSERT INTO agents (id, name, auto_approve) VALUES ('local', 'Local', 0), ('remote', 'Remote', 1);
      `);
      for (const statement of MIGRATION_SQL.split('--> statement-breakpoint')) db.exec(statement);

      expect(
        db.prepare('SELECT id, auto_approve, auto_mode FROM agents ORDER BY id').all()
      ).toEqual([
        { id: 'local', auto_approve: 0, auto_mode: 0 },
        { id: 'remote', auto_approve: 1, auto_mode: 0 },
      ]);
      db.prepare(`INSERT INTO agents (id, name) VALUES ('later', 'Later')`).run();
      expect(db.prepare(`SELECT auto_mode FROM agents WHERE id = 'later'`).get()).toEqual({
        auto_mode: 0,
      });
    } finally {
      db.close();
    }
  });
});
