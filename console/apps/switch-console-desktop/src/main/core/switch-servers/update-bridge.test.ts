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

const { updateBridgeOnServer } = await import('./update-bridge');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  gatewayUrl: 'https://switch.example.com',
  managed: false,
} as never;

const PARAMS = {
  bridgeId: 'bridge-1',
  channelCreationEnabled: false,
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

const UPDATED = {
  bridge_id: 'bridge-1',
  bridge_type: 'slack',
  display_name: 'Acme Slack',
  status: 'active',
  is_default: false,
  channel_creation_supported: true,
  channel_creation_enabled: false,
};

const fetchMock = vi.fn();

describe('updateBridgeOnServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(validJwt());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the updated bridge on success', async () => {
    fetchMock.mockResolvedValue(response(200, UPDATED));

    await expect(updateBridgeOnServer(SERVER, PARAMS)).resolves.toEqual({
      kind: 'updated',
      bridge: {
        id: 'bridge-1',
        type: 'slack',
        displayName: 'Acme Slack',
        status: 'active',
        isDefault: false,
        homeUrl: null,
        channelCreationSupported: true,
        canCreateChannels: false,
      },
    });
  });

  it('PATCHes the bridge by id with only the changed field', async () => {
    fetchMock.mockResolvedValue(response(200, UPDATED));

    await updateBridgeOnServer(SERVER, PARAMS);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://switch.example.com/gateway/collaborations/bridge-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ channel_creation_enabled: false });
  });

  it('maps a rejected session onto unauthenticated so the caller prompts a sign-in', async () => {
    fetchMock.mockResolvedValue(response(401, 'Token expired'));

    await expect(updateBridgeOnServer(SERVER, PARAMS)).resolves.toEqual({
      kind: 'unauthenticated',
    });
  });

  it('reports a non-admin as forbidden, not as a bad form entry', async () => {
    // Editing a bridge is admin-only, same as registering one.
    fetchMock.mockResolvedValue(response(403, { detail: 'Admin access required' }));

    await expect(updateBridgeOnServer(SERVER, PARAMS)).resolves.toEqual({ kind: 'forbidden' });
  });

  it("reports a platform's own refusal to create channels as invalid, not forbidden", async () => {
    // Turning channel creation on for a connection whose platform cannot do
    // it at all returns 400 with a message naming the platform — a rejected
    // argument, not an admin-only failure.
    fetchMock.mockResolvedValue(
      response(400, {
        detail:
          'telegram cannot create channels from Switch, so this connection cannot be allowed ' +
          'to. Create the chat on the platform and add the bot to it; Switch adopts it as a room.',
      })
    );

    await expect(
      updateBridgeOnServer(SERVER, { ...PARAMS, channelCreationEnabled: true })
    ).resolves.toEqual({
      kind: 'invalid',
      message:
        'telegram cannot create channels from Switch, so this connection cannot be allowed ' +
        'to. Create the chat on the platform and add the bot to it; Switch adopts it as a room.',
    });
  });

  it('surfaces an unreachable gateway rather than failing silently', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(updateBridgeOnServer(SERVER, PARAMS)).resolves.toMatchObject({ kind: 'error' });
  });

  it('rethrows a server fault rather than flattening it into a form error', async () => {
    fetchMock.mockResolvedValue(response(500, 'Internal Server Error'));

    await expect(updateBridgeOnServer(SERVER, PARAMS)).rejects.toMatchObject({ status: 500 });
  });
});
