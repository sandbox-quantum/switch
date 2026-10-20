import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = { id: string; switchAgentId: string | null; autoApprove: boolean; autoMode: boolean };

const calls = vi.hoisted(() => [] as string[]);
const agentRow = vi.hoisted(() => ({ current: undefined as Row | undefined }));
const updateAgent = vi.hoisted(() =>
  vi.fn(async (params: { agentId: string; autoApprove?: boolean; autoMode?: boolean }) => {
    const { agentId, ...change } = params;
    calls.push(`row ${JSON.stringify(change)}`);
    return { id: agentId, ...change };
  })
);
const getRemoteAgentLocation = vi.hoisted(() => vi.fn());
const listStoppedControllerAgentIds = vi.hoisted(() => vi.fn(async (): Promise<string[]> => []));
const pushRemotePermissions = vi.hoisted(() =>
  vi.fn(async (_id: string) => void calls.push('push'))
);
const recordRuntimeModeOnHost = vi.hoisted(() =>
  vi.fn(async (_id: string, mode: string) => void calls.push(`host ${mode}`))
);
const keepRuntimeModeChoice = vi.hoisted(() =>
  vi.fn(async (_id: string, mode: string) => void calls.push(`choice ${mode}`))
);
const refreshLocalWatcher = vi.hoisted(() =>
  vi.fn(async (_id: string) => void calls.push('refresh'))
);
vi.mock('./getAgentById', () => ({ getAgentById: async () => agentRow.current }));
vi.mock('./updateAgent', () => ({ updateAgent }));
vi.mock('./agent-location', () => ({ getRemoteAgentLocation }));
vi.mock('@main/core/switch-rooms/auto-session-store', () => ({
  listStoppedControllerAgentIds,
}));
vi.mock('./remote-watcher', () => ({ pushRemotePermissions, refreshLocalWatcher }));
vi.mock('@main/core/sdk-host/agent-host', () => ({
  keepRuntimeModeChoice,
  recordRuntimeModeOnHost,
}));

import { setAgentPermission } from './setAgentPermission';

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'agent-1',
    switchAgentId: 'sw-1',
    autoApprove: false,
    autoMode: false,
    ...overrides,
  };
}

const bypassOn = { agentId: 'agent-1', setting: 'autoApprove', enabled: true } as const;

describe('setAgentPermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    agentRow.current = row();
    getRemoteAgentLocation.mockResolvedValue({ id: 'loc-1' });
    listStoppedControllerAgentIds.mockResolvedValue([]);
  });

  it('writes the row for a local agent, then hands its running watcher the new setting', async () => {
    getRemoteAgentLocation.mockResolvedValue(null);

    await setAgentPermission(bypassOn);

    expect(calls).toEqual(['row {"autoApprove":true}', 'refresh']);
  });

  it('keeps the choice on the host, then the row, then rewrites a watcher that starts sessions', async () => {
    // The choice first, so a racing watcher write takes the new value instead
    // of putting the old one back.

    await setAgentPermission(bypassOn);

    expect(calls).toEqual(['choice full-access', 'row {"autoApprove":true}', 'push']);
  });

  it('keeps auto mode on the host as the auto runtime mode', async () => {
    await setAgentPermission({ agentId: 'agent-1', setting: 'autoMode', enabled: true });

    expect(calls).toEqual(['choice auto', 'row {"autoMode":true}', 'push']);
  });

  it('keeps full access on the host while bypass stays on over a changed auto mode', async () => {
    agentRow.current = row({ autoApprove: true, autoMode: true });

    await setAgentPermission({ agentId: 'agent-1', setting: 'autoMode', enabled: false });

    expect(calls).toEqual(['choice full-access', 'row {"autoMode":false}', 'push']);
  });

  it('falls back to auto mode on the host when bypass is turned off with auto mode on', async () => {
    agentRow.current = row({ autoApprove: true, autoMode: true });

    await setAgentPermission({ agentId: 'agent-1', setting: 'autoApprove', enabled: false });

    expect(calls).toEqual(['choice auto', 'row {"autoApprove":false}', 'push']);
  });

  it('says the watcher lags when the push does not reach the host, keeping the saved choice', async () => {
    // The host's choice already holds the new value; rolling the row back
    // would let the next watcher write silently undo it.
    pushRemotePermissions.mockRejectedValueOnce(new Error('host unreachable'));

    await expect(setAgentPermission(bypassOn)).rejects.toThrow(
      /saved, but the agent's watcher on its host could not be updated yet \(host unreachable\)/
    );

    expect(calls).toEqual(['choice full-access', 'row {"autoApprove":true}']);
    expect(pushRemotePermissions).toHaveBeenCalledOnce();
  });

  it('changes nothing when the host could not take the choice', async () => {
    keepRuntimeModeChoice.mockRejectedValueOnce(new Error('host unreachable'));

    await expect(setAgentPermission(bypassOn)).rejects.toThrow(/host unreachable/);

    expect(updateAgent).not.toHaveBeenCalled();
    expect(pushRemotePermissions).not.toHaveBeenCalled();
  });

  it('writes only the row for an agent with no Switch identity, which has no watcher yet', async () => {
    agentRow.current = row({ switchAgentId: null });

    await setAgentPermission(bypassOn);

    expect(calls).toEqual(['row {"autoApprove":true}']);
  });

  it('keeps the choice on the host for a stopped watcher, which nothing rewrites until it starts', async () => {
    listStoppedControllerAgentIds.mockResolvedValue(['agent-1']);

    await setAgentPermission(bypassOn);

    expect(calls).toEqual(['host full-access', 'row {"autoApprove":true}']);
    expect(pushRemotePermissions).not.toHaveBeenCalled();
  });

  it('leaves the row alone when the host could not keep the choice', async () => {
    listStoppedControllerAgentIds.mockResolvedValue(['agent-1']);
    recordRuntimeModeOnHost.mockRejectedValueOnce(new Error('host unreachable'));

    await expect(setAgentPermission(bypassOn)).rejects.toThrow(/host unreachable/);

    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('says so when the agent is deleted while the change is being made', async () => {
    getRemoteAgentLocation.mockResolvedValue(null);
    updateAgent.mockResolvedValueOnce(undefined as never);

    await expect(setAgentPermission(bypassOn)).rejects.toThrow(/No agent with id agent-1/);
  });

  it('says why the watcher lags when the push failed with something other than an Error', async () => {
    pushRemotePermissions.mockRejectedValueOnce('ssh closed');

    await expect(setAgentPermission(bypassOn)).rejects.toThrow(
      /could not be updated yet \(ssh closed\)/
    );
  });

  it('throws when the agent does not exist', async () => {
    agentRow.current = undefined;

    await expect(setAgentPermission({ ...bypassOn, agentId: 'ghost' })).rejects.toThrow(
      /No agent with id ghost/
    );
  });
});
