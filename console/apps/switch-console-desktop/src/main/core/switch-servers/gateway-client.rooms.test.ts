import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionCookie = vi.hoisted(() => vi.fn());

vi.mock('@main/core/managed-switch-server/managed-server-status', () => ({
  managedServerHostBlocked: () => null,
  managedServerStoppedPhase: () => null,
  noteManagedServerUnanswered: () => undefined,
}));
vi.mock('./servers-store', () => ({ getSessionCookie, setSessionCookie: vi.fn() }));
vi.mock('./auth', () => ({
  refreshSession: vi.fn(),
  reauthenticateManagedServer: vi.fn(),
  extractAuthCookie: () => null,
}));
vi.mock('./console-identity', () => ({ consoleIdentityHeaders: async () => ({}) }));

const {
  addRoomUsers,
  createRoomRole,
  deleteRoomRole,
  fetchArchivedRooms,
  fetchBridgeUserNames,
  fetchRoomDetail,
  setRoomAgentJoinEvents,
  setRoomArchived,
  setRoomGroup,
  updateRoom,
  updateRoomRole,
} = await import('./gateway-client');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  url: 'https://switch.example.com',
  dashboardUrl: null,
  managed: false,
} as never;

function makeJwt(secondsFromNow: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow;
  const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function jsonResponse(body: unknown): Response {
  return {
    status: 200,
    ok: true,
    json: async () => body,
    headers: { get: () => null, getSetCookie: () => [] },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A gateway `RoomDetail` with every field this client reads. */
const ROOM = {
  id: 'room-1',
  name: 'design-review',
  description: 'Where we review designs',
  channel_type: 'channel_public',
  agent_count: 2,
  bridge_display_name: 'Acme Slack',
  bridge_type: 'slack',
  bridge_id: 'bridge-1',
  owner_id: 'u1',
  owner_name: 'Ada',
  read_visibility: 'public',
  write_visibility: 'private',
  group_id: 'g-1',
  group_name: 'Design',
  archived: false,
  archived_at: null,
  created_at: '2026-10-01T09:00:00+00:00',
  instructions: 'Be kind',
  agent_ids: ['a-1', 'a-2'],
  agent_statuses: { 'a-1': 'live', 'a-2': 'no_session' },
  roles: [{ name: 'reviewer', instructions: 'Review', exclusive: true, held_by: ['bot-a'] }],
  join_event_listeners: ['a-1'],
  connected_user_names: ['ada', 'bob'],
  external_channel_id: 'C123',
  transport_room_id: '!abc:switch.local',
  linked_channel_name: 'design-review',
};

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(ROOM));

function lastCall(): { url: string; method: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit | undefined];
  return {
    url,
    method: init?.method ?? 'GET',
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionCookie.mockResolvedValue(makeJwt(2 * 60 * 60));
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async () => jsonResponse(ROOM));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchRoomDetail', () => {
  it('maps the settings the room page shows', async () => {
    const room = await fetchRoomDetail(SERVER, 'room-1');
    expect(room).toMatchObject({
      readVisibility: 'public',
      writeVisibility: 'private',
      groupId: 'g-1',
      groupName: 'Design',
      ownerName: 'Ada',
      bridgeId: 'bridge-1',
      agentStatuses: { 'a-1': 'live', 'a-2': 'no_session' },
      roles: [{ name: 'reviewer', instructions: 'Review', exclusive: true, heldBy: ['bot-a'] }],
      joinEventListeners: ['a-1'],
      externalChannelId: 'C123',
      transportRoomId: '!abc:switch.local',
      archivedAt: null,
    });
  });

  it('reads a server that predates the settings as an open, ungrouped room', async () => {
    const {
      read_visibility: _r,
      write_visibility: _w,
      group_id: _g,
      roles: _roles,
      agent_statuses: _s,
      ...old
    } = ROOM;
    fetchMock.mockImplementation(async () => jsonResponse(old));
    const room = await fetchRoomDetail(SERVER, 'room-1');
    expect(room).toMatchObject({
      readVisibility: 'public',
      writeVisibility: 'public',
      groupId: null,
      roles: [],
      agentStatuses: {},
    });
  });
});

describe('room writes', () => {
  it('sends a visibility change in the server’s field names', async () => {
    await updateRoom(SERVER, 'room-1', { readVisibility: 'private', writeVisibility: 'private' });
    expect(lastCall()).toMatchObject({
      method: 'PATCH',
      body: { read_visibility: 'private', write_visibility: 'private' },
    });
    expect(lastCall().url).toMatch(/\/rooms\/room-1$/);
  });

  it('leaves visibility out of a plain description change', async () => {
    await updateRoom(SERVER, 'room-1', { description: 'x' });
    expect(lastCall().body).toEqual({ description: 'x' });
  });

  it('files a room under a group, and takes it out with null', async () => {
    await setRoomGroup(SERVER, 'room-1', 'g-2');
    expect(lastCall()).toMatchObject({ method: 'PUT', body: { group_id: 'g-2' } });
    expect(lastCall().url).toMatch(/\/rooms\/room-1\/group$/);
    await setRoomGroup(SERVER, 'room-1', null);
    expect(lastCall().body).toEqual({ group_id: null });
  });

  it('toggles one agent’s join events', async () => {
    await setRoomAgentJoinEvents(SERVER, 'room-1', 'a-2', true);
    expect(lastCall()).toMatchObject({ method: 'PATCH', body: { receives_join_events: true } });
    expect(lastCall().url).toMatch(/\/rooms\/room-1\/agents\/a-2$/);
  });

  it('invites people by username', async () => {
    await addRoomUsers(SERVER, 'room-1', ['carol']);
    expect(lastCall()).toMatchObject({ method: 'POST', body: { user_names: ['carol'] } });
    expect(lastCall().url).toMatch(/\/rooms\/room-1\/users$/);
  });

  it('archives and unarchives through their own routes', async () => {
    await setRoomArchived(SERVER, 'room-1', true);
    expect(lastCall()).toMatchObject({ method: 'POST' });
    expect(lastCall().url).toMatch(/\/rooms\/room-1\/archive$/);
    await setRoomArchived(SERVER, 'room-1', false);
    expect(lastCall().url).toMatch(/\/rooms\/room-1\/unarchive$/);
  });
});

describe('room roles', () => {
  const ROLES = [{ name: 'reviewer', instructions: 'Review', exclusive: false, held_by: [] }];

  it('creates, edits and deletes a role, reading back the room’s roles each time', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(ROLES));
    await expect(
      createRoomRole(SERVER, 'room-1', {
        name: 'reviewer',
        instructions: 'Review',
        exclusive: false,
      })
    ).resolves.toEqual([
      { name: 'reviewer', instructions: 'Review', exclusive: false, heldBy: [] },
    ]);
    expect(lastCall()).toMatchObject({
      method: 'POST',
      body: { name: 'reviewer', instructions: 'Review', exclusive: false },
    });

    await updateRoomRole(SERVER, 'room-1', 'code reviewer', { exclusive: true });
    expect(lastCall()).toMatchObject({ method: 'PATCH', body: { exclusive: true } });
    expect(lastCall().url).toMatch(/\/rooms\/room-1\/roles\/code%20reviewer$/);

    await deleteRoomRole(SERVER, 'room-1', 'reviewer');
    expect(lastCall()).toMatchObject({ method: 'DELETE' });
  });
});

describe('room lists', () => {
  it('asks for archived rooms and keeps only those', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([
        { ...ROOM, id: 'live', archived: false },
        { ...ROOM, id: 'old', archived: true },
      ])
    );
    const rooms = await fetchArchivedRooms(SERVER);
    expect(lastCall().url).toMatch(/\/rooms\?include_archived=true$/);
    expect(rooms.map((room) => room.id)).toEqual(['old']);
  });

  it('lists a bridge’s usernames once each, sorted', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([
        { id: '1', external_username: 'carol' },
        { id: '2', external_username: 'ada' },
        { id: '3', external_username: 'carol' },
      ])
    );
    await expect(fetchBridgeUserNames(SERVER, 'bridge-1')).resolves.toEqual(['ada', 'carol']);
    expect(lastCall().url).toMatch(/\/collaborations\/bridge-1\/users$/);
  });
});
