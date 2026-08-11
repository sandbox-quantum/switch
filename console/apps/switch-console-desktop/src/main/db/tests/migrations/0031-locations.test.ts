/**
 * Migrations 0031–0034 — collapse projects + per-agent connection into
 * first-class locations (CHOO-1426). 0031 adds `locations`/`location_settings`
 * and a nullable `agents.location_id`; 0032 backfills them from
 * `projects` + `agents.connection`/`remote_config_json`; 0033 drops the
 * projects tables and old agent columns; 0034 recreates `agents` to enforce
 * NOT NULL on `location_id`.
 *
 * The pre-0031 fixture holds two local projects (with local agents) and one
 * remote project (path NULL, agent connection='remote' with
 * remote_config_json {sshHost: build-vm, remoteRepoDir: /srv/agents/remote-worker}).
 */

import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { agents, locations, locationSettings } from '@main/db/schema';

describe('migrations 0031-0034: first-class locations', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('creates one location per project, lifting host+dir from remote agents', async () => {
    fixture = await openFixture('pre-0031');

    const rows = await fixture.db.select().from(locations);
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(rows).toHaveLength(3);
    expect(byId.get('11111111-1111-1111-1111-111111111111')).toMatchObject({
      name: 'emdash',
      sshHost: '',
      dir: '/home/dev/projects/emdash',
    });
    expect(byId.get('22222222-2222-2222-2222-222222222222')).toMatchObject({
      name: 'my-api',
      sshHost: '',
      dir: '/home/dev/projects/my-api',
    });
    expect(byId.get('33333333-3333-3333-3333-333333333333')).toMatchObject({
      name: 'remote-worker',
      sshHost: 'build-vm',
      dir: '/srv/agents/remote-worker',
    });
  });

  it('re-points agents at their location and drops the old columns', async () => {
    fixture = await openFixture('pre-0031');

    const rows = await fixture.db.select().from(agents);
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(rows).toHaveLength(3);
    expect(byId.get('a9e70001-0000-0000-0000-000000000000')!.locationId).toBe(
      '11111111-1111-1111-1111-111111111111'
    );
    expect(byId.get('a9e70002-0000-0000-0000-000000000000')!.locationId).toBe(
      '22222222-2222-2222-2222-222222222222'
    );
    expect(byId.get('a9e70003-0000-0000-0000-000000000000')!.locationId).toBe(
      '33333333-3333-3333-3333-333333333333'
    );

    const columns = fixture.sqlite.prepare(`PRAGMA table_info('agents')`).all() as {
      name: string;
      notnull: number;
    }[];
    const names = columns.map((c) => c.name);
    expect(names).not.toContain('project_id');
    expect(names).not.toContain('connection');
    expect(names).not.toContain('remote_config_json');
    expect(columns.find((c) => c.name === 'location_id')!.notnull).toBe(1);
  });

  it('moves project_settings to location_settings and drops the projects tables', async () => {
    fixture = await openFixture('pre-0031');

    const settings = await fixture.db.select().from(locationSettings);
    const settingsIds = settings.map((s) => s.locationId).sort();
    expect(settingsIds).toEqual([
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    ]);

    const tables = fixture.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).not.toContain('projects');
    expect(tableNames).not.toContain('project_settings');
    expect(tableNames).toContain('locations');
    expect(tableNames).toContain('location_settings');
  });

  it('enforces (ssh_host, dir) uniqueness on locations', async () => {
    fixture = await openFixture('pre-0031');

    await expect(
      fixture.db
        .insert(locations)
        .values([{ id: 'dupe', name: 'dupe', sshHost: '', dir: '/home/dev/projects/my-api' }])
    ).rejects.toThrow(/UNIQUE/i);
  });
});
