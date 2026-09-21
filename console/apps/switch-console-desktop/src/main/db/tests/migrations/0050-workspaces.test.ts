/**
 * Migration 0050 — introduces workspaces, the unit the window is scoped to, and
 * moves agents from being owned by a server to being owned by a workspace.
 *
 * The upgrade has to be invisible: everyone currently has servers and no
 * workspaces, so each server gets exactly one workspace reusing the server's id.
 * That reuse is the whole backward-compatibility story — agent rows, the active
 * selection in `kv`, and the opaque navigation snapshots all keep referring to
 * the same string — so these tests pin it rather than just checking the table
 * exists.
 *
 * The SQL is applied to a hand-built pre-0050 schema (the same approach as the
 * 0047 test) because the committed fixtures have already been migrated past it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MIGRATION_SQL = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../drizzle/0050_workspaces.sql'
  ),
  'utf8'
);

type WorkspaceRow = {
  id: string;
  server_id: string;
  name: string;
  tenant_id: string | null;
  slug: string | null;
  role: string | null;
};

describe('migration 0050: workspaces', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE switch_servers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        gateway_url TEXT NOT NULL,
        api_url TEXT NOT NULL,
        managed INTEGER NOT NULL DEFAULT 0,
        management_kind TEXT,
        ssh_host TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE locations (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL
      );
      INSERT INTO locations (id, name) VALUES ('loc-1', 'repo');
      -- Mirrors the real pre-0050 agents DDL, foreign keys included. The
      -- columns are not incidental: server_id carrying an FK is exactly why the
      -- migration has to recreate the table instead of dropping the column.
      CREATE TABLE agents (
        id TEXT PRIMARY KEY NOT NULL,
        location_id TEXT NOT NULL,
        name TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        switch_agent_id TEXT,
        api_endpoint TEXT,
        server_id TEXT,
        status TEXT,
        auto_approve INTEGER DEFAULT false NOT NULL,
        owner_name TEXT,
        provider_config TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
        FOREIGN KEY (location_id) REFERENCES locations(id),
        FOREIGN KEY (server_id) REFERENCES switch_servers(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_agents_location_id ON agents (location_id);
      CREATE INDEX idx_agents_server_id ON agents (server_id);
      CREATE TABLE kv (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  function seedServer(id: string, name: string): void {
    db.prepare(
      `INSERT INTO switch_servers (id, name, gateway_url, api_url) VALUES (?, ?, ?, ?)`
    ).run(id, name, `https://${id}.example`, `https://${id}.example:8000`);
  }

  function seedAgent(id: string, serverId: string | null): void {
    db.prepare(
      `INSERT INTO agents (id, location_id, name, provider_id, server_id) VALUES (?, 'loc-1', ?, 'claude', ?)`
    ).run(id, id, serverId);
  }

  function applyMigration(): void {
    for (const stmt of MIGRATION_SQL.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim();
      if (trimmed) db.exec(trimmed);
    }
  }

  function workspaces(): WorkspaceRow[] {
    return db.prepare(`SELECT * FROM workspaces ORDER BY name`).all() as WorkspaceRow[];
  }

  it('gives every existing server exactly one workspace, named after it', () => {
    seedServer('srv-local', 'Local dev');
    seedServer('srv-cloud', 'Switch Cloud');

    applyMigration();

    expect(workspaces().map((w) => [w.server_id, w.name])).toEqual([
      ['srv-local', 'Local dev'],
      ['srv-cloud', 'Switch Cloud'],
    ]);
  });

  it('reuses the server id as the workspace id, so persisted ids stay valid', () => {
    seedServer('srv-local', 'Local dev');

    applyMigration();

    const [workspace] = workspaces();
    expect(workspace!.id).toBe('srv-local');
  });

  // No gateway is asked during the upgrade — it must not depend on one being
  // reachable — so the tenant is filled in by the first reconcile, not here.
  it('leaves the migrated workspaces tenant-less for the first reconcile to match', () => {
    seedServer('srv-local', 'Local dev');

    applyMigration();

    const [workspace] = workspaces();
    expect(workspace!.tenant_id).toBeNull();
    expect(workspace!.slug).toBeNull();
    expect(workspace!.role).toBeNull();
  });

  it("moves each agent onto its server's workspace", () => {
    seedServer('srv-local', 'Local dev');
    seedServer('srv-cloud', 'Switch Cloud');
    seedAgent('agent-a', 'srv-local');
    seedAgent('agent-b', 'srv-cloud');

    applyMigration();

    const rows = db.prepare(`SELECT id, workspace_id FROM agents ORDER BY id`).all() as {
      id: string;
      workspace_id: string | null;
    }[];
    expect(rows).toEqual([
      { id: 'agent-a', workspace_id: 'srv-local' },
      { id: 'agent-b', workspace_id: 'srv-cloud' },
    ]);
  });

  it('keeps an unlinked agent unlinked rather than guessing a workspace for it', () => {
    seedServer('srv-local', 'Local dev');
    seedAgent('agent-unlinked', null);

    applyMigration();

    const row = db
      .prepare(`SELECT workspace_id FROM agents WHERE id = ?`)
      .get('agent-unlinked') as {
      workspace_id: string | null;
    };
    expect(row.workspace_id).toBeNull();
  });

  // The old server_id was added by ALTER TABLE ADD COLUMN, which in SQLite
  // cannot carry ON DELETE, so its set-null was never enforced and a row can
  // point at a server that is gone. Carrying that value over would seed the new,
  // engine-enforced foreign key with a violation, and the migration runs with
  // foreign_keys=OFF, so nothing would catch it until much later.
  it('drops an agent’s link to a server that no longer exists', () => {
    seedServer('srv-local', 'Local dev');
    seedAgent('agent-a', 'srv-local');
    // The dangling value has to be written with the constraint off, which is
    // how it arises: the real column was added by ALTER TABLE, so the engine
    // never enforced the clause this fixture's DDL can only state up front.
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(`UPDATE agents SET server_id = 'srv-gone' WHERE id = 'agent-a'`).run();

    applyMigration();
    db.exec('PRAGMA foreign_keys = ON');

    const row = db.prepare(`SELECT workspace_id FROM agents WHERE id = 'agent-a'`).get() as {
      workspace_id: string | null;
    };
    expect(row.workspace_id).toBeNull();
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
  });

  it('carries every other agent column through the table rebuild', () => {
    seedServer('srv-local', 'Local dev');
    db.prepare(
      `INSERT INTO agents (id, location_id, name, provider_id, switch_agent_id, api_endpoint, server_id, status, auto_approve, owner_name, provider_config)
       VALUES ('agent-a', 'loc-1', 'Worker', 'codex', 'switch-123', 'https://api.example', 'srv-local', 'live', 1, 'petr', '{"v":1}')`
    ).run();

    applyMigration();

    const row = db.prepare(`SELECT * FROM agents WHERE id = 'agent-a'`).get() as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      location_id: 'loc-1',
      name: 'Worker',
      provider_id: 'codex',
      switch_agent_id: 'switch-123',
      api_endpoint: 'https://api.example',
      workspace_id: 'srv-local',
      status: 'live',
      auto_approve: 1,
      owner_name: 'petr',
      provider_config: '{"v":1}',
    });
  });

  it('keeps the location foreign key working after the rebuild', () => {
    seedServer('srv-local', 'Local dev');
    seedAgent('agent-a', 'srv-local');

    applyMigration();
    db.exec('PRAGMA foreign_keys = ON');

    expect(() =>
      db
        .prepare(`INSERT INTO agents (id, location_id, name, provider_id) VALUES (?, ?, ?, ?)`)
        .run('agent-b', 'loc-missing', 'B', 'claude')
    ).toThrow(/FOREIGN KEY/);
  });

  it('drops the old server column so nothing can keep reading it', () => {
    seedServer('srv-local', 'Local dev');

    applyMigration();

    const columns = (db.prepare(`PRAGMA table_info('agents')`).all() as { name: string }[]).map(
      (c) => c.name
    );
    expect(columns).toContain('workspace_id');
    expect(columns).not.toContain('server_id');
  });

  it('carries the active selection over, so the app opens where it was left', () => {
    seedServer('srv-local', 'Local dev');
    db.prepare(`INSERT INTO kv (key, value) VALUES ('activeSwitchServerId', 'srv-local')`).run();

    applyMigration();

    const active = db.prepare(`SELECT value FROM kv WHERE key = 'activeWorkspaceId'`).get() as
      | { value: string }
      | undefined;
    expect(active?.value).toBe('srv-local');

    const stale = db.prepare(`SELECT value FROM kv WHERE key = 'activeSwitchServerId'`).get();
    expect(stale).toBeUndefined();
  });

  it('survives an install that had no active selection recorded', () => {
    seedServer('srv-local', 'Local dev');

    applyMigration();

    const active = db.prepare(`SELECT value FROM kv WHERE key = 'activeWorkspaceId'`).get();
    expect(active).toBeUndefined();
  });

  it('survives a fresh install with no servers at all', () => {
    applyMigration();

    expect(workspaces()).toEqual([]);
  });

  it('removes a server’s workspaces with it', () => {
    seedServer('srv-local', 'Local dev');
    applyMigration();
    db.exec('PRAGMA foreign_keys = ON');

    db.prepare(`DELETE FROM switch_servers WHERE id = ?`).run('srv-local');

    expect(workspaces()).toEqual([]);
  });

  // Two foreign keys deep, and the one the old schema only claimed: the server's
  // workspaces cascade away, and their agents are unlinked rather than deleted.
  it('unlinks an agent when the server under its workspace is deleted', () => {
    seedServer('srv-local', 'Local dev');
    seedAgent('agent-a', 'srv-local');
    applyMigration();
    db.exec('PRAGMA foreign_keys = ON');

    db.prepare(`DELETE FROM switch_servers WHERE id = ?`).run('srv-local');

    const row = db.prepare(`SELECT workspace_id FROM agents WHERE id = 'agent-a'`).get() as {
      workspace_id: string | null;
    };
    expect(row.workspace_id).toBeNull();
  });

  it('lets two servers each keep a tenant-less workspace', () => {
    seedServer('srv-a', 'A');
    seedServer('srv-b', 'B');

    applyMigration();

    expect(workspaces()).toHaveLength(2);
  });

  it('refuses two workspaces with the same tenant on one server', () => {
    seedServer('srv-cloud', 'Switch Cloud');
    applyMigration();

    const insert = (id: string, tenantId: string) =>
      db
        .prepare(`INSERT INTO workspaces (id, server_id, name, tenant_id) VALUES (?, ?, ?, ?)`)
        .run(id, 'srv-cloud', id, tenantId);

    insert('ws-1', 'tenant-1');
    expect(() => insert('ws-2', 'tenant-1')).toThrow(/UNIQUE/);
  });

  it('allows the same tenant id on two different servers', () => {
    seedServer('srv-a', 'A');
    seedServer('srv-b', 'B');
    applyMigration();

    db.prepare(`INSERT INTO workspaces (id, server_id, name, tenant_id) VALUES (?, ?, ?, ?)`).run(
      'ws-a',
      'srv-a',
      'Shared',
      'tenant-1'
    );
    expect(() =>
      db
        .prepare(`INSERT INTO workspaces (id, server_id, name, tenant_id) VALUES (?, ?, ?, ?)`)
        .run('ws-b', 'srv-b', 'Shared', 'tenant-1')
    ).not.toThrow();
  });
});
