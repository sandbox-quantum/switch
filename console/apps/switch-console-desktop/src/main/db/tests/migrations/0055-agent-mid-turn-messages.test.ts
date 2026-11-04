/**
 * Migration 0055: how an agent's sessions take a message sent while a turn
 * is running.
 *
 * Steering is the default, for agents the upgrade meets as for new ones, and
 * nothing else about an agent changes.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const MIGRATION_SQL = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../drizzle/0055_agent_mid_turn_messages.sql'
  ),
  'utf8'
);

describe('migration 0055: agent mid-turn messages', () => {
  it('has every agent steer, existing and new, and leaves its other settings alone', () => {
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
          .prepare('SELECT id, auto_approve, auto_mode, mid_turn_messages FROM agents ORDER BY id')
          .all()
      ).toEqual([
        { id: 'local', auto_approve: 0, auto_mode: 1, mid_turn_messages: 'steer' },
        { id: 'remote', auto_approve: 1, auto_mode: 0, mid_turn_messages: 'steer' },
      ]);
      db.prepare(`INSERT INTO agents (id, name) VALUES ('later', 'Later')`).run();
      expect(db.prepare(`SELECT mid_turn_messages FROM agents WHERE id = 'later'`).get()).toEqual({
        mid_turn_messages: 'steer',
      });
    } finally {
      db.close();
    }
  });
});
