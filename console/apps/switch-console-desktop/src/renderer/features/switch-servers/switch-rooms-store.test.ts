import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';

const listRooms = vi.hoisted(() => vi.fn());
const listAgentRooms = vi.hoisted(() => vi.fn());
const serversStore = vi.hoisted(() => ({
  servers: [] as { id: string; name?: string; managed?: boolean }[],
  isConnected: (_serverId: string): boolean => true,
  // These servers answer; they are simply not signed in to.
  isUnreachable: (_serverId: string): boolean => false,
  statusFor: (serverId: string) => ({ user: { id: `user-of-${serverId}` } }),
}));
const workspaces = vi.hoisted(() => ({
  workspaces: [] as { id: string; serverId: string; name: string }[],
  activeId: null as string | null,
  byId(workspaceId: string) {
    return this.workspaces.find((w) => w.id === workspaceId) ?? null;
  },
  serverIdFor(workspaceId: string) {
    return this.byId(workspaceId)?.serverId ?? null;
  },
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: { workspaces: { listRooms, listAgentRooms } },
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: workspaces,
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

/** Two workspaces, one per server, which is what every install has today. */
function twoWorkspaces() {
  workspaces.workspaces = [
    { id: 'ws-a', serverId: 'srv-a', name: 'Alpha' },
    { id: 'ws-b', serverId: 'srv-b', name: 'Beta' },
  ];
}

describe('listed rooms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serversStore.servers = [{ id: 'srv-a' }, { id: 'srv-b' }];
    twoWorkspaces();
    workspaces.activeId = null;
  });

  it('lists every room in a workspace on a server this install manages', async () => {
    // You run that deployment. Nothing on it should need a second app to see.
    serversStore.servers = [{ id: 'srv-a', managed: true }, { id: 'srv-b' }];
    workspaces.activeId = 'ws-a';
    listRooms.mockImplementation(async (workspaceId: string) =>
      workspaceId === 'ws-a'
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
    listRooms.mockImplementation(async (workspaceId: string) =>
      workspaceId === 'ws-a'
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

  it('shows only the active workspace’s rooms, not every connected one’s', async () => {
    listRooms.mockImplementation(async (workspaceId: string) => [
      room(`${workspaceId}-room`, `user-of-${workspaces.serverIdFor(workspaceId)}`),
    ]);

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();
    workspaces.activeId = 'ws-b';

    expect(store.listedRoomsInActiveScope.map((r: { id: string }) => r.id)).toEqual(['ws-b-room']);
  });

  it('hides nothing when no workspace is active, matching how locations are scoped', async () => {
    listRooms.mockImplementation(async (workspaceId: string) => [
      room(`${workspaceId}-room`, `user-of-${workspaces.serverIdFor(workspaceId)}`),
    ]);

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();

    expect(store.listedRoomsInActiveScope.map((r: { id: string }) => r.id)).toEqual([
      'ws-a-room',
      'ws-b-room',
    ]);
  });

  it('keeps a workspace that failed to respond from dropping the others', async () => {
    listRooms.mockImplementation(async (workspaceId: string) => {
      if (workspaceId === 'ws-a') throw new Error('unreachable');
      return [room('ws-b-room', 'user-of-srv-b')];
    });

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();

    expect(store.listedRoomsInActiveScope.map((r: { id: string }) => r.id)).toEqual(['ws-b-room']);
  });

  it('says the room list is incomplete when a workspace could not be read', async () => {
    listRooms.mockImplementation(async (workspaceId: string) => {
      if (workspaceId === 'ws-a') throw new Error('unreachable');
      return [room('ws-b-room', 'user-of-srv-b')];
    });

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();

    expect(store.workspacesThatFailedToLoad.map((w) => w.name)).toEqual(['Alpha']);
  });

  it('asks only the active workspace for its rooms', async () => {
    workspaces.activeId = 'ws-b';
    listRooms.mockImplementation(async () => []);

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();

    expect(listRooms).toHaveBeenCalledExactlyOnceWith('ws-b');
  });

  it('does not report another workspace’s failure against the one you are viewing', async () => {
    // Each workspace is its own world. One you are not looking at being
    // unreadable says nothing about the one you are, and warning about it trains
    // you to ignore the warning.
    listRooms.mockImplementation(async (workspaceId: string) => {
      if (workspaceId === 'ws-a') throw new Error('unreachable');
      return [room('ws-b-room', 'user-of-srv-b')];
    });
    const store = new SwitchRoomsStore();

    // Search loads every workspace, so Alpha's failure is on the record...
    await store.loadRoomsInAllWorkspaces();
    expect(store.workspacesThatFailedToLoad.map((w) => w.name)).toEqual(['Alpha']);

    // ...but it must not surface while Beta is the workspace on screen.
    workspaces.activeId = 'ws-b';
    expect(store.workspacesThatFailedToLoad).toEqual([]);
    expect(store.workspacesNotSignedIn).toEqual([]);
  });

  it('does not report a signed-out workspace you are not viewing', async () => {
    workspaces.activeId = 'ws-b';
    serversStore.isConnected = (serverId: string) => serverId !== 'srv-a';
    listRooms.mockImplementation(async () => []);

    const store = new SwitchRoomsStore();
    await store.loadRoomsInAllWorkspaces();

    expect(store.workspacesNotSignedIn).toEqual([]);
    serversStore.isConnected = () => true;
  });

  it('reports a workspace it is not signed in to as needing sign-in, not as failed', async () => {
    // Signing in is an action the user takes; a retry button cannot fix it, and
    // calling it a failure sends them round in a circle.
    workspaces.activeId = 'ws-b';
    serversStore.isConnected = (serverId: string) => serverId !== 'srv-b';
    listRooms.mockImplementation(async () => []);

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();

    expect(store.workspacesNotSignedIn.map((w) => w.name)).toEqual(['Beta']);
    expect(store.workspacesThatFailedToLoad).toEqual([]);
    serversStore.isConnected = () => true;
  });

  it('marks a room’s name as blocked on sign-in when its server is signed out', async () => {
    workspaces.activeId = 'ws-a';
    serversStore.isConnected = () => false;
    listRooms.mockImplementation(async () => []);

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();

    expect(store.roomNameBlockedBySignIn('some-room')).toBe(true);
    serversStore.isConnected = () => true;
    expect(store.roomNameBlockedBySignIn('some-room')).toBe(false);
  });

  it('clears a workspace’s failure once it can be read again', async () => {
    workspaces.activeId = 'ws-a';
    listRooms.mockImplementation(async () => {
      throw new Error('unreachable');
    });
    const store = new SwitchRoomsStore();
    await store.loadRoomNames();
    expect(store.workspacesThatFailedToLoad.map((w) => w.name)).toEqual(['Alpha']);

    listRooms.mockImplementation(async () => [room('back', 'user-of-srv-a')]);
    await store.loadRoomNames();

    expect(store.workspacesThatFailedToLoad).toEqual([]);
  });
});

describe('agent memberships', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    twoWorkspaces();
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
      { workspaceId: 'ws-a', switchAgentId: 'agent-1' },
      { workspaceId: 'ws-a', switchAgentId: 'agent-2' },
    ]);

    expect(store.roomsFor('ws-a', 'agent-1')?.[0].roomId).toBe('room-of-agent-1');
    expect(store.roomsFor('ws-a', 'agent-2')?.[0].roomId).toBe('room-of-agent-2');
  });

  it('serves cached memberships without refetching, unless forced', async () => {
    const store = new SwitchRoomsStore();
    const agents = [{ workspaceId: 'ws-a', switchAgentId: 'agent-1' }];

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
      { workspaceId: 'ws-a', switchAgentId: 'agent-1' },
      { workspaceId: 'ws-a', switchAgentId: 'agent-2' },
    ]);

    expect(store.localMemberIds('shared').sort()).toEqual(['agent-1', 'agent-2']);
    expect(store.localMemberIds('only-agent-1')).toEqual(['agent-1']);
  });

  it('leaves an archived membership out of the room’s member list', async () => {
    listAgentRooms.mockImplementation(async () => [
      { roomId: 'gone', roomName: 'r', archived: true, status: 'live', roomRole: null },
    ]);
    const store = new SwitchRoomsStore();

    await store.ensureMembershipsFor([{ workspaceId: 'ws-a', switchAgentId: 'agent-1' }]);

    expect(store.localMemberIds('gone')).toEqual([]);
  });

  it('re-reads every tracked agent on refresh, not just the ones already cached', async () => {
    // An agent created after the sidebar mounted has no cache entry, so a
    // refresh keyed on the cache would never fetch it.
    listAgentRooms.mockImplementation(async ({ agentId }: { agentId: string }) => {
      if (agentId === 'agent-late') throw new Error('not yet');
      return [{ roomId: 'room-a', roomName: 'r', archived: false, status: 'live', roomRole: null }];
    });
    listRooms.mockImplementation(async () => []);
    const store = new SwitchRoomsStore();
    await store.ensureMembershipsFor([
      { workspaceId: 'ws-a', switchAgentId: 'agent-1' },
      { workspaceId: 'ws-a', switchAgentId: 'agent-late' },
    ]);
    expect(store.roomsFor('ws-a', 'agent-late')).toBeUndefined();

    listAgentRooms.mockImplementation(async () => [
      { roomId: 'room-b', roomName: 'r', archived: false, status: 'live', roomRole: null },
    ]);
    await store.refreshRoomState();

    expect(store.roomsFor('ws-a', 'agent-late')?.[0].roomId).toBe('room-b');
  });

  it('reports an agent whose membership failed as unknown, not as in no rooms', async () => {
    listAgentRooms.mockImplementation(async ({ agentId }: { agentId: string }) => {
      if (agentId === 'agent-1') throw new Error('nope');
      return [{ roomId: 'room-b', roomName: 'r', archived: false, status: 'live', roomRole: null }];
    });
    const store = new SwitchRoomsStore();

    await store.ensureMembershipsFor([
      { workspaceId: 'ws-a', switchAgentId: 'agent-1' },
      { workspaceId: 'ws-a', switchAgentId: 'agent-2' },
    ]);

    expect(store.agentsWithUnknownMembership).toBe(1);
  });

  it('reports no unknown memberships once every tracked agent has loaded', async () => {
    const store = new SwitchRoomsStore();

    await store.ensureMembershipsFor([
      { workspaceId: 'ws-a', switchAgentId: 'agent-1' },
      { workspaceId: 'ws-a', switchAgentId: 'agent-2' },
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
      { workspaceId: 'ws-a', switchAgentId: 'agent-1' },
      { workspaceId: 'ws-a', switchAgentId: 'agent-2' },
    ]);

    expect(store.roomsFor('ws-a', 'agent-1')).toBeUndefined();
    expect(store.errorFor('ws-a', 'agent-1')).toBe(
      'Could not load the rooms this agent belongs to. (nope)'
    );
    expect(store.roomsFor('ws-a', 'agent-2')?.[0].roomId).toBe('room-b');
  });

  it('keeps the same agent’s membership in two workspaces apart', async () => {
    // One server can host several, and an agent id is the server's — so a cache
    // keyed on the agent alone would answer one workspace with the other's rooms.
    listAgentRooms.mockImplementation(async ({ workspaceId }: { workspaceId: string }) => [
      {
        roomId: `room-in-${workspaceId}`,
        roomName: 'r',
        archived: false,
        status: 'live',
        roomRole: null,
      },
    ]);
    const store = new SwitchRoomsStore();

    await store.ensureMembershipsFor([
      { workspaceId: 'ws-a', switchAgentId: 'agent-1' },
      { workspaceId: 'ws-b', switchAgentId: 'agent-1' },
    ]);

    expect(store.roomsFor('ws-a', 'agent-1')?.[0].roomId).toBe('room-in-ws-a');
    expect(store.roomsFor('ws-b', 'agent-1')?.[0].roomId).toBe('room-in-ws-b');
  });
});

describe('rooms offered to a picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serversStore.servers = [{ id: 'srv-a' }];
    workspaces.workspaces = [{ id: 'ws-a', serverId: 'srv-a', name: 'Alpha' }];
    workspaces.activeId = 'ws-a';
  });

  it('offers every room the workspace returned, not only the ones this user made', async () => {
    // The sidebar deliberately lists a narrower set — see `listedRoomsInWorkspace`.
    // A picker is a list you went looking for, so it must not hide a room you
    // are entitled to join.
    listRooms.mockResolvedValue([
      room('mine', 'user-of-srv-a'),
      room('someone-elses', 'user-of-someone-else'),
      room('ownerless', null),
    ]);

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();

    expect(store.readableRoomsInWorkspace('ws-a').map((r) => r.id)).toEqual([
      'mine',
      'someone-elses',
      'ownerless',
    ]);
    expect(store.listedRoomsInWorkspace('ws-a').map((r) => r.id)).toEqual(['mine']);
  });

  it('leaves out archived rooms, which are not joinable', async () => {
    listRooms.mockResolvedValue([
      room('live', 'user-of-someone-else'),
      room('gone', 'user-of-someone-else', { archived: true }),
    ]);

    const store = new SwitchRoomsStore();
    await store.loadRoomNames();

    expect(store.readableRoomsInWorkspace('ws-a').map((r) => r.id)).toEqual(['live']);
  });

  it('offers nothing for a workspace whose rooms were never read', () => {
    expect(new SwitchRoomsStore().readableRoomsInWorkspace('ws-a')).toEqual([]);
  });
});

describe('who may delete a room', () => {
  const statusWithRole = (role: string | undefined) => (serverId: string) => ({
    user: { id: `user-of-${serverId}`, role },
  });
  const originalStatusFor = serversStore.statusFor;

  beforeEach(() => {
    vi.clearAllMocks();
    serversStore.servers = [{ id: 'srv-a' }];
    workspaces.workspaces = [{ id: 'ws-a', serverId: 'srv-a', name: 'Alpha' }];
    serversStore.statusFor = statusWithRole(undefined);
  });

  afterEach(() => {
    serversStore.statusFor = originalStatusFor;
  });

  it('lets the owner delete their own room', () => {
    const store = new SwitchRoomsStore();
    expect(store.canDeleteRoom('ws-a', room('r', 'user-of-srv-a'))).toBe(true);
  });

  it('refuses someone else’s room', () => {
    const store = new SwitchRoomsStore();
    expect(store.canDeleteRoom('ws-a', room('r', 'user-of-someone-else'))).toBe(false);
  });

  it('lets an admin delete a room they do not own, matching the gateway', () => {
    serversStore.statusFor = statusWithRole('admin');
    const store = new SwitchRoomsStore();
    expect(store.canDeleteRoom('ws-a', room('r', 'user-of-someone-else'))).toBe(true);
  });

  it('refuses an ownerless room to a non-admin, rather than treating it as unclaimed', () => {
    const store = new SwitchRoomsStore();
    expect(store.canDeleteRoom('ws-a', room('r', null))).toBe(false);
  });

  it('refuses while signed out, when there is no one to compare against', () => {
    serversStore.statusFor = () => ({ user: null }) as never;
    const store = new SwitchRoomsStore();
    expect(store.canDeleteRoom('ws-a', room('r', 'user-of-srv-a'))).toBe(false);
  });

  it('refuses a workspace whose server is not known yet', () => {
    // The permission is the server's to answer, so an unresolved workspace is
    // not a licence to offer the action.
    workspaces.workspaces = [];
    const store = new SwitchRoomsStore();
    expect(store.canDeleteRoom('ws-a', room('r', 'user-of-srv-a'))).toBe(false);
  });
});
