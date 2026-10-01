import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
  listAutoSessionSubagents: async () => [],
  setAutoSessionSubagent: vi.fn(),
}));
vi.mock('./current-watchers', () => ({ currentWatchers: async () => new Set<string>() }));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@main/core/managed-switch-server/session-readiness', () => ({
  onManagedServerUpgraded: (listener: (serverId: string) => void) => mocks.upgraded.push(listener),
}));
const { autoSessionWatcher, HOST_SETTLE_MS, RETRY_FIRST_MS, RETRY_MAX_MS } =
  await import('./auto-session-watcher');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agentById.mockResolvedValue({ id: 'agent' });
  mocks.agents.mockResolvedValue([
    { id: 'linked', switchAgentId: 'switch-1' },
    { id: 'unlinked', switchAgentId: null },
  ]);
  mocks.location.mockResolvedValue({ sshHost: null });
});

afterEach(async () => {
  vi.useRealTimers();
  await autoSessionWatcher.dispose();
});

it('gives every Switch-linked agent a controller at boot, and only those', async () => {
  await autoSessionWatcher.initialize();
  expect(mocks.apply.mock.calls).toEqual([['linked', 'restore', 'host']]);
});

it('restores controllers at boot rather than asking for one back', async () => {
  await autoSessionWatcher.initialize();
  // A displaced controller stood down because another client took this agent's
  // connection. Booting Console is not somebody asking for it back, so the
  // sweep must not clear that and start the two trading the connection.
  expect(mocks.apply).toHaveBeenCalledWith('linked', 'restore', 'host');
});

it('keeps sweeping when one agent’s controller cannot start', async () => {
  mocks.agents.mockResolvedValue([
    { id: 'broken', switchAgentId: 'switch-1' },
    { id: 'linked', switchAgentId: 'switch-2' },
  ]);
  mocks.apply.mockRejectedValueOnce(new Error('Host unreachable'));
  await autoSessionWatcher.initialize();
  expect(mocks.apply).toHaveBeenCalledWith('linked', 'restore', 'host');
});

it('starts a controller whose host was unreachable at boot, once the host comes back', async () => {
  // The boot sweep runs once. Without this the agent is off the air until
  // Console is restarted, however long the host has been back.
  mocks.agents.mockResolvedValue([{ id: 'remote', switchAgentId: 'switch-1' }]);
  mocks.location.mockResolvedValue({ sshHost: 'host' });
  mocks.apply.mockRejectedValueOnce(new Error('Host unreachable'));
  await autoSessionWatcher.initialize();
  expect(mocks.apply).toHaveBeenCalledTimes(1);

  vi.useFakeTimers();
  mocks.reachability.announce({ current: { sshHost: 'host', status: 'reachable' } });
  // The sweep now waits for the host to hold still first, so a flapping
  // tunnel cannot keep triggering it.
  await vi.advanceTimersByTimeAsync(HOST_SETTLE_MS);
  vi.useRealTimers();

  await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(2));
  // Still a restore: the host returning is not somebody asking for a connection
  // another client has since taken, nor for a controller stopped by hand.
  expect(mocks.apply.mock.calls[1]).toEqual(['remote', 'restore', 'host']);
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

  vi.useFakeTimers();
  mocks.reachability.announce({ current: { sshHost: 'host', status: 'reachable' } });
  // The sweep now waits for the host to hold still first, so a flapping
  // tunnel cannot keep triggering it.
  await vi.advanceTimersByTimeAsync(HOST_SETTLE_MS);
  vi.useRealTimers();

  await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
  expect(mocks.apply).toHaveBeenCalledWith('here', 'restore', 'host');
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

  vi.useFakeTimers();
  mocks.reachability.announce({ current: { sshHost: 'host', status: 'reachable' } });
  await vi.advanceTimersByTimeAsync(HOST_SETTLE_MS);
  vi.useRealTimers();
  await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(2));
  vi.useFakeTimers();
  mocks.reachability.announce({ current: { sshHost: 'host', status: 'unreachable' } });
  mocks.reachability.announce({ current: { sshHost: 'host', status: 'reachable' } });
  await vi.advanceTimersByTimeAsync(HOST_SETTLE_MS);
  vi.useRealTimers();
  arrive();

  await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(3));
  expect(mocks.apply.mock.calls[2]).toEqual(['remote', 'restore', 'host']);
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

  await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledWith('elsewhere', 'restore', 'host'));
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
  expect(mocks.apply).toHaveBeenCalledWith('upgraded', 'restore', 'host');
});

it('brings each host up side by side, so a stuck host holds back only its own agents', async () => {
  mocks.agents.mockResolvedValue([
    { id: 'stuck', switchAgentId: 'switch-1' },
    { id: 'after-stuck', switchAgentId: 'switch-2' },
    { id: 'local', switchAgentId: 'switch-3' },
  ]);
  mocks.location.mockImplementation(async (agent: { id: string }) => ({
    sshHost: agent.id === 'local' ? null : 'wedged-host',
  }));
  let release: () => void = () => {};
  mocks.apply.mockImplementation(async (agentId: string) => {
    if (agentId === 'stuck')
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  });
  const boot = autoSessionWatcher.initialize();

  await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledWith('local', 'restore', 'host'));
  // One host's agents still go in turn: they share its one SSH connection.
  expect(mocks.apply).not.toHaveBeenCalledWith('after-stuck', 'restore', 'host');
  release();
  await boot;
  expect(mocks.apply).toHaveBeenCalledWith('after-stuck', 'restore', 'host');
});

it('tries a controller that could not start again, backing off, until it comes up', async () => {
  vi.useFakeTimers();
  mocks.agents.mockResolvedValue([{ id: 'remote', switchAgentId: 'switch-1' }]);
  mocks.agentById.mockResolvedValue({ id: 'remote', switchAgentId: 'switch-1' });
  mocks.apply
    .mockRejectedValueOnce(new Error('SSH exec channel open timed out'))
    .mockRejectedValueOnce(new Error('SSH exec channel open timed out'))
    .mockResolvedValue(undefined);
  await autoSessionWatcher.initialize();
  expect(mocks.apply).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS);
  expect(mocks.apply).toHaveBeenCalledTimes(2);
  // The second wait is twice the first.
  await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS);
  expect(mocks.apply).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS);
  expect(mocks.apply).toHaveBeenCalledTimes(3);

  // Up now, so nothing more is scheduled.
  await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
  expect(mocks.apply).toHaveBeenCalledTimes(3);
  expect(mocks.apply.mock.calls.every(([, intent]) => intent === 'restore')).toBe(true);
});

it('retries a new agent’s controller as a restore, whatever the first ask was', async () => {
  vi.useFakeTimers();
  mocks.agentById.mockResolvedValue({ id: 'new', switchAgentId: 'switch-1' });
  mocks.apply.mockRejectedValueOnce(new Error('Host unreachable')).mockResolvedValue(undefined);

  await autoSessionWatcher.bringUp('new', 'explicit');
  await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS);

  expect(mocks.apply.mock.calls).toEqual([
    ['new', 'explicit', 'host'],
    ['new', 'restore', 'host'],
  ]);
});

it('stops retrying for an agent that has been removed', async () => {
  vi.useFakeTimers();
  mocks.apply.mockRejectedValue(new Error('Host unreachable'));
  await autoSessionWatcher.bringUp('gone', 'restore');
  mocks.agentById.mockResolvedValue(null);

  await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 4);

  expect(mocks.apply).toHaveBeenCalledTimes(1);
});
