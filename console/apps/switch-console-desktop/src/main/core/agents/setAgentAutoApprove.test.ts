import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const agentRow = vi.hoisted(() => ({
  current: { id: 'agent-1', autoApprove: false } as
    | { id: string; autoApprove: boolean }
    | undefined,
}));
const updateAgent = vi.hoisted(() =>
  vi.fn(async ({ agentId, autoApprove }: { agentId: string; autoApprove: boolean }) => {
    calls.push(`row ${autoApprove}`);
    return { id: agentId, autoApprove };
  })
);
const getRemoteAgentLocation = vi.hoisted(() => vi.fn());
const listAutoSessionAgentIds = vi.hoisted(() => vi.fn(async (): Promise<string[]> => []));
const listStoppedControllerAgentIds = vi.hoisted(() => vi.fn(async (): Promise<string[]> => []));
const pushRemoteAutoApprove = vi.hoisted(() =>
  vi.fn(async (_id: string) => void calls.push('push'))
);
const recordAutoApproveOnHost = vi.hoisted(() =>
  vi.fn(async (_id: string, autoApprove: boolean) => void calls.push(`host ${autoApprove}`))
);

vi.mock('./getAgentById', () => ({ getAgentById: async () => agentRow.current }));
vi.mock('./updateAgent', () => ({ updateAgent }));
vi.mock('./agent-location', () => ({ getRemoteAgentLocation }));
vi.mock('@main/core/switch-rooms/auto-session-store', () => ({
  listAutoSessionAgentIds,
  listStoppedControllerAgentIds,
}));
vi.mock('./remote-watcher', () => ({ pushRemoteAutoApprove }));
vi.mock('@main/core/sdk-host/shared-watcher', () => ({ recordAutoApproveOnHost }));

import { setAgentAutoApprove } from './setAgentAutoApprove';

describe('setAgentAutoApprove', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    agentRow.current = { id: 'agent-1', autoApprove: false };
    getRemoteAgentLocation.mockResolvedValue({ id: 'loc-1' });
    listAutoSessionAgentIds.mockResolvedValue([]);
    listStoppedControllerAgentIds.mockResolvedValue([]);
  });

  it('writes the row and nothing else for a local agent (read fresh at spawn)', async () => {
    getRemoteAgentLocation.mockResolvedValue(null);

    await setAgentAutoApprove({ agentId: 'agent-1', enabled: true });

    expect(calls).toEqual(['row true']);
  });

  it('pushes this Console’s value to a watcher that starts sessions, the row first', async () => {
    // The push writes the watcher from the row.
    listAutoSessionAgentIds.mockResolvedValue(['agent-1']);

    await setAgentAutoApprove({ agentId: 'agent-1', enabled: true });

    expect(calls).toEqual(['row true', 'push']);
  });

  it('puts the row back when the push does not reach the host', async () => {
    // Left changed, the next watcher write would revert it from the host with
    // only a log line to say so.
    listAutoSessionAgentIds.mockResolvedValue(['agent-1']);
    pushRemoteAutoApprove.mockRejectedValueOnce(new Error('host unreachable'));

    await expect(setAgentAutoApprove({ agentId: 'agent-1', enabled: true })).rejects.toThrow(
      /host unreachable/
    );

    expect(calls).toEqual(['row true', 'row false']);
  });

  it('keeps the choice on the host first for a watcher that starts no sessions', async () => {
    await setAgentAutoApprove({ agentId: 'agent-1', enabled: true });

    expect(recordAutoApproveOnHost).toHaveBeenCalledWith('agent-1', true);
    expect(calls).toEqual(['host true', 'row true']);
  });

  it('keeps the choice on the host for a stopped watcher, which nothing rewrites until it starts', async () => {
    listAutoSessionAgentIds.mockResolvedValue(['agent-1']);
    listStoppedControllerAgentIds.mockResolvedValue(['agent-1']);

    await setAgentAutoApprove({ agentId: 'agent-1', enabled: true });

    expect(calls).toEqual(['host true', 'row true']);
    expect(pushRemoteAutoApprove).not.toHaveBeenCalled();
  });

  it('leaves the row alone when the host could not keep the choice', async () => {
    recordAutoApproveOnHost.mockRejectedValueOnce(new Error('host unreachable'));

    await expect(setAgentAutoApprove({ agentId: 'agent-1', enabled: true })).rejects.toThrow(
      /host unreachable/
    );

    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('throws when the agent does not exist', async () => {
    agentRow.current = undefined;

    await expect(setAgentAutoApprove({ agentId: 'ghost', enabled: true })).rejects.toThrow(
      /No agent with id ghost/
    );
  });
});
