import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { agents, locations } from '@main/db/schema';
import { deleteLocationIfUnused, deleteUnusedLocations, getLocationById } from './store';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

describe('deleteLocationIfUnused', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    await fixture.db.insert(locations).values([
      { id: 'shared', name: 'shared', sshHost: 'example-host', dir: '/srv/shared' },
      { id: 'empty', name: 'empty', sshHost: 'example-host', dir: '/srv/empty' },
    ]);
    await fixture.db
      .insert(agents)
      .values({ id: 'agent-1', locationId: 'shared', name: 'agent-1', providerId: 'claude' });
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('deletes a location once its last agent is gone', async () => {
    await deleteLocationIfUnused('empty');
    expect(await getLocationById('empty')).toBeUndefined();
  });

  it('keeps a location another agent still uses', async () => {
    await deleteLocationIfUnused('shared');
    expect(await getLocationById('shared')).toBeDefined();
  });

  it('deletes every agentless location at once and keeps the ones in use', async () => {
    await deleteUnusedLocations();
    expect(await getLocationById('empty')).toBeUndefined();
    expect(await getLocationById('shared')).toBeDefined();
  });
});
