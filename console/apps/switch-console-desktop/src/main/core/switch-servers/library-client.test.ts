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
  createLibraryItem,
  deleteLibraryItem,
  fetchLibraryItem,
  fetchLibraryItemRooms,
  fetchLibraryItems,
  fetchReferenceTypes,
  updateLibraryItem,
  addPackageMember,
  fetchPackageMembers,
  removePackageMember,
  createReferenceType,
  deleteReferenceType,
  fetchManagedReferenceTypes,
  updateReferenceType,
} = await import('./library-client');

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

/** A gateway `ReferenceDetail` with every field the client reads. */
const REFERENCE = {
  id: 'ref-1',
  owner_id: 'u1',
  owner_name: 'Ada',
  read_visibility: 'public',
  write_visibility: 'private',
  type: 'github',
  type_display_name: 'GitHub',
  name: 'Switch repo',
  description: 'The code',
  instructions: 'Read the README first',
  value: { urls: ['https://github.com/acme/switch'] },
  attached_rooms_count: 2,
  packages: ['pkg-1'],
  created_at: '2026-11-01T09:00:00+00:00',
};

const DOCUMENT = {
  id: 'doc-1',
  owner_id: 'u2',
  owner_name: null,
  read_visibility: 'private',
  write_visibility: 'private',
  name: 'Style guide',
  description: '',
  instructions: '',
  content: '# Style',
  attached_rooms_count: 0,
  packages: [],
  scope: 'global',
  created_at: '2026-11-01T09:00:00+00:00',
};

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(REFERENCE));

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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading the library', () => {
  it('maps a reference with its owner, access, type and links', async () => {
    fetchMock.mockImplementation(async () => jsonResponse([REFERENCE]));
    const [item] = await fetchLibraryItems(SERVER, 'references');
    expect(lastCall().url).toMatch(/\/gateway\/references$/);
    expect(item).toEqual({
      id: 'ref-1',
      kind: 'references',
      name: 'Switch repo',
      description: 'The code',
      instructions: 'Read the README first',
      ownerId: 'u1',
      ownerName: 'Ada',
      readVisibility: 'public',
      writeVisibility: 'private',
      type: 'github',
      typeLabel: 'GitHub',
      urls: ['https://github.com/acme/switch'],
      attachedRoomsCount: 2,
      packageIds: ['pkg-1'],
      referencesCount: 0,
      documentsCount: 0,
      createdAt: '2026-11-01T09:00:00+00:00',
    });
  });

  it('leaves agents’ room-only documents out of the library', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([DOCUMENT, { ...DOCUMENT, id: 'doc-2', scope: 'room' }])
    );
    const items = await fetchLibraryItems(SERVER, 'documents');
    expect(items.map((d) => d.id)).toEqual(['doc-1']);
    expect(items[0]).toMatchObject({ type: null, typeLabel: null, urls: [], ownerName: null });
  });

  it('reads a document with its content', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(DOCUMENT));
    const doc = await fetchLibraryItem(SERVER, 'documents', 'doc-1');
    expect(lastCall().url).toMatch(/\/gateway\/documents\/doc-1$/);
    expect(doc).toMatchObject({ id: 'doc-1', content: '# Style' });
  });

  it('keeps the count of rooms the owner cannot open, and leaves it unset when the server does not say', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([
        { ...REFERENCE, hidden_rooms_count: 2 },
        { ...REFERENCE, id: 'ref-2' },
      ])
    );
    const [counted, older] = await fetchLibraryItems(SERVER, 'references');
    expect(counted.hiddenRoomsCount).toBe(2);
    expect(older).not.toHaveProperty('hiddenRoomsCount');
  });

  it('keeps what the server says the viewer may do, and leaves it unset when it does not say', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([
        { ...REFERENCE, can_read: false, can_edit: true, can_manage: false },
        { ...REFERENCE, id: 'ref-2' },
      ])
    );
    const [told, older] = await fetchLibraryItems(SERVER, 'references');
    expect(told).toMatchObject({ canRead: false, canEdit: true, canManage: false });
    expect(older).not.toHaveProperty('canRead');
    expect(older).not.toHaveProperty('canEdit');
    expect(older).not.toHaveProperty('canManage');
  });

  it('keeps the server’s word on detaching from each room, when it gives one', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([
        { room_id: 'room-1', room_name: 'design', can_unlink: false },
        { room_id: 'room-2', room_name: 'support' },
      ])
    );
    expect(await fetchLibraryItemRooms(SERVER, 'references', 'ref-1')).toEqual([
      { roomId: 'room-1', roomName: 'design', canUnlink: false },
      { roomId: 'room-2', roomName: 'support' },
    ]);
  });

  it('lists the rooms an item is in', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([{ room_id: 'room-1', room_name: 'design' }])
    );
    expect(await fetchLibraryItemRooms(SERVER, 'references', 'ref-1')).toEqual([
      { roomId: 'room-1', roomName: 'design' },
    ]);
    expect(lastCall().url).toMatch(/\/gateway\/references\/ref-1\/rooms$/);
  });

  it('offers Switch’s own reference types first, then people’s, by name', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([
        {
          type: 'wiki',
          display_name: 'Wiki',
          value_hint: 'Pages',
          is_builtin: false,
          owner_name: 'Bo',
        },
        { type: 'github', display_name: 'GitHub', value_hint: 'Repos', is_builtin: true },
        { type: 'confluence', display_name: 'Confluence', value_hint: null, is_builtin: true },
      ])
    );
    const types = await fetchReferenceTypes(SERVER);
    expect(types.map((t) => t.type)).toEqual(['confluence', 'github', 'wiki']);
    expect(types[2]).toEqual({
      type: 'wiki',
      displayName: 'Wiki',
      instructions: '',
      valueHint: 'Pages',
      isBuiltin: false,
      ownerName: 'Bo',
      ownerId: null,
    });
  });
});

describe('changing the library', () => {
  it('creates a reference with its type and links as the value', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(REFERENCE));
    await createLibraryItem(SERVER, 'references', {
      name: 'Switch repo',
      description: 'The code',
      instructions: '',
      readVisibility: 'public',
      writeVisibility: 'private',
      type: 'github',
      urls: ['https://github.com/acme/switch'],
    });
    expect(lastCall()).toEqual({
      url: expect.stringMatching(/\/gateway\/references$/),
      method: 'POST',
      body: {
        name: 'Switch repo',
        description: 'The code',
        instructions: '',
        read_visibility: 'public',
        write_visibility: 'private',
        type: 'github',
        value: { urls: ['https://github.com/acme/switch'] },
      },
    });
  });

  it('creates a document with its content and nothing of a reference’s', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(DOCUMENT));
    await createLibraryItem(SERVER, 'documents', {
      name: 'Style guide',
      description: '',
      instructions: '',
      readVisibility: 'private',
      writeVisibility: 'private',
      content: '# Style',
    });
    expect(lastCall().body).toEqual({
      name: 'Style guide',
      description: '',
      instructions: '',
      read_visibility: 'private',
      write_visibility: 'private',
      content: '# Style',
    });
  });

  it('sends only the fields that changed', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(DOCUMENT));
    await updateLibraryItem(SERVER, 'documents', 'doc-1', { content: '# New' });
    expect(lastCall()).toEqual({
      url: expect.stringMatching(/\/gateway\/documents\/doc-1$/),
      method: 'PATCH',
      body: { content: '# New' },
    });
  });

  it('reports what deleting took with it', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        deleted_id: 'ref-1',
        detached_room_ids: ['room-1'],
        affected_package_ids: ['pkg-1'],
      })
    );
    expect(await deleteLibraryItem(SERVER, 'references', 'ref-1')).toEqual({
      detachedRoomIds: ['room-1'],
      affectedPackageIds: ['pkg-1'],
    });
    expect(lastCall()).toMatchObject({ method: 'DELETE' });
  });
});

describe('packages', () => {
  const PACKAGE = {
    id: 'pkg-1',
    owner_id: 'u1',
    owner_name: 'Ada',
    read_visibility: 'public',
    write_visibility: 'private',
    name: 'Onboarding',
    description: 'Everything a new agent needs',
    instructions: '',
    references_count: 2,
    documents_count: 1,
    attached_rooms_count: 3,
    created_at: '2026-11-01T09:00:00+00:00',
  };

  it('reads what a package holds, by kind, and a package’s counts', async () => {
    fetchMock.mockImplementation(async () => jsonResponse([PACKAGE]));
    const [pkg] = await fetchLibraryItems(SERVER, 'packages');
    expect(pkg).toMatchObject({
      kind: 'packages',
      referencesCount: 2,
      documentsCount: 1,
      type: null,
    });

    fetchMock.mockImplementation(async () => jsonResponse([REFERENCE]));
    const members = await fetchPackageMembers(SERVER, 'pkg-1', 'references');
    expect(lastCall().url).toMatch(/\/gateway\/packages\/pkg-1\/references$/);
    expect(members[0]).toMatchObject({ id: 'ref-1', kind: 'references', typeLabel: 'GitHub' });
  });

  it('creates a package with nothing of a reference’s or a document’s', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(PACKAGE));
    await createLibraryItem(SERVER, 'packages', {
      name: 'Onboarding',
      description: '',
      instructions: '',
      readVisibility: 'public',
      writeVisibility: 'private',
    });
    expect(lastCall().body).toEqual({
      name: 'Onboarding',
      description: '',
      instructions: '',
      read_visibility: 'public',
      write_visibility: 'private',
    });
  });

  it('adds with a POST and removes with a DELETE on the member’s path, saying which rooms lost it', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}));
    await addPackageMember(SERVER, 'pkg-1', 'documents', 'doc-1');
    expect(lastCall()).toMatchObject({ method: 'POST' });
    expect(lastCall().url).toMatch(/\/packages\/pkg-1\/documents\/doc-1$/);

    fetchMock.mockImplementation(async () =>
      jsonResponse({
        package_id: 'pkg-1',
        member_id: 'doc-1',
        affected_room_ids: ['r1', 'r2'],
        affected_room_names: ['design'],
        hidden_affected_rooms_count: 1,
      })
    );
    expect(await removePackageMember(SERVER, 'pkg-1', 'documents', 'doc-1')).toEqual({
      affectedRoomNames: ['design'],
      hiddenAffectedRoomsCount: 1,
    });
    expect(lastCall()).toMatchObject({ method: 'DELETE' });
  });

  it('counts no private rooms when an older server does not', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ affected_room_ids: [], affected_room_names: [] })
    );
    expect(await removePackageMember(SERVER, 'pkg-1', 'references', 'ref-1')).toEqual({
      affectedRoomNames: [],
      hiddenAffectedRoomsCount: 0,
    });
  });
});

describe('reference types', () => {
  const OWNED = {
    type: 'linear',
    display_name: 'Linear',
    instructions: 'Use the Linear connector.',
    value_schema: {},
    value_hint: 'Issue links',
    is_builtin: false,
    owner_id: 'u1',
    owner_name: 'Ada',
    read_visibility: 'public',
    write_visibility: 'private',
    shadowed_by_builtin: false,
    created_at: '2026-11-05T09:00:00+00:00',
  };

  it('reads the types the viewer may change, with their access', async () => {
    fetchMock.mockImplementation(async () => jsonResponse([OWNED]));
    const [type] = await fetchManagedReferenceTypes(SERVER);
    expect(lastCall().url).toMatch(/\/gateway\/references\/reference-types\/owned$/);
    expect(type).toMatchObject({
      type: 'linear',
      displayName: 'Linear',
      instructions: 'Use the Linear connector.',
      ownerId: 'u1',
      readVisibility: 'public',
      writeVisibility: 'private',
      shadowedByBuiltin: false,
    });
  });

  it('creates one with its slug, and changes only what is given', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(OWNED));
    await createReferenceType(SERVER, {
      type: 'linear',
      displayName: 'Linear',
      instructions: 'Use the Linear connector.',
      valueHint: 'Issue links',
      readVisibility: 'public',
      writeVisibility: 'private',
    });
    expect(lastCall()).toEqual({
      url: expect.stringMatching(/\/gateway\/references\/reference-types$/),
      method: 'POST',
      body: {
        type: 'linear',
        display_name: 'Linear',
        instructions: 'Use the Linear connector.',
        value_hint: 'Issue links',
        read_visibility: 'public',
        write_visibility: 'private',
      },
    });
    await updateReferenceType(SERVER, 'linear', { valueHint: 'Links to issues' });
    expect(lastCall()).toEqual({
      url: expect.stringMatching(/\/reference-types\/linear$/),
      method: 'PATCH',
      body: { value_hint: 'Links to issues' },
    });
  });

  it('deletes one by its slug', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ deleted_type: 'linear' }));
    await deleteReferenceType(SERVER, 'linear');
    expect(lastCall()).toMatchObject({ method: 'DELETE' });
    expect(lastCall().url).toMatch(/\/reference-types\/linear$/);
  });
});
