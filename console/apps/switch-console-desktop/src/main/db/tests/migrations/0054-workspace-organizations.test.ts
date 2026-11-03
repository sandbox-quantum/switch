/**
 * Migration 0054 — the organization each workspace belongs to.
 *
 * Runs the real migration runner over `pre-0054.db` (the baseline fixture at
 * 0053), and the SQL over a hand-built table holding workspaces, which the
 * baseline has none of.
 *
 * Workspaces that already exist read as belonging to no organization until the
 * next reconcile asks the server, which is what a server from before
 * organizations would answer too.
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
    '../../../../../drizzle/0054_workspace_organizations.sql'
  ),
  'utf8'
);

describe('migration 0054: workspace organizations', () => {
  it('adds the organization columns to the baseline', async () => {
    const fixture = await openFixture('pre-0054');
    try {
      const columns = (
        fixture.sqlite.prepare(`PRAGMA table_info(workspaces)`).all() as { name: string }[]
      ).map((c) => c.name);
      expect(columns).toEqual(
        expect.arrayContaining(['organization_id', 'organization_name', 'organization_role'])
      );
    } finally {
      fixture.close();
    }
  });

  it('leaves existing workspaces in no organization, as they were', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          tenant_id TEXT,
          role TEXT
        );
        INSERT INTO workspaces (id, name, tenant_id, role) VALUES ('ws-1', 'Default', 't-1', 'owner');
      `);
      for (const statement of MIGRATION_SQL.split('--> statement-breakpoint')) db.exec(statement);

      expect(
        db
          .prepare(
            'SELECT id, tenant_id, role, organization_id, organization_name, organization_role FROM workspaces'
          )
          .all()
      ).toEqual([
        {
          id: 'ws-1',
          tenant_id: 't-1',
          role: 'owner',
          organization_id: null,
          organization_name: null,
          organization_role: null,
        },
      ]);
    } finally {
      db.close();
    }
  });
});
