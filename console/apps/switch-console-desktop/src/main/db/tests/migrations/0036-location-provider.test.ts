/**
 * Migration 0036 — renames the base location setting `workspaceProvider` to
 * `locationProvider` (CHOO-1426). The value lives inside the
 * `location_settings.base_settings_json` blob (not a column), so the migration
 * rewrites persisted blobs rather than altering DDL.
 *
 * openFixture('empty') already applied 0036 over an empty dataset (a no-op), so
 * this test seeds representative pre-0036 blobs and re-applies the committed
 * migration SQL to assert the transform: the nested object moves to the new key
 * unchanged, and rows without the old key are untouched.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';

const MIGRATION_SQL = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../drizzle/0036_rename_workspace_provider_setting.sql'
  ),
  'utf8'
);

const PROVIDER = { type: 'script', provisionCommand: 'up', terminateCommand: 'down' };

describe('migration 0036: workspaceProvider -> locationProvider', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  function seedLocation(id: string, baseSettings: Record<string, unknown>) {
    fixture.sqlite
      .prepare(`INSERT INTO locations (id, name, ssh_host, dir) VALUES (?, ?, '', ?)`)
      .run(id, id, `/tmp/${id}`);
    fixture.sqlite
      .prepare(`INSERT INTO location_settings (location_id, base_settings_json) VALUES (?, ?)`)
      .run(id, JSON.stringify(baseSettings));
  }

  function baseSettings(id: string): Record<string, unknown> {
    const [row] = fixture.sqlite
      .prepare(`SELECT base_settings_json AS json FROM location_settings WHERE location_id = ?`)
      .all(id) as { json: string }[];
    return JSON.parse(row.json);
  }

  it('moves the provider object to locationProvider and drops the old key', async () => {
    fixture = await openFixture('empty');
    seedLocation('with-provider', { tmux: true, workspaceProvider: PROVIDER });
    seedLocation('no-provider', { tmux: false });
    seedLocation('empty', {});

    fixture.sqlite.exec(MIGRATION_SQL);

    expect(baseSettings('with-provider')).toEqual({ tmux: true, locationProvider: PROVIDER });
    expect(baseSettings('no-provider')).toEqual({ tmux: false });
    expect(baseSettings('empty')).toEqual({});
  });
});
