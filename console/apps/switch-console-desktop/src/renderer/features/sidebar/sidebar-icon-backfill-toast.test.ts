import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The agent-icon backfill notice must be said once per server per run, however
 * many times the sidebar refreshes (CHOO-2344).
 *
 * `refreshSidebarRoomState` runs on first paint, window focus, sign-in, the
 * background reconcile, the retry button and every membership-changing
 * mutation. Reporting the backfill outcome on each of those turned one
 * unresolved condition — a signed-out server, a server without the icon
 * endpoint — into a toast every few seconds that the user could not dismiss
 * for good.
 */

const toast = vi.fn();
const backfillAgentIcons = vi.fn();

const LOCATION = { id: 'loc-1' };
const AGENT = {
  id: 'agent-1',
  name: 'agent one',
  serverId: 'server-1',
  switchAgentId: 'switch-agent-1',
  createdAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast }));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { switchServers: { backfillAgentIcons } },
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: {
    load: vi.fn().mockResolvedValue(undefined),
    byLocation: new Map([[LOCATION.id, [AGENT]]]),
    agentsOnServerAtLocation: () => [AGENT],
  },
}));
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    ensureMembershipsFor: vi.fn().mockResolvedValue(undefined),
    loadRoomNames: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { activeServerId: 'server-1' },
}));
vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: {
    orderedLocations: [LOCATION],
    filteredLocations: [LOCATION],
    visibleSessionsForLocation: () => [],
    orderAgents: (entries: unknown[]) => entries,
  },
}));
vi.mock('@renderer/utils/logger', () => ({
  log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** Fresh module state per test — the "said it already" record is per run. */
async function loadSubject() {
  vi.resetModules();
  return await import('./sidebar-tree-data');
}

describe('agent icon backfill reporting', () => {
  beforeEach(() => {
    toast.mockClear();
    backfillAgentIcons.mockReset();
  });

  it('reports a server without the icon endpoint once, not on every refresh', async () => {
    backfillAgentIcons.mockResolvedValue({ kind: 'unsupported' });
    const { refreshSidebarRoomState } = await loadSubject();

    await refreshSidebarRoomState(false);
    await refreshSidebarRoomState(false);
    await refreshSidebarRoomState(false);

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].title).toContain('does not support agent icons');
  });

  it('reports a failed backfill once, not on every refresh', async () => {
    // The reported case: signed out, so fetching the agents throws every time.
    backfillAgentIcons.mockRejectedValue(new Error('not signed in'));
    const { refreshSidebarRoomState } = await loadSubject();

    await refreshSidebarRoomState(false);
    await refreshSidebarRoomState(false);
    await refreshSidebarRoomState(false);

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].title).toBe('Agent icons could not be saved');
  });

  it('reports agents that kept the old icon once', async () => {
    backfillAgentIcons.mockResolvedValue({ kind: 'partial', written: 1, failed: 2 });
    const { refreshSidebarRoomState } = await loadSubject();

    await refreshSidebarRoomState(false);
    await refreshSidebarRoomState(false);

    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('says nothing at all when the backfill succeeds', async () => {
    backfillAgentIcons.mockResolvedValue({ kind: 'written', written: 3 });
    const { refreshSidebarRoomState } = await loadSubject();

    await refreshSidebarRoomState(false);
    await refreshSidebarRoomState(false);

    expect(toast).not.toHaveBeenCalled();
  });

  it('still retries the work itself after a failure', async () => {
    // Reporting once must not turn into trying once: signing in should fix it
    // without a restart, which needs the next refresh to ask again.
    backfillAgentIcons.mockRejectedValue(new Error('not signed in'));
    const { refreshSidebarRoomState } = await loadSubject();

    await refreshSidebarRoomState(false);
    await refreshSidebarRoomState(false);

    expect(backfillAgentIcons).toHaveBeenCalledTimes(2);
  });
});
