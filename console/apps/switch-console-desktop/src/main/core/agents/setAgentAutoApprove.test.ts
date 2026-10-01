import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const agentRow = vi.hoisted(() => ({
  current: { id: 'agent-1', switchAgentId: 'sw-1', autoApprove: false } as
    | { id: string; switchAgentId: string | null; autoApprove: boolean }
    | undefined,
}));
const updateAgent = vi.hoisted(() =>
  vi.fn(async ({ agentId, autoApprove }: { agentId: string; autoApprove: boolean }) => {
    calls.push(`row ${autoApprove}`);
    return { id: agentId, autoApprove };
  })
);
const getRemoteAgentLocation = vi.hoisted(() => vi.fn());
const listStoppedControllerAgentIds = vi.hoisted(() => vi.fn(async (): Promise<string[]> => []));
const pushRemoteAutoApprove = vi.hoisted(() =>
  vi.fn(async (_id: string) => void calls.push('push'))
);
const recordAutoApproveOnHost = vi.hoisted(() =>
  vi.fn(async (_id: string, autoApprove: boolean) => void calls.push(`host ${autoApprove}`))
);

const keepAutoApproveChoice = vi.hoisted(() =>
  vi.fn(async (_id: string, autoApprove: boolean) => void calls.push(`choice ${autoApprove}`))
);
vi.mock('./getAgentById', () => ({ getAgentById: async () => agentRow.current }));
vi.mock('./updateAgent', () => ({ updateAgent }));
vi.mock('./agent-location', () => ({ getRemoteAgentLocation }));
vi.mock('@main/core/switch-rooms/auto-session-store', () => ({
  listStoppedControllerAgentIds,
}));
vi.mock('./remote-watcher', () => ({ pushRemoteAutoApprove }));
vi.mock('@main/core/sdk-host/shared-watcher', () => ({
  keepAutoApproveChoice,
  recordAutoApproveOnHost,
}));

import { setAgentAutoApprove } from './setAgentAutoApprove';

describe('setAgentAutoApprove', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    agentRow.current = { id: 'agent-1', switchAgentId: 'sw-1', autoApprove: false };
    getRemoteAgentLocation.mockResolvedValue({ id: 'loc-1' });
    listStoppedControllerAgentIds.mockResolvedValue([]);
  });

  it('writes the row and nothing else for a local agent (read fresh at spawn)', async () => {
    getRemoteAgentLocation.mockResolvedValue(null);

    await setAgentAutoApprove({ agentId: 'agent-1', enabled: true });

    expect(calls).toEqual(['row true']);
  });

  it('keeps the choice on the host, then the row, then rewrites a watcher that starts sessions', async () => {
    // The choice first, so a racing watcher write takes the new value instead
    // of putting the old one back.

    await setAgentAutoApprove({ agentId: 'agent-1', enabled: true });

    expect(calls).toEqual(['choice true', 'row true', 'push']);
  });

  it('says the watcher lags when the push does not reach the host, keeping the saved choice', async () => {
    // The host's choice already holds the new value; rolling the row back
    // would let the next watcher write silently undo it.
    pushRemoteAutoApprove.mockRejectedValueOnce(new Error('host unreachable'));

    await expect(setAgentAutoApprove({ agentId: 'agent-1', enabled: true })).rejects.toThrow(
      /saved, but the agent's watcher on its host could not be updated yet \(host unreachable\)/
    );

    expect(calls).toEqual(['choice true', 'row true']);
    expect(pushRemoteAutoApprove).toHaveBeenCalledOnce();
  });

  it('changes nothing when the host could not take the choice', async () => {
    keepAutoApproveChoice.mockRejectedValueOnce(new Error('host unreachable'));

    await expect(setAgentAutoApprove({ agentId: 'agent-1', enabled: true })).rejects.toThrow(
      /host unreachable/
    );

    expect(updateAgent).not.toHaveBeenCalled();
    expect(pushRemoteAutoApprove).not.toHaveBeenCalled();
  });

  it('writes only the row for an agent with no Switch identity, which has no watcher yet', async () => {
    agentRow.current = { id: 'agent-1', switchAgentId: null, autoApprove: false };

    await setAgentAutoApprove({ agentId: 'agent-1', enabled: true });

    expect(calls).toEqual(['row true']);
  });

  it('keeps the choice on the host for a stopped watcher, which nothing rewrites until it starts', async () => {
    listStoppedControllerAgentIds.mockResolvedValue(['agent-1']);

    await setAgentAutoApprove({ agentId: 'agent-1', enabled: true });

    expect(calls).toEqual(['host true', 'row true']);
    expect(pushRemoteAutoApprove).not.toHaveBeenCalled();
  });

  it('leaves the row alone when the host could not keep the choice', async () => {
    listStoppedControllerAgentIds.mockResolvedValue(['agent-1']);
    recordAutoApproveOnHost.mockRejectedValueOnce(new Error('host unreachable'));

    await expect(setAgentAutoApprove({ agentId: 'agent-1', enabled: true })).rejects.toThrow(
      /host unreachable/
    );

    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('says so when the agent is deleted while the change is being made', async () => {
    getRemoteAgentLocation.mockResolvedValue(null);
    updateAgent.mockResolvedValueOnce(undefined as never);

    await expect(setAgentAutoApprove({ agentId: 'agent-1', enabled: true })).rejects.toThrow(
      /No agent with id agent-1/
    );
  });

  it('says why the watcher lags when the push failed with something other than an Error', async () => {
    pushRemoteAutoApprove.mockRejectedValueOnce('ssh closed');

    await expect(setAgentAutoApprove({ agentId: 'agent-1', enabled: true })).rejects.toThrow(
      /could not be updated yet \(ssh closed\)/
    );
  });

  it('throws when the agent does not exist', async () => {
    agentRow.current = undefined;

    await expect(setAgentAutoApprove({ agentId: 'ghost', enabled: true })).rejects.toThrow(
      /No agent with id ghost/
    );
  });
});
