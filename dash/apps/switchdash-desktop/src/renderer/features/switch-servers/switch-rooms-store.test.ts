import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';

const listRemoteRooms = vi.hoisted(() => vi.fn());
const listAgentRooms = vi.hoisted(() => vi.fn());
const serversStore = vi.hoisted(() => ({
  servers: [] as { id: string; name?: string; managed?: boolean }[],
  activeServerId: null as string | null,
  isConnected: (_serverId: string): boolean => true,
  statusFor: (serverId: string) => ({ user: { id: `user-of-${serverId}` } }),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: { switchServers: { listRemoteRooms, listAgentRooms } },
}));
vi.mock('./switch-servers-store', () => ({ switchServersStore: serversStore }));
vi.mock('./local-server-store', () => ({ localServerStore: { isRunning: true } }));
vi.mock('./remote-server-store', () => ({ remoteServerStore: { isRunning: () => true } }));

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

  it('says the room list is incomplete when a server could not be read', async () => {
    serversStore.servers = [
      { id: 'srv-a', name: 'Alpha' },
      { id: 'srv-b', name: 'Beta' },
    ];
    listRemoteRooms.mockImplementation(async (serverId: string) => {
      if (serverId === 'srv-a') throw new Error('unreachable');
      return [room('srv-b-room', 'user-of-srv-b')];
    });

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();

    expect(store.serversThatFailedToLoad.map((s) => s.name)).toEqual(['Alpha']);
  });

  it('asks only the active server for its rooms', async () => {
    serversStore.servers = [
      { id: 'srv-a', name: 'Alpha' },
      { id: 'srv-b', name: 'Beta' },
    ];
    serversStore.activeServerId = 'srv-b';
    listRemoteRooms.mockImplementation(async () => []);

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();

    expect(listRemoteRooms).toHaveBeenCalledExactlyOnceWith('srv-b');
  });

  it('does not report another server’s failure against the one you are viewing', async () => {
    // Each server is its own world. A server you are not looking at being down
    // says nothing about the one you are, and warning about it trains you to
    // ignore the warning.
    serversStore.servers = [
      { id: 'srv-a', name: 'Alpha' },
      { id: 'srv-b', name: 'Beta' },
    ];
    listRemoteRooms.mockImplementation(async (serverId: string) => {
      if (serverId === 'srv-a') throw new Error('unreachable');
      return [room('srv-b-room', 'user-of-srv-b')];
    });
    const store = new SwitchRoomsStore();

    // Search loads every server, so Alpha's failure is on the record...
    await store.loadRoomsOnAllServers();
    expect(store.serversThatFailedToLoad.map((s) => s.name)).toEqual(['Alpha']);

    // ...but it must not surface while Beta is the server on screen.
    serversStore.activeServerId = 'srv-b';
    expect(store.serversThatFailedToLoad).toEqual([]);
    expect(store.serversNotSignedIn).toEqual([]);
  });

  it('does not report a disconnected server you are not viewing', async () => {
    serversStore.servers = [
      { id: 'srv-a', name: 'Alpha' },
      { id: 'srv-b', name: 'Beta' },
    ];
    serversStore.activeServerId = 'srv-b';
    serversStore.isConnected = (serverId: string) => serverId !== 'srv-a';
    listRemoteRooms.mockImplementation(async () => []);

    const store = new SwitchRoomsStore();
    await store.loadRoomsOnAllServers();

    expect(store.serversNotSignedIn).toEqual([]);
    serversStore.isConnected = () => true;
  });

  it('reports a server it is not signed in to as needing sign-in, not as failed', async () => {
    // Signing in is an action the user takes; a retry button cannot fix it, and
    // calling it a failure sends them round in a circle.
    serversStore.servers = [
      { id: 'srv-a', name: 'Alpha' },
      { id: 'srv-b', name: 'Beta' },
    ];
    serversStore.activeServerId = 'srv-b';
    serversStore.isConnected = (serverId: string) => serverId !== 'srv-b';
    listRemoteRooms.mockImplementation(async () => []);

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();

    expect(store.serversNotSignedIn.map((s) => s.name)).toEqual(['Beta']);
    expect(store.serversThatFailedToLoad).toEqual([]);
    serversStore.isConnected = () => true;
  });

  it('marks a room’s name as blocked on sign-in when its server is signed out', async () => {
    serversStore.servers = [{ id: 'srv-a', name: 'Alpha' }];
    serversStore.activeServerId = 'srv-a';
    serversStore.isConnected = () => false;
    listRemoteRooms.mockImplementation(async () => []);

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();

    expect(store.roomNameBlockedBySignIn('some-room')).toBe(true);
    serversStore.isConnected = () => true;
    expect(store.roomNameBlockedBySignIn('some-room')).toBe(false);
  });

  it('clears a server’s failure once it can be read again', async () => {
    serversStore.servers = [{ id: 'srv-a', name: 'Alpha' }];
    listRemoteRooms.mockImplementation(async () => {
      throw new Error('unreachable');
    });
    const store = new SwitchRoomsStore();
    await store.loadRoomNames();
    expect(store.serversThatFailedToLoad.map((s) => s.name)).toEqual(['Alpha']);

    listRemoteRooms.mockImplementation(async () => [room('back', 'user-of-srv-a')]);
    await store.loadRoomNames();

    expect(store.serversThatFailedToLoad).toEqual([]);
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

  it('inverts memberships into the room-keyed view the sidebar draws', async () => {
    listAgentRooms.mockImplementation(async ({ agentId }: { agentId: string }) => [
      { roomId: 'shared', roomName: 'r', archived: false, status: 'live', roomRole: null },
      {
        roomId: `only-${agentId}`,
        roomName: 'r',
        archived: false,
        status: 'live',
        roomRole: null,
      },
    ]);
    const store = new SwitchRoomsStore();

    await store.ensureMembershipsFor([
      { serverId: 'srv-a', switchAgentId: 'agent-1' },
      { serverId: 'srv-a', switchAgentId: 'agent-2' },
    ]);

    expect(store.localMemberIds('shared').sort()).toEqual(['agent-1', 'agent-2']);
    expect(store.localMemberIds('only-agent-1')).toEqual(['agent-1']);
  });

  it('leaves an archived membership out of the room’s member list', async () => {
    listAgentRooms.mockImplementation(async () => [
      { roomId: 'gone', roomName: 'r', archived: true, status: 'live', roomRole: null },
    ]);
    const store = new SwitchRoomsStore();

    await store.ensureMembershipsFor([{ serverId: 'srv-a', switchAgentId: 'agent-1' }]);

    expect(store.localMemberIds('gone')).toEqual([]);
  });

  it('discloses members the server counts that this install cannot draw', async () => {
    serversStore.servers = [{ id: 'srv-a', managed: true }];
    serversStore.activeServerId = 'srv-a';
    listRemoteRooms.mockImplementation(async () => [
      room('shared', 'user-of-srv-a', { agentCount: 3 }),
    ]);
    listAgentRooms.mockImplementation(async () => [
      { roomId: 'shared', roomName: 'r', archived: false, status: 'live', roomRole: null },
    ]);
    const store = new SwitchRoomsStore();

    await store.loadRoomNames();
    await store.ensureMembershipsFor([{ serverId: 'srv-a', switchAgentId: 'agent-1' }]);

    // One member is drawable here; the other two exist but belong elsewhere.
    expect(store.localMemberIds('shared')).toEqual(['agent-1']);
    expect(store.undrawableMemberCount('shared')).toBe(1 + 1);
  });

  it('reports the undrawable count as unknown until the room list has loaded', () => {
    const store = new SwitchRoomsStore();

    expect(store.undrawableMemberCount('never-loaded')).toBeNull();
  });

  it('re-reads every tracked agent on refresh, not just the ones already cached', async () => {
    // An agent created after the sidebar mounted has no cache entry, so a
    // refresh keyed on the cache would never fetch it.
    listAgentRooms.mockImplementation(async ({ agentId }: { agentId: string }) => {
      if (agentId === 'agent-late') throw new Error('not yet');
      return [{ roomId: 'room-a', roomName: 'r', archived: false, status: 'live', roomRole: null }];
    });
    listRemoteRooms.mockImplementation(async () => []);
    const store = new SwitchRoomsStore();
    await store.ensureMembershipsFor([
      { serverId: 'srv-a', switchAgentId: 'agent-1' },
      { serverId: 'srv-a', switchAgentId: 'agent-late' },
    ]);
    expect(store.roomsFor('srv-a', 'agent-late')).toBeUndefined();

    listAgentRooms.mockImplementation(async () => [
      { roomId: 'room-b', roomName: 'r', archived: false, status: 'live', roomRole: null },
    ]);
    await store.refreshRoomState();

    expect(store.roomsFor('srv-a', 'agent-late')?.[0].roomId).toBe('room-b');
  });

  it('reports an agent whose membership failed as unknown, not as in no rooms', async () => {
    listAgentRooms.mockImplementation(async ({ agentId }: { agentId: string }) => {
      if (agentId === 'agent-1') throw new Error('nope');
      return [{ roomId: 'room-b', roomName: 'r', archived: false, status: 'live', roomRole: null }];
    });
    const store = new SwitchRoomsStore();

    await store.ensureMembershipsFor([
      { serverId: 'srv-a', switchAgentId: 'agent-1' },
      { serverId: 'srv-a', switchAgentId: 'agent-2' },
    ]);

    expect(store.agentsWithUnknownMembership).toBe(1);
  });

  it('reports no unknown memberships once every tracked agent has loaded', async () => {
    const store = new SwitchRoomsStore();

    await store.ensureMembershipsFor([
      { serverId: 'srv-a', switchAgentId: 'agent-1' },
      { serverId: 'srv-a', switchAgentId: 'agent-2' },
    ]);

    expect(store.agentsWithUnknownMembership).toBe(0);
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
