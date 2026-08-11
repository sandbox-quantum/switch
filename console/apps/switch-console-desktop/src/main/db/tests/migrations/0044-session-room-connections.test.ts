/**
 * Migration 0044 — moves session→room connections out of the
 * `switchRoomConnections` JSON blob in `app_settings` into their own table.
 *
 * The interesting behaviour is the filter: connections whose session still
 * exists are carried over, leaked ones (the session, and so the agent above it,
 * are long gone) are dropped, and the blob is deleted so nothing can resurrect
 * them. Applying the committed SQL against a minimal schema keeps the test on
 * exactly the statements that ship — `openFixture` would have already created
 * the table, so the migration cannot be replayed against it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MIGRATION_SQL = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../drizzle/0044_session_room_connections.sql'
  ),
  'utf8'
);

function applyMigration(db: Database.Database): void {
  for (const stmt of MIGRATION_SQL.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (trimmed) db.exec(trimmed);
  }
}

type BlobEntry = { roomId: string; agentId: string; roomName: string | null };

describe('migration 0044: session room connections', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        title TEXT NOT NULL
      );
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  function seedSession(id: string): void {
    db.prepare(`INSERT INTO sessions (id, agent_id, title) VALUES (?, 'agent-1', 'Session')`).run(
      id
    );
  }

  function seedBlob(entries: Record<string, BlobEntry>): void {
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('switchRoomConnections', ?)`).run(
      JSON.stringify(entries)
    );
  }

  function connectionRows(): { session_id: string; room_id: string; room_name: string | null }[] {
    return db
      .prepare(
        `SELECT session_id, room_id, room_name, switch_agent_id FROM session_room_connections`
      )
      .all() as { session_id: string; room_id: string; room_name: string | null }[];
  }

  it('carries over a live connection with its room and agent identity', () => {
    seedSession('session-live');
    seedBlob({
      'session-live': { roomId: 'room-1', agentId: 'switch-agent-1', roomName: 'Design' },
    });

    applyMigration(db);

    expect(connectionRows()).toEqual([
      {
        session_id: 'session-live',
        room_id: 'room-1',
        room_name: 'Design',
        switch_agent_id: 'switch-agent-1',
      },
    ]);
  });

  it('drops connections whose session no longer exists', () => {
    seedSession('session-live');
    seedBlob({
      'session-live': { roomId: 'room-1', agentId: 'switch-agent-1', roomName: 'Design' },
      'session-gone': { roomId: 'room-2', agentId: 'switch-agent-2', roomName: 'Leaked' },
    });

    applyMigration(db);

    expect(connectionRows().map((row) => row.session_id)).toEqual(['session-live']);
  });

  it('deletes the blob so the dropped connections cannot be resurrected', () => {
    seedSession('session-live');
    seedBlob({
      'session-live': { roomId: 'room-1', agentId: 'switch-agent-1', roomName: null },
    });

    applyMigration(db);

    const remaining = db
      .prepare(`SELECT count(*) AS n FROM app_settings WHERE key = 'switchRoomConnections'`)
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('tolerates a missing blob, an unparseable one, and entries without a room', () => {
    seedSession('session-live');

    applyMigration(db);
    expect(connectionRows()).toEqual([]);

    db.exec(`DROP TABLE session_room_connections`);
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('switchRoomConnections', ?)`).run(
      'not json'
    );
    applyMigration(db);
    expect(connectionRows()).toEqual([]);

    db.exec(`DROP TABLE session_room_connections`);
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('switchRoomConnections', ?)`).run(
      JSON.stringify({ 'session-live': { agentId: 'switch-agent-1' } })
    );
    applyMigration(db);
    expect(connectionRows()).toEqual([]);
  });
});
