import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';

const listRemoteRooms = vi.hoisted(() => vi.fn());
const listAgentRooms = vi.hoisted(() => vi.fn());
const serversStore = vi.hoisted(() => ({
  servers: [] as { id: string; managed?: boolean }[],
  activeServerId: null as string | null,
  isConnected: () => true,
  statusFor: (serverId: string) => ({ user: { id: `user-of-${serverId}` } }),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: { switchServers: { listRemoteRooms, listAgentRooms } },
}));
vi.mock('./switch-servers-store', () => ({ switchServersStore: serversStore }));

const { SwitchRoomsStore } = await import('./switch-rooms-store');

function room(id: string, ownerId: string | null, overrides: Partial<RemoteRoomSummary> = {}) {
  return {
    id,
    name: id,
    description: '',
    channelType: 'channel_public',
    agentCount: 0,
    bridgeDisplayName: null,
    bridgeType: null,
    externalChannelUrl: null,
    ownerId,
    archived: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } satisfies RemoteRoomSummary;
}

describe('listed rooms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serversStore.servers = [{ id: 'srv-a' }, { id: 'srv-b' }];
    serversStore.activeServerId = null;
  });

  it('lists every room on a server this install manages', async () => {
    // You run that deployment. Nothing on it should need a second app to see.
    serversStore.servers = [{ id: 'srv-a', managed: true }, { id: 'srv-b' }];
    serversStore.activeServerId = 'srv-a';
    listRemoteRooms.mockImplementation(async (serverId: string) =>
      serverId === 'srv-a'
        ? [
            room('mine', 'user-of-srv-a'),
            room('someone-elses', 'user-of-someone-else'),
            room('gone', 'user-of-srv-a', { archived: true }),
          ]
        : []
    );

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();

    expect(store.listedRoomsInActiveScope.map((r) => r.id)).toEqual(['mine', 'someone-elses']);
  });

  it('lists only rooms owned by that server’s signed-in user, excluding archived ones', async () => {
    listRemoteRooms.mockImplementation(async (serverId: string) =>
      serverId === 'srv-a'
        ? [
            room('mine', 'user-of-srv-a'),
            room('someone-elses', 'user-of-someone-else'),
            room('mine-but-archived', 'user-of-srv-a', { archived: true }),
            room('ownerless', null),
          ]
        : []
    );

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();

    expect(store.listedRoomsInActiveScope.map((r: { id: string }) => r.id)).toEqual(['mine']);
  });

  it('shows only the active server’s rooms, not every connected server’s', async () => {
    listRemoteRooms.mockImplementation(async (serverId: string) => [
      room(`${serverId}-room`, `user-of-${serverId}`),
    ]);

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();
    serversStore.activeServerId = 'srv-b';

    expect(store.listedRoomsInActiveScope.map((r: { id: string }) => r.id)).toEqual(['srv-b-room']);
  });

  it('hides nothing when no server is active, matching how locations are scoped', async () => {
    listRemoteRooms.mockImplementation(async (serverId: string) => [
      room(`${serverId}-room`, `user-of-${serverId}`),
    ]);

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();

    expect(store.listedRoomsInActiveScope.map((r: { id: string }) => r.id)).toEqual([
      'srv-a-room',
      'srv-b-room',
    ]);
  });

  it('keeps a server that failed to respond from dropping the others', async () => {
    listRemoteRooms.mockImplementation(async (serverId: string) => {
      if (serverId === 'srv-a') throw new Error('unreachable');
      return [room('srv-b-room', 'user-of-srv-b')];
    });

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();

    expect(store.listedRoomsInActiveScope.map((r: { id: string }) => r.id)).toEqual(['srv-b-room']);
  });
});

describe('agent memberships', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAgentRooms.mockImplementation(async ({ agentId }: { agentId: string }) => [
      {
        roomId: `room-of-${agentId}`,
        roomName: 'r',
        archived: false,
        status: 'live',
        roomRole: null,
      },
    ]);
  });

  it('loads every agent’s rooms so the sidebar can list agents under a room', async () => {
    const store = new SwitchRoomsStore();

    await store.ensureMembershipsFor([
      { serverId: 'srv-a', switchAgentId: 'agent-1' },
      { serverId: 'srv-a', switchAgentId: 'agent-2' },
    ]);

    expect(store.roomsFor('srv-a', 'agent-1')?.[0].roomId).toBe('room-of-agent-1');
    expect(store.roomsFor('srv-a', 'agent-2')?.[0].roomId).toBe('room-of-agent-2');
  });

  it('serves cached memberships without refetching, unless forced', async () => {
    const store = new SwitchRoomsStore();
    const agents = [{ serverId: 'srv-a', switchAgentId: 'agent-1' }];

    await store.ensureMembershipsFor(agents);
    await store.ensureMembershipsFor(agents);
    expect(listAgentRooms).toHaveBeenCalledOnce();

    await store.ensureMembershipsFor(agents, { force: true });
    expect(listAgentRooms).toHaveBeenCalledTimes(2);
  });

  it('lets one agent’s failed lookup stand without losing the others', async () => {
    listAgentRooms.mockImplementation(async ({ agentId }: { agentId: string }) => {
      if (agentId === 'agent-1') throw new Error('nope');
      return [{ roomId: 'room-b', roomName: 'r', archived: false, status: 'live', roomRole: null }];
    });
    const store = new SwitchRoomsStore();

    await store.ensureMembershipsFor([
      { serverId: 'srv-a', switchAgentId: 'agent-1' },
      { serverId: 'srv-a', switchAgentId: 'agent-2' },
    ]);

    expect(store.roomsFor('srv-a', 'agent-1')).toBeUndefined();
    expect(store.errorFor('srv-a', 'agent-1')).toBe('nope');
    expect(store.roomsFor('srv-a', 'agent-2')?.[0].roomId).toBe('room-b');
  });
});
