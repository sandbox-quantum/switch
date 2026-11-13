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
  addLinkedRoom,
  addRoomUsers,
  fetchLibrary,
  fetchLinkedRooms,
  fetchRoomDocument,
  fetchRoomResources,
  removeLinkedRoom,
  setRoomResourceAttached,
  createRoomRole,
  deleteRoomRole,
  fetchArchivedRooms,
  fetchRoomAgentCandidates,
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

describe('what the server says the caller may do', () => {
  it('carries the server’s own answer when it gives one', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ ...ROOM, can_write: true, can_manage: false })
    );
    const room = await fetchRoomDetail(SERVER, 'room-1');
    // A server from before detaching, or before fixed membership, had its own
    // rule for each: it took write access.
    expect(room.serverPermissions).toEqual({
      canWrite: true,
      canChangeMembers: true,
      canInviteAgents: true,
      canAddPeople: true,
      canAttach: true,
      canRemoveMembers: true,
      canManage: false,
      canUnlink: true,
    });
  });

  it('carries that a direct conversation’s members are not the caller’s to change', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        ...ROOM,
        channel_type: 'direct',
        can_write: true,
        can_change_members: false,
        can_manage: true,
        can_unlink: true,
      })
    );
    expect((await fetchRoomDetail(SERVER, 'room-1')).serverPermissions).toEqual({
      canWrite: true,
      canChangeMembers: false,
      canInviteAgents: false,
      canAddPeople: false,
      canAttach: true,
      canRemoveMembers: false,
      canManage: true,
      canUnlink: true,
    });
  });

  it('carries who may bring agents in when the server says, apart from write access', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        ...ROOM,
        can_write: false,
        can_change_members: false,
        can_invite_agents: true,
        can_manage: false,
        can_unlink: true,
      })
    );
    expect((await fetchRoomDetail(SERVER, 'room-1')).serverPermissions).toEqual({
      canWrite: false,
      canChangeMembers: false,
      canInviteAgents: true,
      canAddPeople: false,
      canAttach: false,
      canRemoveMembers: false,
      canManage: false,
      canUnlink: true,
    });
  });

  it('carries the room policy’s separate flags for adding, attaching and removing', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        ...ROOM,
        can_write: false,
        can_change_members: false,
        can_invite_agents: true,
        can_add_people: true,
        can_attach: true,
        can_remove_members: false,
        can_manage: false,
        can_unlink: false,
      })
    );
    expect((await fetchRoomDetail(SERVER, 'room-1')).serverPermissions).toEqual({
      canWrite: false,
      canChangeMembers: false,
      canInviteAgents: true,
      canAddPeople: true,
      canAttach: true,
      canRemoveMembers: false,
      canManage: false,
      canUnlink: false,
    });
  });

  it('carries who may detach and delete when the server says', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ ...ROOM, can_write: true, can_manage: false, can_unlink: false })
    );
    expect((await fetchRoomDetail(SERVER, 'room-1')).serverPermissions).toEqual({
      canWrite: true,
      canChangeMembers: true,
      canInviteAgents: true,
      canAddPeople: true,
      canAttach: true,
      canRemoveMembers: true,
      canManage: false,
      canUnlink: false,
    });
    fetchMock.mockImplementation(async () =>
      jsonResponse([
        { id: 'd-1', name: 'Notes', description: '', scope: 'room', can_remove: false },
      ])
    );
    expect((await fetchRoomResources(SERVER, 'room-1', 'documents'))[0]!.canRemove).toBe(false);
  });

  it('leaves it out for a server that does not say, so Console works it out', async () => {
    const room = await fetchRoomDetail(SERVER, 'room-1');
    expect(room.serverPermissions).toBeUndefined();
  });
});

describe('room writes', () => {
  it('sends a visibility change in the server’s field names', async () => {
    await updateRoom(SERVER, 'room-1', { readVisibility: 'private' });
    // Private write too: an older server refuses private-read, public-write.
    expect(lastCall()).toMatchObject({
      method: 'PATCH',
      body: { read_visibility: 'private', write_visibility: 'private' },
    });

    await updateRoom(SERVER, 'room-1', { readVisibility: 'public' });
    expect(lastCall().body).toEqual({ read_visibility: 'public' });
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
});

describe('room resources', () => {
  it('lists a room’s references with their type, links and the packages that brought them', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([
        {
          id: 'ref-1',
          name: 'Repo',
          description: 'The code',
          type: 'github',
          type_display_name: 'GitHub',
          value: { urls: ['https://github.com/acme/repo', 7] },
          packages: ['pkg-1'],
        },
      ])
    );
    const [ref] = await fetchRoomResources(SERVER, 'room-1', 'references');
    expect(lastCall().url).toMatch(/\/gateway\/rooms\/room-1\/references$/);
    expect(ref).toEqual({
      id: 'ref-1',
      kind: 'references',
      name: 'Repo',
      description: 'The code',
      typeLabel: 'GitHub',
      urls: ['https://github.com/acme/repo'],
      roomScoped: false,
      createdByAgentName: null,
      packageIds: ['pkg-1'],
      ownerId: null,
      readVisibility: 'private',
    });
  });

  it('tells a document an agent wrote in the room from one in the library', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([
        { id: 'd-1', name: 'Notes', description: '', scope: 'room', created_by_agent_name: 'bot' },
        { id: 'd-2', name: 'Guide', description: '', scope: 'global' },
      ])
    );
    const docs = await fetchRoomResources(SERVER, 'room-1', 'documents');
    expect(docs.map((d) => [d.id, d.roomScoped, d.createdByAgentName])).toEqual([
      ['d-1', true, 'bot'],
      ['d-2', false, null],
    ]);
  });

  it('offers only the library’s own documents for attaching', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([
        { id: 'd-1', name: 'Notes', description: '', scope: 'room' },
        { id: 'd-2', name: 'Guide', description: '', scope: 'global' },
      ])
    );
    const library = await fetchLibrary(SERVER, 'documents');
    expect(lastCall().url).toMatch(/\/gateway\/documents$/);
    expect(library.map((d) => d.id)).toEqual(['d-2']);
  });

  it('attaches with a POST and detaches with a DELETE on the item’s room path', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}));
    await setRoomResourceAttached(SERVER, 'room-1', 'packages', 'pkg-1', true);
    expect(lastCall()).toMatchObject({ method: 'POST' });
    expect(lastCall().url).toMatch(/\/rooms\/room-1\/packages\/pkg-1$/);
    await setRoomResourceAttached(SERVER, 'room-1', 'packages', 'pkg-1', false);
    expect(lastCall()).toMatchObject({ method: 'DELETE' });
  });

  it('reads a document in full through the room', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ id: 'd-1', name: 'Notes', description: 'Ours', content: '# Hi' })
    );
    expect(await fetchRoomDocument(SERVER, 'room-1', 'd-1')).toEqual({
      id: 'd-1',
      name: 'Notes',
      description: 'Ours',
      content: '# Hi',
    });
    expect(lastCall().url).toMatch(/\/rooms\/room-1\/documents\/d-1$/);
  });
});

describe('linked rooms', () => {
  const LINK = {
    target_room_id: 'room-2',
    target_room_name: 'support',
    target_room_description: 'Help desk',
    label: 'escalate to',
  };

  it('lists, adds and removes the rooms a room points at', async () => {
    fetchMock.mockImplementation(async () => jsonResponse([LINK]));
    expect(await fetchLinkedRooms(SERVER, 'room-1')).toEqual([
      { roomId: 'room-2', name: 'support', description: 'Help desk', label: 'escalate to' },
    ]);
    fetchMock.mockImplementation(async () => jsonResponse(LINK));
    await addLinkedRoom(SERVER, 'room-1', 'room-2', 'escalate to');
    expect(lastCall()).toMatchObject({
      method: 'POST',
      body: { target_room_id: 'room-2', label: 'escalate to' },
    });
    await removeLinkedRoom(SERVER, 'room-1', 'room-2');
    expect(lastCall()).toMatchObject({ method: 'DELETE' });
    expect(lastCall().url).toMatch(/\/rooms\/room-1\/linked-rooms\/room-2$/);
  });
});

describe('the agents a person may bring in', () => {
  it('asks for a room, or for a new room, and reads the ids', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ agent_ids: ['a-1', 'a-2'] }));
    expect(await fetchRoomAgentCandidates(SERVER, 'room 1')).toEqual(['a-1', 'a-2']);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
      '/rooms/agent-candidates?room_id=room%201'
    );
    await fetchRoomAgentCandidates(SERVER, null);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toMatch(/\/rooms\/agent-candidates$/);
  });

  it('answers null from a server from before the list, so every agent is offered', async () => {
    fetchMock.mockImplementation(
      async () =>
        ({
          status: 404,
          ok: false,
          json: async () => ({ detail: 'Room not found' }),
          headers: { get: () => null, getSetCookie: () => [] },
          text: async () => JSON.stringify({ detail: 'Room not found' }),
        }) as unknown as Response
    );
    expect(await fetchRoomAgentCandidates(SERVER, null)).toBeNull();
  });
});
