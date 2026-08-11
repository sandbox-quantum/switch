import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { getSessions } from './getSessions';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

describe('getSessions', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;

    fixture.sqlite
      .prepare(
        `INSERT INTO locations (id, name, ssh_host, dir, created_at, updated_at)
         VALUES ('loc-1', 'Location', '', '/repo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .run();

    fixture.sqlite
      .prepare(
        `INSERT INTO agents (id, location_id, name, provider_id, created_at, updated_at)
         VALUES ('agent-1', 'loc-1', 'Agent', 'claude', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .run();
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('loads sessions from the database', async () => {
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (
           id,
           agent_id,
           title,
           status,
           created_at,
           updated_at,
           status_changed_at
         )
         VALUES (
           'session-1',
           'agent-1',
           'My Session',
           'in_progress',
           CURRENT_TIMESTAMP,
           CURRENT_TIMESTAMP,
           CURRENT_TIMESTAMP
         )`
      )
      .run();

    const rows = await getSessions('loc-1');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('My Session');
    expect(rows[0]!.id).toBe('session-1');
  });
});
