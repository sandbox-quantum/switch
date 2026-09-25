import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateAgent = vi.fn(
  async ({ agentId, autoApprove }): Promise<{ id: string; autoApprove?: boolean } | undefined> => ({
    id: agentId,
    autoApprove,
  })
);
const getRemoteAgentLocation = vi.fn();
const listAutoSessionAgentIds = vi.fn();
const listStoppedControllerAgentIds = vi.fn(async (): Promise<string[]> => []);
const pushRemoteAutoApprove = vi.fn(async (_id: string) => {});
const recordAutoApproveOnHost = vi.fn(async (_id: string) => {});

vi.mock('./updateAgent', () => ({ updateAgent: (p: unknown) => updateAgent(p) }));
vi.mock('./getAgentById', () => ({
  getAgentById: async (id: string) => ({ id, locationId: 'loc' }),
}));
vi.mock('./observed-guard', () => ({
  // Every agent in these cases is one this Console runs (CHOO-2893).
  locationWhereAgentRuns: async () => ({ sshHost: 'host', dir: '/work', observed: false }),
}));
vi.mock('./agent-location', () => ({
  getRemoteAgentLocation: (a: unknown) => getRemoteAgentLocation(a),
}));
vi.mock('@main/core/switch-rooms/auto-session-store', () => ({
  listAutoSessionAgentIds: () => listAutoSessionAgentIds(),
  listStoppedControllerAgentIds: () => listStoppedControllerAgentIds(),
}));
vi.mock('./remote-watcher', () => ({
  pushRemoteAutoApprove: (id: string) => pushRemoteAutoApprove(id),
}));
vi.mock('@main/core/sdk-host/shared-watcher', () => ({
  recordAutoApproveOnHost: (id: string) => recordAutoApproveOnHost(id),
}));

import { setAgentAutoApprove } from './setAgentAutoApprove';

describe('setAgentAutoApprove', () => {
  beforeEach(() => {
    updateAgent.mockClear();
    getRemoteAgentLocation.mockReset();
    listAutoSessionAgentIds.mockReset();
    listStoppedControllerAgentIds.mockReset();
    listStoppedControllerAgentIds.mockResolvedValue([]);
    pushRemoteAutoApprove.mockClear();
    recordAutoApproveOnHost.mockClear();
  });

  it('writes the agent row and does not touch a local agent (read fresh at spawn)', async () => {
    getRemoteAgentLocation.mockResolvedValue(null);

    await setAgentAutoApprove({ agentId: 'agent-1', enabled: true });

    expect(updateAgent).toHaveBeenCalledWith({ agentId: 'agent-1', autoApprove: true });
    expect(pushRemoteAutoApprove).not.toHaveBeenCalled();
    expect(recordAutoApproveOnHost).not.toHaveBeenCalled();
  });

  it('pushes this Console’s value to a remote agent whose watcher is running (auto_session on)', async () => {
    getRemoteAgentLocation.mockResolvedValue({ id: 'loc-1' });
    listAutoSessionAgentIds.mockResolvedValue(['agent-1']);

    await setAgentAutoApprove({ agentId: 'agent-1', enabled: false });

    // Pushed, not re-ensured: a re-ensure takes the host's value, which is the
    // one the person just changed.
    expect(pushRemoteAutoApprove).toHaveBeenCalledWith('agent-1');
    expect(recordAutoApproveOnHost).not.toHaveBeenCalled();
  });

  it('records the value on the host for a remote agent with auto_session off', async () => {
    // Nothing is running to refresh, but the saved spec is what the next
    // watcher — this Console's or another's — takes its setting from.
    getRemoteAgentLocation.mockResolvedValue({ id: 'loc-1' });
    listAutoSessionAgentIds.mockResolvedValue([]);

    await setAgentAutoApprove({ agentId: 'agent-1', enabled: true });

    expect(recordAutoApproveOnHost).toHaveBeenCalledWith('agent-1');
    expect(pushRemoteAutoApprove).not.toHaveBeenCalled();
  });

  it('records the value on the host for a stopped watcher, which nothing rewrites until it starts', async () => {
    // Pushing goes through the watcher's own write, which a stopped one skips —
    // and its next start takes the host's value, so a value left only in this
    // row would be put back.
    getRemoteAgentLocation.mockResolvedValue({ id: 'loc-1' });
    listAutoSessionAgentIds.mockResolvedValue(['agent-1']);
    listStoppedControllerAgentIds.mockResolvedValue(['agent-1']);

    await setAgentAutoApprove({ agentId: 'agent-1', enabled: true });

    expect(recordAutoApproveOnHost).toHaveBeenCalledWith('agent-1');
    expect(pushRemoteAutoApprove).not.toHaveBeenCalled();
  });

  it('throws when the agent does not exist', async () => {
    updateAgent.mockResolvedValueOnce(undefined);

    await expect(setAgentAutoApprove({ agentId: 'ghost', enabled: true })).rejects.toThrow(
      /No agent with id ghost/
    );
  });
});
