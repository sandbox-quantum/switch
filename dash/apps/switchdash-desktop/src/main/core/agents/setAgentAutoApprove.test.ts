import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateAgent = vi.fn(
  async ({ agentId, autoApprove }): Promise<{ id: string; autoApprove?: boolean } | undefined> => ({
    id: agentId,
    autoApprove,
  })
);
const getRemoteAgentLocation = vi.fn();
const listAutoSessionAgentIds = vi.fn();
const ensureRemoteWatcher = vi.fn(async (_id: string) => {});

vi.mock('./updateAgent', () => ({ updateAgent: (p: unknown) => updateAgent(p) }));
vi.mock('./agent-location', () => ({
  getRemoteAgentLocation: (a: unknown) => getRemoteAgentLocation(a),
}));
vi.mock('@main/core/switch-rooms/auto-session-store', () => ({
  listAutoSessionAgentIds: () => listAutoSessionAgentIds(),
}));
vi.mock('./remote-watcher', () => ({
  ensureRemoteWatcher: (id: string) => ensureRemoteWatcher(id),
}));

import { setAgentAutoApprove } from './setAgentAutoApprove';

describe('setAgentAutoApprove', () => {
  beforeEach(() => {
    updateAgent.mockClear();
    getRemoteAgentLocation.mockReset();
    listAutoSessionAgentIds.mockReset();
    ensureRemoteWatcher.mockClear();
  });

  it('writes the agent row and does not touch a local agent (read fresh at spawn)', async () => {
    getRemoteAgentLocation.mockResolvedValue(null);

    await setAgentAutoApprove({ agentId: 'agent-1', enabled: true });

    expect(updateAgent).toHaveBeenCalledWith({ agentId: 'agent-1', autoApprove: true });
    expect(ensureRemoteWatcher).not.toHaveBeenCalled();
  });

  it('re-pushes the spec to a remote agent whose watcher is running (auto_session on)', async () => {
    getRemoteAgentLocation.mockResolvedValue({ id: 'loc-1' });
    listAutoSessionAgentIds.mockResolvedValue(['agent-1']);

    await setAgentAutoApprove({ agentId: 'agent-1', enabled: false });

    expect(ensureRemoteWatcher).toHaveBeenCalledWith('agent-1');
  });

  it('skips the re-push for a remote agent with auto_session off (nothing running to refresh)', async () => {
    getRemoteAgentLocation.mockResolvedValue({ id: 'loc-1' });
    listAutoSessionAgentIds.mockResolvedValue([]);

    await setAgentAutoApprove({ agentId: 'agent-1', enabled: true });

    expect(ensureRemoteWatcher).not.toHaveBeenCalled();
  });

  it('throws when the agent does not exist', async () => {
    updateAgent.mockResolvedValueOnce(undefined);

    await expect(setAgentAutoApprove({ agentId: 'ghost', enabled: true })).rejects.toThrow(
      /No agent with id ghost/
    );
  });
});
