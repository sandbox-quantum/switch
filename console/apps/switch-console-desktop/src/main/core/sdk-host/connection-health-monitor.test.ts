import type { WatcherHealth } from '@switch-console/agent-providers';
import { afterEach, expect, it, vi } from 'vitest';
import type { RoomHealthSnapshot } from '@shared/core/switch-rooms/connection-health';
import {
  type ConnectionHealthDeps,
  ConnectionHealthMonitor,
  type LinkedAgent,
  type RemoteHealthSource,
} from './connection-health-monitor';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');

function health(overrides: Partial<WatcherHealth>): WatcherHealth {
  return {
    state: 'connected',
    detail: null,
    since: new Date(NOW - 60_000).toISOString(),
    placements: {},
    ...overrides,
  };
}

/** A watcher as Console sees one running in its own process. */
function localWatcher(initial: WatcherHealth) {
  let current = initial;
  const listeners = new Set<(health: WatcherHealth) => void>();
  return {
    health: () => current,
    onHealth: (listener: (health: WatcherHealth) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    report(next: WatcherHealth) {
      current = next;
      for (const listener of listeners) listener(next);
    },
    listeners,
  };
}

/** A sidecar's control connection, as the monitor uses it. */
function sidecar(initial: WatcherHealth) {
  let current = initial;
  const listeners = new Set<(health: WatcherHealth) => void>();
  const closers = new Set<(error: Error) => void>();
  const client: RemoteHealthSource = {
    health: async () => current,
    onHealth: async (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose: (listener) => {
      closers.add(listener);
      return () => closers.delete(listener);
    },
  };
  return {
    client,
    report(next: WatcherHealth) {
      current = next;
      for (const listener of listeners) listener(next);
    },
    close(error: Error) {
      for (const closer of closers) closer(error);
    },
  };
}

const agent = (id: string): LinkedAgent => ({
  id,
  serverId: 'server',
  switchAgentId: `switch-${id}`,
  locationId: `location-${id}`,
});

function monitorWith(overrides: Partial<ConnectionHealthDeps>) {
  const pushed: RoomHealthSnapshot[] = [];
  const deps: ConnectionHealthDeps = {
    linkedAgents: async () => [],
    isRemote: async () => false,
    stoppedAgentIds: async () => [],
    local: () => {
      throw new Error('no local watcher in this test');
    },
    remote: () => Promise.reject(new Error('no sidecar in this test')),
    remoteStatus: async () => null,
    emit: (_serverId, snapshot) => pushed.push(snapshot),
    redact: (text) => text.replaceAll('secret', '[redacted]'),
    logError: vi.fn(),
    now: () => NOW,
    retryMs: 10_000,
    ...overrides,
  };
  const monitor = new ConnectionHealthMonitor(deps);
  monitors.push(monitor);
  return { monitor, pushed };
}

const monitors: ConnectionHealthMonitor[] = [];
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.dispose();
  vi.useRealTimers();
});

it('reads a local agent from its watcher in Console and pushes each change', async () => {
  const watcher = localWatcher(health({ placements: { 'session-1': 'room-1' } }));
  const { monitor, pushed } = monitorWith({
    linkedAgents: async () => [agent('local')],
    local: (switchAgentId) => {
      expect(switchAgentId).toBe('switch-local');
      return watcher;
    },
  });

  expect(await monitor.snapshot('server')).toEqual({
    agents: [{ agentId: 'local', state: 'connected', detail: null }],
    placements: { 'session-1': 'room-1' },
  });

  watcher.report(health({ placements: { 'session-2': 'room-1' } }));
  await vi.waitFor(() => expect(pushed).toHaveLength(1));
  expect(pushed[0]).toEqual({
    agents: [{ agentId: 'local', state: 'connected', detail: null }],
    placements: { 'session-2': 'room-1' },
  });

  watcher.report(health({ state: 'taken-over', detail: 'secret client took it', placements: {} }));
  await vi.waitFor(() => expect(pushed).toHaveLength(2));
  expect(pushed[1]).toEqual({
    agents: [{ agentId: 'local', state: 'taken-over', detail: '[redacted] client took it' }],
    placements: {},
  });
});

it('shows a stream that just dropped as connecting, then failed once the grace has passed', async () => {
  vi.useFakeTimers();
  let now = NOW;
  const watcher = localWatcher(
    health({ state: 'disconnected', detail: 'HTTP 502', since: new Date(NOW).toISOString() })
  );
  const { monitor, pushed } = monitorWith({
    linkedAgents: async () => [agent('local')],
    local: () => watcher,
    now: () => now,
  });
  expect((await monitor.snapshot('server')).agents).toEqual([
    { agentId: 'local', state: 'connecting', detail: 'HTTP 502' },
  ]);
  now = NOW + 15_000;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(pushed.at(-1)!.agents).toEqual([
    { agentId: 'local', state: 'failed', detail: 'HTTP 502' },
  ]);
});

it('reads a remote agent through its sidecar and follows what the sidecar pushes', async () => {
  const remote = sidecar(health({ state: 'connecting', since: new Date(NOW).toISOString() }));
  const { monitor, pushed } = monitorWith({
    linkedAgents: async () => [agent('remote')],
    isRemote: async () => true,
    remote: async (agentId) => {
      expect(agentId).toBe('remote');
      return remote.client;
    },
  });
  expect((await monitor.snapshot('server')).agents).toEqual([
    { agentId: 'remote', state: 'connecting', detail: null },
  ]);
  remote.report(health({ placements: { 'session-9': 'room-9' } }));
  await vi.waitFor(() =>
    expect(pushed.at(-1)).toEqual({
      agents: [{ agentId: 'remote', state: 'connected', detail: null }],
      placements: { 'session-9': 'room-9' },
    })
  );
});

it('says a sidecar cannot be reached, and why, and connects again once it can', async () => {
  vi.useFakeTimers();
  const remote = sidecar(health({}));
  const reach = vi
    .fn<(agentId: string) => Promise<RemoteHealthSource>>()
    .mockRejectedValueOnce(new Error("The agent's sidecar is not running on its host."))
    .mockResolvedValue(remote.client);
  const { monitor, pushed } = monitorWith({
    linkedAgents: async () => [agent('remote')],
    isRemote: async () => true,
    remote: reach,
    remoteStatus: async () => ({ takenOver: null, failure: 'out of memory' }),
  });
  expect((await monitor.snapshot('server')).agents).toEqual([
    {
      agentId: 'remote',
      state: 'unreachable',
      detail:
        "The agent's sidecar is not running on its host. The sidecar last stopped with: out of memory",
    },
  ]);

  await vi.advanceTimersByTimeAsync(10_000);
  expect(pushed.at(-1)!.agents).toEqual([{ agentId: 'remote', state: 'connected', detail: null }]);

  // The connection drops: unreachable again, not a made-up "disconnected".
  remote.close(new Error('The connection to the agent sidecar closed.'));
  await vi.advanceTimersByTimeAsync(0);
  expect(pushed.at(-1)!.agents).toMatchObject([
    { agentId: 'remote', state: 'unreachable', detail: expect.stringContaining('closed') },
  ]);
  // Asking again (a refetch) tries the sidecar at once rather than waiting.
  expect((await monitor.snapshot('server')).agents).toEqual([
    { agentId: 'remote', state: 'connected', detail: null },
  ]);
  expect(reach).toHaveBeenCalledTimes(3);
});

it('names a takeover the unreachable sidecar stood down for', async () => {
  const { monitor } = monitorWith({
    linkedAgents: async () => [agent('remote')],
    isRemote: async () => true,
    remote: () => Promise.reject(new Error('not running')),
    remoteStatus: async () => ({ takenOver: { reason: 'another client' }, failure: null }),
  });
  expect((await monitor.snapshot('server')).agents).toEqual([
    { agentId: 'remote', state: 'taken-over', detail: 'another client' },
  ]);
});

it('keeps agents stopped by hand, and agents it cannot place, apart from failures', async () => {
  const { monitor } = monitorWith({
    linkedAgents: async () => [agent('stopped'), agent('lost')],
    isRemote: async (linked) => {
      if (linked.id === 'lost') throw new Error('Location location-lost not found');
      return false;
    },
    local: () => localWatcher(health({ state: 'disabled', placements: {} })),
    stoppedAgentIds: async () => ['stopped'],
  });
  expect((await monitor.snapshot('server')).agents).toEqual([
    { agentId: 'stopped', state: 'stopped', detail: null },
    {
      agentId: 'lost',
      state: 'unknown',
      detail: 'Could not tell where this agent runs: Location location-lost not found',
    },
  ]);
});

it('stops watching an agent that is no longer linked', async () => {
  const watcher = localWatcher(health({}));
  let linked = [agent('local')];
  const { monitor } = monitorWith({
    linkedAgents: async () => linked,
    local: () => watcher,
  });
  await monitor.snapshot('server');
  expect(watcher.listeners.size).toBe(1);
  linked = [];
  expect(await monitor.snapshot('server')).toEqual({ agents: [], placements: {} });
  expect(watcher.listeners.size).toBe(0);
});
