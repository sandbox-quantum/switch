/**
 * Migration 0055 — steering messages sent while the agent works.
 *
 * Every agent the upgrade meets steers, as new agents do: the column defaults
 * to on, and the agent's other settings are left as they were.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const MIGRATION_SQL = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../drizzle/0055_agent_steer_messages.sql'
  ),
  'utf8'
);

describe('migration 0055: agent steer messages', () => {
  it('turns steering on for every agent, existing and new, and keeps their other settings', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE agents (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          auto_approve INTEGER DEFAULT false NOT NULL,
          auto_mode INTEGER DEFAULT false NOT NULL
        );
        INSERT INTO agents (id, name, auto_approve, auto_mode)
          VALUES ('local', 'Local', 0, 1), ('remote', 'Remote', 1, 0);
      `);
      for (const statement of MIGRATION_SQL.split('--> statement-breakpoint')) db.exec(statement);

      expect(
        db
          .prepare('SELECT id, auto_approve, auto_mode, steer_messages FROM agents ORDER BY id')
          .all()
      ).toEqual([
        { id: 'local', auto_approve: 0, auto_mode: 1, steer_messages: 1 },
        { id: 'remote', auto_approve: 1, auto_mode: 0, steer_messages: 1 },
      ]);
      db.prepare(`INSERT INTO agents (id, name) VALUES ('later', 'Later')`).run();
      expect(db.prepare(`SELECT steer_messages FROM agents WHERE id = 'later'`).get()).toEqual({
        steer_messages: 1,
      });
    } finally {
      db.close();
    }
  });
});
