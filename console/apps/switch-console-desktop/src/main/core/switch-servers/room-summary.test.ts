import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionCookie = vi.hoisted(() => vi.fn());
const refreshSession = vi.hoisted(() => vi.fn());
const reauthenticateManagedServer = vi.hoisted(() => vi.fn());

const managedServerHostBlocked = vi.hoisted(() => vi.fn(() => null));
const managedServerStoppedPhase = vi.hoisted(() => vi.fn(() => null));
const noteManagedServerUnanswered = vi.hoisted(() => vi.fn());

vi.mock('@main/core/managed-switch-server/managed-server-status', () => ({
  managedServerHostBlocked,
  managedServerStoppedPhase,
  noteManagedServerUnanswered,
}));

vi.mock('./servers-store', () => ({ getSessionCookie }));
vi.mock('./auth', () => ({ refreshSession, reauthenticateManagedServer }));
vi.mock('./console-identity', () => ({ consoleIdentityHeaders: async () => ({}) }));

const { fetchRooms } = await import('./gateway-client');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  url: 'https://switch.example.com',
  managed: false,
} as never;

/** A far-from-expiry JWT, so no renewal path is exercised here. */
function validJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
  const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function response(body: unknown): Response {
  return {
    status: 200,
    ok: true,
    json: async () => body,
    headers: { get: () => null, getSetCookie: () => [] },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const BASE = {
  id: 'room-1',
  name: 'launch-review',
  description: 'Launch checks',
  channel_type: 'channel_private',
  agent_count: 2,
  bridge_display_name: 'Acme Slack',
  bridge_type: 'slack',
  archived: false,
  created_at: '2026-01-01T00:00:00Z',
};

const fetchMock = vi.fn();

describe('the room list as Console reads it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(validJwt());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('carries what the Rooms page shows: connection, group, owner, access and people', async () => {
    fetchMock.mockResolvedValue(
      response([
        {
          ...BASE,
          bridge_id: 'b-acme',
          group_id: 'g1',
          group_name: 'Design',
          owner_id: 'u2',
          owner_name: 'Max Tam',
          read_visibility: 'public',
          write_visibility: 'private',
          connected_user_count: 4,
          viewer_is_member: true,
          people_are_members: false,
          can_write: false,
          can_manage: false,
        },
      ])
    );

    const [room] = await fetchRooms(SERVER);
    expect(room).toMatchObject({
      bridgeId: 'b-acme',
      groupId: 'g1',
      groupName: 'Design',
      ownerName: 'Max Tam',
      readVisibility: 'public',
      writeVisibility: 'private',
      connectedUserCount: 4,
      viewerIsMember: true,
      peopleAreMembers: false,
      serverPermissions: { canWrite: false, canManage: false, canUnlink: false },
    });
  });

  it('leaves out what an older server does not send, rather than inventing it', async () => {
    fetchMock.mockResolvedValue(response([BASE]));

    const [room] = await fetchRooms(SERVER);
    for (const key of [
      'bridgeId',
      'groupId',
      'ownerName',
      'readVisibility',
      'connectedUserCount',
      'peopleAreMembers',
      'serverPermissions',
    ])
      expect(room).not.toHaveProperty(key);
    expect(room.viewerIsMember).toBe(false);
  });
});
