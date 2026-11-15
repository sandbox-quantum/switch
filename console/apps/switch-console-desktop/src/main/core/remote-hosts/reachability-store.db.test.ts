import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import {
  agents,
  locations,
  remoteHosts,
  remoteHostSetupPlans,
  switchServers,
} from '@main/db/schema';
import { listSshHostsInUse } from './reachability-store';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

describe('listSshHostsInUse', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('counts onboarded, mid-setup, server and agent hosts, not an agentless location', async () => {
    await fixture.db.insert(remoteHosts).values({ sshHost: 'example-onboarded', name: 'x' });
    await fixture.db.insert(remoteHostSetupPlans).values({ sshHost: 'example-setup', steps: '[]' });
    await fixture.db.insert(switchServers).values([
      { id: 'srv', name: 'srv', url: 'https://srv.example.com', sshHost: 'example-server' },
      { id: 'ext', name: 'ext', url: 'https://ext.example.com' },
    ]);
    await fixture.db.insert(locations).values([
      { id: 'used', name: 'used', sshHost: 'example-agent', dir: '/srv/a' },
      { id: 'orphan', name: 'orphan', sshHost: 'example-orphan', dir: '/srv/b' },
      { id: 'local', name: 'local', sshHost: '', dir: '/tmp/local' },
    ]);
    await fixture.db.insert(agents).values([
      { id: 'a1', locationId: 'used', name: 'a1', providerId: 'claude' },
      { id: 'a2', locationId: 'local', name: 'a2', providerId: 'claude' },
    ]);

    expect([...(await listSshHostsInUse())].sort()).toEqual([
      'example-agent',
      'example-onboarded',
      'example-server',
      'example-setup',
    ]);
  });
});
