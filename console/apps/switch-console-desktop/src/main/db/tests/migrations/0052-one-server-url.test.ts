/**
 * Migration 0052 — one address per server.
 *
 * Every saved server keeps its API address as its one address, because that is
 * what its agents, controllers and sidecars already point at. The gateway
 * address is kept, as the dashboard address, only where it differed. Nothing
 * else about a server may change: its id is what workspaces, agents, saved
 * sign-ins and view state are keyed by.
 *
 * Runs the real migration runner over `pre-0052.db`: the baseline fixture at
 * 0051 with one saved server of every shape the upgrade meets, each with its
 * workspace, and agents attached to two of them.
 */

import { openFixture, type FixtureDb } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type ServerRow = {
  id: string;
  name: string;
  url: string;
  dashboard_url: string | null;
  managed: number;
  management_kind: string | null;
  ssh_host: string | null;
};

describe('migration 0052: one server url', () => {
  let fixture: FixtureDb;

  beforeEach(async () => {
    fixture = await openFixture('pre-0052');
  });

  afterEach(() => {
    fixture.close();
  });

  function server(id: string): ServerRow {
    const row = fixture.sqlite
      .prepare(
        `SELECT id, name, url, dashboard_url, managed, management_kind, ssh_host
           FROM switch_servers WHERE id = ?`
      )
      .get(id) as ServerRow | undefined;
    if (!row) throw new Error(`no server ${id}`);
    return row;
  }

  it('leaves one address column and an optional dashboard column', () => {
    const columns = fixture.sqlite.prepare('PRAGMA table_info(switch_servers)').all() as {
      name: string;
      notnull: number;
    }[];
    const byName = new Map(columns.map((column) => [column.name, column]));
    expect(byName.has('gateway_url')).toBe(false);
    expect(byName.has('api_url')).toBe(false);
    expect(byName.get('url')?.notnull).toBe(1);
    expect(byName.get('dashboard_url')?.notnull).toBe(0);
  });

  it('keeps the API address of a split server and its gateway as the dashboard', () => {
    expect(server('5e000001-0000-0000-0000-000000000000')).toMatchObject({
      name: 'Split',
      url: 'https://switch-api.example.com',
      dashboard_url: 'https://switch-gateway.example.com',
    });
  });

  it('keeps no dashboard address for a server registered with one address', () => {
    expect(server('5e000002-0000-0000-0000-000000000000')).toMatchObject({
      url: 'https://switch.example.com',
      dashboard_url: null,
    });
  });

  it('treats the same address written in a different case or with a slash as one', () => {
    expect(server('5e000003-0000-0000-0000-000000000000')).toMatchObject({
      url: 'https://mixed.example.com',
      dashboard_url: null,
    });
  });

  it('moves managed servers onto their API port and keeps the dashboard port', () => {
    expect(server('5e000004-0000-0000-0000-000000000000')).toMatchObject({
      url: 'http://localhost:8010',
      dashboard_url: 'http://localhost:3010',
      managed: 1,
      management_kind: 'local',
      ssh_host: null,
    });
    expect(server('5e000005-0000-0000-0000-000000000000')).toMatchObject({
      url: 'http://localhost:8011',
      dashboard_url: 'http://localhost:3011',
      managed: 1,
      management_kind: null,
    });
    expect(server('5e000006-0000-0000-0000-000000000000')).toMatchObject({
      url: 'http://localhost:8020',
      dashboard_url: 'http://localhost:3020',
      managed: 1,
      management_kind: 'remote',
      ssh_host: 'build-box',
    });
  });

  it('keeps both servers that already shared an API address', () => {
    // The gateway address was the unique one; two rows on one API address must
    // both survive the upgrade rather than stop the app from starting.
    expect(server('5e000007-0000-0000-0000-000000000000')).toMatchObject({
      url: 'https://twice.example.com',
      dashboard_url: 'https://gateway-a.example.com',
    });
    expect(server('5e000008-0000-0000-0000-000000000000')).toMatchObject({
      url: 'https://twice.example.com',
      dashboard_url: 'https://gateway-b.example.com',
    });
  });

  it('keeps every server, workspace and agent attached', () => {
    const count = (table: string) =>
      (fixture.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count('switch_servers')).toBe(8);
    expect(count('workspaces')).toBe(8);
    const agents = fixture.sqlite
      .prepare(`SELECT id, workspace_id, api_endpoint FROM agents ORDER BY id`)
      .all();
    expect(agents).toEqual([
      {
        id: 'a9e70001-0000-0000-0000-000000000000',
        workspace_id: '5e000001-0000-0000-0000-000000000000',
        api_endpoint: 'https://switch-api.example.com',
      },
      {
        id: 'a9e70002-0000-0000-0000-000000000000',
        workspace_id: null,
        api_endpoint: 'https://switch.example.com',
      },
      {
        id: 'a9e70003-0000-0000-0000-000000000000',
        workspace_id: '5e000006-0000-0000-0000-000000000000',
        api_endpoint: 'http://localhost:8020',
      },
    ]);
    expect(fixture.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('leaves no index on the server addresses', () => {
    const indexes = fixture.sqlite.prepare('PRAGMA index_list(switch_servers)').all() as {
      name: string;
      origin: string;
    }[];
    // The primary key's own index is the only one left.
    expect(indexes.filter((index) => index.origin === 'c')).toEqual([]);
  });

  it('reads every row through the schema', async () => {
    const { switchServers } = await import('@main/db/schema');
    const rows = fixture.db.select().from(switchServers).all();
    expect(rows).toHaveLength(8);
    expect(rows.find((row) => row.name === 'Split')).toMatchObject({
      url: 'https://switch-api.example.com',
      dashboardUrl: 'https://switch-gateway.example.com',
    });
  });
});
