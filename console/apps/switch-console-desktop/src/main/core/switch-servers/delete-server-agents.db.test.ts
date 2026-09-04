import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { agents, locations, switchServers } from '@main/db/schema';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  deleteAgent: vi.fn(async (_agentId: string, _options: { deleteInSwitch: boolean }) => {}),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

// The real deleteAgent tears down runtimes, watchers, sidecars and on-disk
// files; this suite is about *which* agents it is asked to delete, and with
// what options.
vi.mock('@main/core/agents/deleteAgent', () => ({
  deleteAgent: mocks.deleteAgent,
}));

const { deleteAgentsForServer } = await import('./delete-server-agents');

describe('deleteAgentsForServer', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.deleteAgent.mockReset();
    mocks.deleteAgent.mockResolvedValue(undefined);

    await fixture.db
      .insert(locations)
      .values({ id: 'loc-1', name: 'repo', sshHost: '', dir: '/tmp/repo' });
    for (const id of ['managed-1', 'other-1']) {
      await fixture.db.insert(switchServers).values({
        id,
        name: id,
        gatewayUrl: `https://${id}.example.com`,
        apiUrl: `https://api-${id}.example.com`,
      });
    }
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  async function seedAgent(id: string, serverId: string | null): Promise<void> {
    await fixture.db
      .insert(agents)
      .values({ id, locationId: 'loc-1', name: id, providerId: 'claude', serverId });
  }

  it('deletes only the agents belonging to the given server', async () => {
    await seedAgent('agent-a', 'managed-1');
    await seedAgent('agent-b', 'managed-1');
    await seedAgent('agent-other', 'other-1');
    await seedAgent('agent-unlinked', null);

    const result = await deleteAgentsForServer('managed-1');

    expect(result.deleted.sort()).toEqual(['agent-a', 'agent-b']);
    expect(mocks.deleteAgent.mock.calls.map(([agentId]) => agentId).sort()).toEqual([
      'agent-a',
      'agent-b',
    ]);
  });

  // The stack's own records are about to be destroyed wholesale, and the
  // gateway call would be made against a server that is going away.
  it('does not ask the gateway to delete each agent', async () => {
    await seedAgent('agent-a', 'managed-1');

    await deleteAgentsForServer('managed-1');

    expect(mocks.deleteAgent).toHaveBeenCalledWith('agent-a', {
      deleteInSwitch: false,
      removeProvisionedFiles: true,
      // Wiping a server is one action, not a person deleting each agent.
      trigger: 'server_teardown',
    });
  });

  it('reports a failed agent instead of stranding the rest', async () => {
    await seedAgent('agent-a', 'managed-1');
    await seedAgent('agent-b', 'managed-1');
    mocks.deleteAgent.mockImplementation(async (agentId: string) => {
      if (agentId === 'agent-a') throw new Error('pty teardown exploded');
    });

    const result = await deleteAgentsForServer('managed-1');

    expect(result.failed).toEqual([{ agentId: 'agent-a', error: 'Error: pty teardown exploded' }]);
    expect(result.deleted).toEqual(['agent-b']);
  });

  it('is a no-op for a server with no agents', async () => {
    await seedAgent('agent-other', 'other-1');

    const result = await deleteAgentsForServer('managed-1');

    expect(result).toEqual({ deleted: [], failed: [] });
    expect(mocks.deleteAgent).not.toHaveBeenCalled();
  });

  it('leaves other servers’ agent rows in place', async () => {
    await seedAgent('agent-a', 'managed-1');
    await seedAgent('agent-other', 'other-1');

    await deleteAgentsForServer('managed-1');

    const remaining = await fixture.db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.serverId, 'other-1'));
    expect(remaining).toEqual([{ id: 'agent-other' }]);
  });
});
