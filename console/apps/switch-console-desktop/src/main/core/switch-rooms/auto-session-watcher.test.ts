import { beforeEach, expect, it, vi } from 'vitest';
type Change = { current: { sshHost: string; status: string } };
const mocks = vi.hoisted(() => {
  const listeners: ((change: Change) => void)[] = [];
  const upgraded: ((serverId: string) => void)[] = [];
  return {
    upgraded,
    apply: vi.fn(),
    configure: vi.fn(),
    dispose: vi.fn(async () => {}),
    agents: vi.fn(),
    agentById: vi.fn(),
    autoSessionIds: vi.fn(),
    setAutoSessionAgent: vi.fn(),
    location: vi.fn(),
    reachability: {
      on(_event: string, listener: (change: Change) => void) {
        listeners.push(listener);
      },
      announce(change: Change) {
        for (const listener of listeners) listener(change);
      },
    },
  };
});
vi.mock('@main/core/sdk-host/shared-watcher', () => ({
  applyControllerState: mocks.apply,
  configureSharedWatcher: mocks.configure,
}));
vi.mock('@main/core/sdk-host/local-host', () => ({ disposeLocalHosts: mocks.dispose }));
vi.mock('@main/core/agents/getAgents', () => ({ getAgents: mocks.agents }));
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: mocks.agentById }));
vi.mock('@main/core/agents/agent-location', () => ({ getAgentLocation: mocks.location }));
vi.mock('@main/core/remote-hosts/production-host-reachability', () => ({
  hostReachabilityService: mocks.reachability,
}));
vi.mock('./auto-session-store', () => ({
  listAutoSessionAgentIds: mocks.autoSessionIds,
  listAutoSessionSubagents: async () => [],
  setAutoSessionAgent: mocks.setAutoSessionAgent,
  setAutoSessionSubagent: vi.fn(),
}));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn() } }));
vi.mock('@main/core/managed-switch-server/session-readiness', () => ({
  onManagedServerUpgraded: (listener: (serverId: string) => void) => mocks.upgraded.push(listener),
}));
const { autoSessionWatcher } = await import('./auto-session-watcher');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.autoSessionIds.mockResolvedValue([]);
  mocks.agentById.mockResolvedValue({ id: 'agent' });
  mocks.agents.mockResolvedValue([
    { id: 'linked', switchAgentId: 'switch-1' },
    { id: 'unlinked', switchAgentId: null },
  ]);
  mocks.location.mockResolvedValue({ sshHost: null });
});

it('gives every Switch-linked agent a controller at boot, and only those', async () => {
  await autoSessionWatcher.initialize();
  expect(mocks.apply.mock.calls).toEqual([['linked', 'restore']]);
});

it('restores controllers at boot rather than asking for one back', async () => {
  await autoSessionWatcher.initialize();
  // A displaced controller stood down because another client took this agent's
  // connection. Booting Console is not somebody asking for it back, so the
  // sweep must not clear that and start the two trading the connection.
  expect(mocks.apply).toHaveBeenCalledWith('linked', 'restore');
});

it('keeps sweeping when one agent’s controller cannot start', async () => {
  mocks.agents.mockResolvedValue([
    { id: 'broken', switchAgentId: 'switch-1' },
    { id: 'linked', switchAgentId: 'switch-2' },
  ]);
  mocks.apply.mockRejectedValueOnce(new Error('Host unreachable'));
  await autoSessionWatcher.initialize();
  expect(mocks.apply).toHaveBeenCalledWith('linked', 'restore');
});

it('drops a deleted agent from the automatic-session mirror', async () => {
  mocks.autoSessionIds.mockResolvedValue(['gone']);
  mocks.agentById.mockResolvedValue(null);
  await autoSessionWatcher.initialize();
  expect(mocks.setAutoSessionAgent).toHaveBeenCalledWith('gone', false);
});

it('starts a controller whose host was unreachable at boot, once the host comes back', async () => {
  // The boot sweep runs once. Without this the agent is off the air until
  // Console is restarted, however long the host has been back.
  mocks.agents.mockResolvedValue([{ id: 'remote', switchAgentId: 'switch-1' }]);
  mocks.location.mockResolvedValue({ sshHost: 'host' });
  mocks.apply.mockRejectedValueOnce(new Error('Host unreachable'));
  await autoSessionWatcher.initialize();
  expect(mocks.apply).toHaveBeenCalledTimes(1);

  mocks.reachability.announce({ current: { sshHost: 'host', status: 'reachable' } });

  await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(2));
  // Still a restore: the host returning is not somebody asking for a connection
  // another client has since taken, nor for a controller stopped by hand.
  expect(mocks.apply.mock.calls[1]).toEqual(['remote', 'restore']);
});

it('leaves agents on other hosts alone when one host comes back', async () => {
  mocks.agents.mockResolvedValue([
    { id: 'here', switchAgentId: 'switch-1' },
    { id: 'elsewhere', switchAgentId: 'switch-2' },
  ]);
  mocks.location.mockImplementation(async (agent: { id: string }) => ({
    sshHost: agent.id === 'here' ? 'host' : 'other-host',
  }));
  await autoSessionWatcher.initialize();
  mocks.apply.mockClear();

  mocks.reachability.announce({ current: { sshHost: 'host', status: 'reachable' } });

  await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
  expect(mocks.apply).toHaveBeenCalledWith('here', 'restore');
});

it('sweeps again for a host that flaps while its recovery is still running', async () => {
  // The controller this sweep failed to start is exactly the one the second
  // recovery is for. Discarding the overlapping signal leaves it down until the
  // host happens to flap again.
  mocks.agents.mockResolvedValue([{ id: 'remote', switchAgentId: 'switch-1' }]);
  mocks.location.mockResolvedValue({ sshHost: 'host' });
  let arrive: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  mocks.apply.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
    await held;
    throw new Error('Host unreachable');
  });
  await autoSessionWatcher.initialize();

  mocks.reachability.announce({ current: { sshHost: 'host', status: 'reachable' } });
  await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(2));
  mocks.reachability.announce({ current: { sshHost: 'host', status: 'unreachable' } });
  mocks.reachability.announce({ current: { sshHost: 'host', status: 'reachable' } });
  arrive();

  await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(3));
  expect(mocks.apply.mock.calls[2]).toEqual(['remote', 'restore']);
});

it('does nothing for a host that has only just gone away', async () => {
  mocks.agents.mockResolvedValue([{ id: 'remote', switchAgentId: 'switch-1' }]);
  mocks.location.mockResolvedValue({ sshHost: 'host' });
  await autoSessionWatcher.initialize();
  mocks.apply.mockClear();

  mocks.reachability.announce({ current: { sshHost: 'host', status: 'unreachable' } });

  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(mocks.apply).not.toHaveBeenCalled();
});

it('applies the saved settings when asked to reconcile an agent', async () => {
  await autoSessionWatcher.reconcile('agent');
  expect(mocks.apply).toHaveBeenCalledWith('agent', 'explicit');
});

it('stops everything it hosts when Console closes', async () => {
  await autoSessionWatcher.dispose();
  expect(mocks.dispose).toHaveBeenCalled();
});

it('does not hold one server’s agents behind another server’s update', async () => {
  mocks.agents.mockResolvedValue([
    { id: 'updating', switchAgentId: 'switch-1', serverId: 'local' },
    { id: 'elsewhere', switchAgentId: 'switch-2', serverId: 'other' },
  ]);
  let finish: () => void = () => {};
  mocks.apply.mockImplementation(async (agentId: string) => {
    if (agentId === 'updating')
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
  });
  const boot = autoSessionWatcher.initialize();

  await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledWith('elsewhere', 'restore'));
  finish();
  await boot;
});

it('starts the controllers of a server once an update they were refused for finishes', async () => {
  mocks.agents.mockResolvedValue([
    { id: 'upgraded', switchAgentId: 'switch-1', serverId: 'local' },
    { id: 'elsewhere', switchAgentId: 'switch-2', serverId: 'other' },
    { id: 'unlinked', switchAgentId: null, serverId: 'local' },
  ]);
  await autoSessionWatcher.initialize();
  mocks.apply.mockClear();

  for (const listener of mocks.upgraded) listener('local');

  await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
  expect(mocks.apply).toHaveBeenCalledWith('upgraded', 'restore');
});
