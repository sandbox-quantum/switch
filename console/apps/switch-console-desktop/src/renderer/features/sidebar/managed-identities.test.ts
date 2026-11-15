import { beforeEach, describe, expect, it, vi } from 'vitest';

const servers = vi.hoisted(() => ({
  servers: [{ id: 'srv' }],
  user: 'user-1' as string | null,
}));

const local = vi.hoisted(() => ({
  agents: [] as { id: string; workspaceId: string; switchAgentId: string }[],
  moved: new Set<string>(),
  ensure: vi.fn(async (_ids: unknown) => {}),
  listeners: [] as ((event: unknown) => void)[],
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: (_channel: unknown, listener: (event: unknown) => void) => {
      local.listeners.push(listener);
      return () => {};
    },
  },
  rpc: { workspaces: { backfillAgentIcons: async () => ({}) } },
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: {
    load: async () => {},
    byLocation: { get: () => local.agents },
    isMoved: (id: string) => local.moved.has(id),
  },
}));
vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: { orderedLocations: [{ id: 'loc' }] },
}));
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: { ensureMembershipsFor: local.ensure, loadRoomNames: async () => {} },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    get servers() {
      return servers.servers;
    },
    statusFor: () => (servers.user ? { user: { id: servers.user } } : null),
  },
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: () => 'ws-a' },
}));

const {
  managedIdentities,
  refreshSidebarOnRoomChanges,
  refreshSidebarRoomState,
  switchIdentities,
} = await import('./sidebar-tree-data');
const { queryClient } = await import('@renderer/lib/query-client');

describe('managedIdentities', () => {
  beforeEach(() => {
    queryClient.clear();
    servers.user = 'user-1';
  });

  it('reads the current user’s agent list only, not machines kept under the same prefix', () => {
    queryClient.setQueryData(
      ['managed-agents', 'srv', 'ws-a', 'user-1'],
      [{ agentId: 'buddy', workspaceId: 'ws-a' }, { agentId: 'buddy', workspaceId: 'ws-a' }, {}]
    );
    queryClient.setQueryData(['managed-agents', 'srv', 'machines', 'ws-a'], [{ machine_id: 'm1' }]);
    expect(managedIdentities()).toEqual([{ workspaceId: 'ws-a', switchAgentId: 'buddy' }]);
  });

  it('leaves another account’s list alone after switching accounts', () => {
    queryClient.setQueryData(
      ['managed-agents', 'srv', 'ws-a', 'user-1'],
      [{ agentId: 'old-users-agent', workspaceId: 'ws-a' }]
    );
    servers.user = 'user-2';
    expect(managedIdentities()).toEqual([]);
    queryClient.setQueryData(
      ['managed-agents', 'srv', 'ws-a', 'user-2'],
      [{ agentId: 'mine', workspaceId: 'ws-a' }]
    );
    expect(managedIdentities()).toEqual([{ workspaceId: 'ws-a', switchAgentId: 'mine' }]);
  });
});

describe('local membership tracking', () => {
  beforeEach(() => {
    queryClient.clear();
    servers.user = 'user-1';
    local.agents = [{ id: 'moved-row', workspaceId: 'ws-a', switchAgentId: 'gone' }];
    local.moved = new Set(['moved-row']);
    local.ensure.mockClear();
  });

  it('does not track a moved local row, so an empty managed list leaves its rooms unlisted', async () => {
    queryClient.setQueryData(['managed-agents', 'srv', 'ws-a', 'user-1'], []);
    expect(switchIdentities()).toEqual([]);
    await refreshSidebarRoomState(true);
    expect(local.ensure).toHaveBeenCalledWith([], { force: true });
  });

  it('refreshes when a server says a room changed, and not for other kinds', async () => {
    local.listeners = [];
    refreshSidebarOnRoomChanges();
    const [listener] = local.listeners;
    listener({
      type: 'changed',
      serverId: 'srv',
      workspaceId: null,
      changes: [{ kind: 'machine', id: 'm' }],
    });
    expect(local.ensure).not.toHaveBeenCalled();
    listener({
      type: 'changed',
      serverId: 'srv',
      workspaceId: null,
      changes: [{ kind: 'room', id: 'r' }],
    });
    await vi.waitFor(() => expect(local.ensure).toHaveBeenCalledTimes(1));
  });
});
