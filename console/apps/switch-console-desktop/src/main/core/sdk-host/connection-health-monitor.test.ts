import type { WatcherHealth } from '@switch-console/agent-providers';
import { afterEach, expect, it, vi } from 'vitest';
import type { RoomHealthSnapshot } from '@shared/core/switch-rooms/connection-health';
import {
  type ConnectionHealthDeps,
  ConnectionHealthMonitor,
  type LinkedAgent,
} from './connection-health-monitor';
import type { HostWatcherStatus } from './host-watchers';

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

/** A remote watcher as its host's files describe it, with what it wrote about itself. */
function onHost(
  written: WatcherHealth | null,
  overrides: Partial<HostWatcherStatus> = {}
): HostWatcherStatus {
  return {
    agentId: 'switch-remote',
    root: '/state/sdk-watchers/remote',
    running: true,
    build: '/state/sdk-host/shared-host-abc.mjs',
    enabled: true,
    spawn: true,
    stoodDown: false,
    supervisorPid: 100,
    workerPid: 101,
    workerAlive: true,
    health: written && { ...written, pid: 101, updatedAt: new Date(NOW).toISOString() },
    failure: null,
    takenOver: null,
    ...overrides,
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
    remoteWatcher: () => Promise.reject(new Error('no remote agent in this test')),
    emit: (_serverId, snapshot) => pushed.push(snapshot),
    redact: (text) => text.replaceAll('secret', '[redacted]'),
    logError: vi.fn(),
    now: () => NOW,
    pollMs: 5_000,
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

it('reads a remote agent from what its watcher wrote on its host, and reads it again', async () => {
  vi.useFakeTimers();
  const host = vi
    .fn<(agentId: string) => Promise<HostWatcherStatus | null>>()
    .mockResolvedValueOnce(
      onHost(health({ state: 'connecting', since: new Date(NOW).toISOString() }))
    )
    .mockResolvedValue(onHost(health({ placements: { 'session-9': 'room-9' } })));
  const { monitor, pushed } = monitorWith({
    linkedAgents: async () => [agent('remote')],
    isRemote: async () => true,
    remoteWatcher: host,
  });
  expect((await monitor.snapshot('server')).agents).toEqual([
    { agentId: 'remote', state: 'connecting', detail: null },
  ]);
  expect(host).toHaveBeenCalledWith('remote');

  await vi.advanceTimersByTimeAsync(5_000);
  expect(pushed.at(-1)).toEqual({
    agents: [{ agentId: 'remote', state: 'connected', detail: null }],
    placements: { 'session-9': 'room-9' },
  });
});

it('never keeps showing what a replaced watcher last said', async () => {
  // The bug this replaces: a push connection to a sidecar that was swapped
  // out died without saying so, and its last words — "not running", as it
  // stopped — stayed on screen for good.
  vi.useFakeTimers();
  const host = vi
    .fn<(agentId: string) => Promise<HostWatcherStatus | null>>()
    .mockResolvedValueOnce(
      onHost(health({ state: 'not-running', since: new Date(NOW - 60_000).toISOString() }), {
        workerAlive: false,
        failure: null,
      })
    )
    .mockResolvedValue(
      onHost(null, {
        workerPid: 202,
        health: { ...health({}), pid: 202, updatedAt: new Date(NOW).toISOString() },
      })
    );
  const { monitor, pushed } = monitorWith({
    linkedAgents: async () => [agent('remote')],
    isRemote: async () => true,
    remoteWatcher: host,
  });
  await monitor.snapshot('server');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(pushed.at(-1)!.agents).toEqual([{ agentId: 'remote', state: 'connected', detail: null }]);
});

it('does not take a file a previous watcher left as this watcher’s word', async () => {
  vi.useFakeTimers();
  let now = NOW;
  // Written by pid 101; the watcher alive now is 202 and has written nothing.
  const stale = onHost(health({}), { workerPid: 202 });
  const { monitor, pushed } = monitorWith({
    linkedAgents: async () => [agent('remote')],
    isRemote: async () => true,
    remoteWatcher: async () => stale,
    now: () => now,
  });
  expect((await monitor.snapshot('server')).agents).toEqual([
    { agentId: 'remote', state: 'connecting', detail: null },
  ]);
  now = NOW + 20_000;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(pushed.at(-1)!.agents).toEqual([
    {
      agentId: 'remote',
      state: 'failed',
      detail:
        "The agent's room watcher is running but does not report its connection to Switch. Update its sidecar to this Console's build.",
    },
  ]);
});

it('says the host cannot be read, and reads it again on the next round', async () => {
  vi.useFakeTimers();
  const host = vi
    .fn<(agentId: string) => Promise<HostWatcherStatus | null>>()
    .mockRejectedValueOnce(new Error('SSH exec channel open timed out after 15000ms'))
    .mockResolvedValue(onHost(health({})));
  const { monitor, pushed } = monitorWith({
    linkedAgents: async () => [agent('remote')],
    isRemote: async () => true,
    remoteWatcher: host,
  });
  expect((await monitor.snapshot('server')).agents).toEqual([
    {
      agentId: 'remote',
      state: 'unreachable',
      detail:
        "Could not read the agent's state on its host: SSH exec channel open timed out after 15000ms",
    },
  ]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(pushed.at(-1)!.agents).toEqual([{ agentId: 'remote', state: 'connected', detail: null }]);
});

it('names a takeover, the failure a stopped watcher recorded, and a host with no watcher', async () => {
  const statuses: Record<string, HostWatcherStatus | null> = {
    displaced: onHost(null, {
      stoodDown: true,
      takenOver: { at: new Date(NOW).toISOString(), reason: 'another client' },
    }),
    crashed: onHost(null, { workerAlive: false, running: false, failure: 'out of memory' }),
    missing: null,
  };
  const { monitor } = monitorWith({
    linkedAgents: async () => [agent('displaced'), agent('crashed'), agent('missing')],
    isRemote: async () => true,
    remoteWatcher: async (agentId) => statuses[agentId]!,
  });
  expect((await monitor.snapshot('server')).agents).toEqual([
    { agentId: 'displaced', state: 'taken-over', detail: 'another client' },
    { agentId: 'crashed', state: 'failed', detail: 'out of memory' },
    {
      agentId: 'missing',
      state: 'failed',
      detail: 'No room watcher has been set up for this agent on its host.',
    },
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
