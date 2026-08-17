import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionCookie = vi.hoisted(() => vi.fn());
const refreshSession = vi.hoisted(() => vi.fn());
const reauthenticateManagedServer = vi.hoisted(() => vi.fn());

const managedServerHostBlocked = vi.hoisted(() => vi.fn(() => null));
const managedServerStoppedPhase = vi.hoisted(() => vi.fn(() => null));

vi.mock('@main/core/managed-switch-server/managed-server-status', () => ({
  managedServerHostBlocked,
  managedServerStoppedPhase,
}));

vi.mock('./servers-store', () => ({ getSessionCookie }));
vi.mock('./auth', () => ({ refreshSession, reauthenticateManagedServer }));

const { createRoomOnServer } = await import('./create-room');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  gatewayUrl: 'https://switch.example.com',
  managed: false,
} as never;

const PARAMS = {
  name: 'design-review',
  description: 'Where design gets reviewed',
  bridgeId: 'bridge-1',
  agentIds: ['agent-1'],
};

/** A far-from-expiry JWT, so no renewal path is exercised here. */
function validJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
  const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function response(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => (typeof body === 'string' ? {} : body),
    headers: { getSetCookie: () => [] },
    text: async () => text,
  } as unknown as Response;
}

const CREATED = {
  id: 'room-1',
  name: 'design-review',
  description: 'Where design gets reviewed',
  channel_type: 'channel_public',
  agent_count: 1,
  bridge_display_name: 'Mattermost',
  archived: false,
  created_at: '2026-01-01T00:00:00Z',
};

const fetchMock = vi.fn();

describe('createRoomOnServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(validJwt());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the created room on success', async () => {
    fetchMock.mockResolvedValue(response(201, CREATED));

    await expect(createRoomOnServer(SERVER, PARAMS)).resolves.toMatchObject({
      kind: 'created',
      room: { id: 'room-1', name: 'design-review' },
    });
  });

  it('maps a rejected session onto unauthenticated so the caller prompts a sign-in', async () => {
    fetchMock.mockResolvedValue(response(401, 'Token expired'));

    await expect(createRoomOnServer(SERVER, PARAMS)).resolves.toEqual({ kind: 'unauthenticated' });
  });

  it("calls out a stopped bridge as its own case, in the gateway's words", async () => {
    fetchMock.mockResolvedValue(response(400, { detail: 'Bridge not running: bridge-1' }));

    await expect(createRoomOnServer(SERVER, PARAMS)).resolves.toEqual({
      kind: 'bridge-unavailable',
      message: 'Bridge not running: bridge-1',
    });
  });

  it('reports a rejected argument as invalid, using the detail rather than the status line', async () => {
    fetchMock.mockResolvedValue(response(400, { detail: 'Unknown agent ID: nope' }));

    await expect(createRoomOnServer(SERVER, PARAMS)).resolves.toEqual({
      kind: 'invalid',
      message: 'Unknown agent ID: nope',
    });
  });

  it('reports a withheld channel-creation switch as invalid, not as a stopped bridge', async () => {
    // Neither wording below contains "bridge", so `isBridgeFailure` must not
    // match — the bridge itself is fine, the operator withheld the capability.
    fetchMock.mockResolvedValue(
      response(400, {
        detail:
          "Creating channels is turned off for the 'Mattermost' connection. Create the " +
          'channel on the platform and add the Switch app to it — Switch adopts it as a ' +
          'room — or ask an administrator to allow channel creation for this connection.',
      })
    );

    await expect(createRoomOnServer(SERVER, PARAMS)).resolves.toEqual({
      kind: 'invalid',
      message:
        "Creating channels is turned off for the 'Mattermost' connection. Create the " +
        'channel on the platform and add the Switch app to it — Switch adopts it as a ' +
        'room — or ask an administrator to allow channel creation for this connection.',
    });
  });

  it('reports a platform that cannot create channels at all as invalid, not as a stopped bridge', async () => {
    fetchMock.mockResolvedValue(
      response(400, {
        detail:
          'Telegram bots cannot create chats — the Bot API has no such call. Create the ' +
          "group for 'design-review' in a Telegram client and add @switch_bot to it, and " +
          'Switch adopts it as a room as the bot lands.',
      })
    );

    await expect(createRoomOnServer(SERVER, PARAMS)).resolves.toMatchObject({ kind: 'invalid' });
  });

  it('surfaces an unreachable gateway rather than failing silently', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(createRoomOnServer(SERVER, PARAMS)).resolves.toMatchObject({ kind: 'error' });
  });

  it('rethrows a server fault rather than flattening it into a form error', async () => {
    fetchMock.mockResolvedValue(response(500, 'Internal Server Error'));

    await expect(createRoomOnServer(SERVER, PARAMS)).rejects.toMatchObject({ status: 500 });
  });
});
