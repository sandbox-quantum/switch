/**
 * Migration 0041 — collapses agent identity onto `agents.name` and deletes
 * leaked / misidentified sessions (CHOO-1440 follow-up).
 *
 * Step 1 backfills `name` from the authoritative `definition_name`. Step 2
 * deletes sessions whose frozen `config.agentName` (legacy `subagentName`) tag
 * disagrees with the owning agent's (now-authoritative) `name`; healthy and
 * untagged sessions survive.
 *
 * This migration reads `definition_name`, which the very next migration drops —
 * so it cannot be replayed against the final schema that `openFixture` builds.
 * The test instead stands up a minimal isolated schema carrying just the columns
 * the migration touches, and applies the committed SQL against it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MIGRATION_SQL = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../drizzle/0041_delete_leaked_tagged_sessions.sql'
  ),
  'utf8'
);

function applyMigration(db: Database.Database): void {
  for (const stmt of MIGRATION_SQL.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (trimmed) db.exec(trimmed);
  }
}

describe('migration 0041: collapse to agents.name + delete diverged sessions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        definition_name TEXT
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        title TEXT NOT NULL,
        config TEXT
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  function seedAgent(id: string, name: string, definitionName: string | null): void {
    db.prepare(`INSERT INTO agents (id, name, definition_name) VALUES (?, ?, ?)`).run(
      id,
      name,
      definitionName
    );
  }

  function seedSession(id: string, agentId: string, config: Record<string, unknown> | null): void {
    db.prepare(`INSERT INTO sessions (id, agent_id, title, config) VALUES (?, ?, ?, ?)`).run(
      id,
      agentId,
      id,
      config === null ? null : JSON.stringify(config)
    );
  }

  function agentName(id: string): string {
    return (db.prepare(`SELECT name FROM agents WHERE id = ?`).get(id) as { name: string }).name;
  }

  function sessionIds(): string[] {
    return (db.prepare(`SELECT id FROM sessions ORDER BY id`).all() as { id: string }[]).map(
      (r) => r.id
    );
  }

  it('backfills name from definition_name and keeps only matching/untagged sessions', () => {
    // 'main' already agrees; 'orchestrator' has a stale name that must be
    // rewritten to its authoritative definition_name.
    seedAgent('main', 'main', 'main');
    seedAgent('orchestrator', 'stale-name', 'room-orchestrator');

    // Healthy: tag matches the agent's authoritative (post-backfill) name.
    seedSession('healthy', 'main', { agentName: 'main', autoApprove: true });
    seedSession('healthy-legacy-key', 'orchestrator', { subagentName: 'room-orchestrator' });

    // Broken: owned by 'main' but tagged as another agent. Deleted.
    seedSession('mis-assigned', 'main', { agentName: 'room-orchestrator' });
    // Ghost: tagged as a name no agent carries. Deleted.
    seedSession('ghost', 'main', { agentName: 'vanished-agent' });
    // Untagged: nothing to reconcile. Kept.
    seedSession('untagged', 'main', { autoApprove: false });
    seedSession('untagged-null-config', 'main', null);

    applyMigration(db);

    expect(agentName('main')).toBe('main');
    expect(agentName('orchestrator')).toBe('room-orchestrator');
    expect(sessionIds()).toEqual([
      'healthy',
      'healthy-legacy-key',
      'untagged',
      'untagged-null-config',
    ]);
  });

  it('leaves name untouched when definition_name is null', () => {
    seedAgent('plain', 'plain-name', null);
    seedSession('s', 'plain', null);

    applyMigration(db);

    expect(agentName('plain')).toBe('plain-name');
    expect(sessionIds()).toEqual(['s']);
  });
});
