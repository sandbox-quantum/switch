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

const { createBridgeOnServer } = await import('./create-bridge');
const { fetchBridgeTypes } = await import('./gateway-client');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  gatewayUrl: 'https://switch.example.com',
  managed: false,
} as never;

const PARAMS = {
  bridgeType: 'slack',
  displayName: 'Acme Slack',
  connectionConfig: {
    bot_token: 'xoxb-secret-value',
    app_token: 'xapp-secret-value',
    workspace_id: 'T123',
  },
  setAsDefault: false,
  channelCreationEnabled: true,
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
  bridge_id: 'bridge-1',
  bridge_type: 'slack',
  display_name: 'Acme Slack',
  status: 'active',
  is_default: false,
};

const fetchMock = vi.fn();

describe('createBridgeOnServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(validJwt());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the registered bridge on success', async () => {
    fetchMock.mockResolvedValue(response(200, CREATED));

    await expect(createBridgeOnServer(SERVER, PARAMS)).resolves.toEqual({
      kind: 'created',
      bridge: {
        id: 'bridge-1',
        type: 'slack',
        displayName: 'Acme Slack',
        status: 'active',
        isDefault: false,
        homeUrl: null,
        // Absent on CREATED, same as home_url — a server predating the
        // capability behaves as if every bridge could create a channel.
        channelCreationSupported: true,
        canCreateChannels: true,
        directorySearchSupported: true,
      },
    });
  });

  it("sends the credentials in the gateway's snake_case shape", async () => {
    fetchMock.mockResolvedValue(response(200, CREATED));

    await createBridgeOnServer(SERVER, { ...PARAMS, setAsDefault: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://switch.example.com/gateway/collaborations');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      bridge_type: 'slack',
      display_name: 'Acme Slack',
      connection_config: PARAMS.connectionConfig,
      set_as_default: true,
      channel_creation_enabled: true,
    });
  });

  it('states the choice explicitly even when off, rather than omitting the field', async () => {
    fetchMock.mockResolvedValue(response(200, CREATED));

    await createBridgeOnServer(SERVER, { ...PARAMS, channelCreationEnabled: false });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({ channel_creation_enabled: false });
  });

  it("reports a platform's own refusal to create channels as invalid, not forbidden", async () => {
    // Registering `channel_creation_enabled: true` for a platform whose
    // adapter cannot create channels at all returns 400 with a message
    // naming the platform — a rejected argument, not an admin-only failure.
    fetchMock.mockResolvedValue(
      response(400, {
        detail:
          'telegram cannot create channels from Switch, so this connection cannot be allowed ' +
          'to. Create the chat on the platform and add the bot to it; Switch adopts it as a room.',
      })
    );

    await expect(createBridgeOnServer(SERVER, PARAMS)).resolves.toEqual({
      kind: 'invalid',
      message:
        'telegram cannot create channels from Switch, so this connection cannot be allowed ' +
        'to. Create the chat on the platform and add the bot to it; Switch adopts it as a room.',
    });
  });

  it('maps a rejected session onto unauthenticated so the caller prompts a sign-in', async () => {
    fetchMock.mockResolvedValue(response(401, 'Token expired'));

    await expect(createBridgeOnServer(SERVER, PARAMS)).resolves.toEqual({
      kind: 'unauthenticated',
    });
  });

  it('reports a non-admin as forbidden, not as a bad form entry', async () => {
    // Registering a bridge is admin-only. Editing the credentials cannot fix
    // this, so it must not be presented as a validation failure.
    fetchMock.mockResolvedValue(response(403, { detail: 'Admin access required' }));

    await expect(createBridgeOnServer(SERVER, PARAMS)).resolves.toEqual({ kind: 'forbidden' });
  });

  it("reports rejected credentials as invalid, in the gateway's words", async () => {
    fetchMock.mockResolvedValue(response(422, { detail: 'Field required: workspace_id' }));

    await expect(createBridgeOnServer(SERVER, PARAMS)).resolves.toEqual({
      kind: 'invalid',
      message: 'Field required: workspace_id',
    });
  });

  it('surfaces an unreachable gateway rather than failing silently', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(createBridgeOnServer(SERVER, PARAMS)).resolves.toMatchObject({ kind: 'error' });
  });

  it('rethrows a server fault rather than flattening it into a form error', async () => {
    fetchMock.mockResolvedValue(response(500, 'Internal Server Error'));

    await expect(createBridgeOnServer(SERVER, PARAMS)).rejects.toMatchObject({ status: 500 });
  });

  it('never puts a credential in the error it raises', async () => {
    // The failure path is where a token is most likely to escape into a log:
    // GatewayError must quote the response body only, never the request.
    fetchMock.mockResolvedValue(response(500, 'Internal Server Error'));

    await expect(createBridgeOnServer(SERVER, PARAMS)).rejects.toSatisfy((cause: Error) => {
      const text = `${cause.message} ${JSON.stringify(cause)}`;
      return !text.includes('xoxb-secret-value') && !text.includes('xapp-secret-value');
    });
  });
});

describe('fetchBridgeTypes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(validJwt());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('flattens the config schema into ordered fields, marking the required ones', async () => {
    fetchMock.mockResolvedValue(
      response(200, [
        {
          key: 'slack',
          config_schema: {
            properties: {
              bot_token: { title: 'Bot Token', type: 'string', description: 'The xoxb token.' },
              app_token: { title: 'App Token', type: 'string' },
              workspace_id: { title: 'Workspace Id', type: 'string' },
            },
            required: ['bot_token', 'app_token', 'workspace_id'],
          },
        },
      ])
    );

    const [slack] = await fetchBridgeTypes(SERVER);

    expect(slack.key).toBe('slack');
    // Field order follows the Pydantic model, which the setup docs mirror.
    expect(slack.fields.map((f) => f.key)).toEqual(['bot_token', 'app_token', 'workspace_id']);
    expect(slack.fields[0]).toEqual({
      key: 'bot_token',
      label: 'Bot Token',
      description: 'The xoxb token.',
      required: true,
      secret: true,
      kind: 'string',
      default: null,
    });
  });

  it('carries a boolean field as one, with its default', async () => {
    // Fields used to be strings without exception. A boolean sent as the empty
    // string the form would otherwise produce is rejected by the server, so the
    // type has to survive the flattening.
    fetchMock.mockResolvedValue(
      response(200, [
        {
          key: 'slack',
          config_schema: {
            properties: {
              bot_token: { title: 'Bot Token', type: 'string' },
              agent_usergroups: {
                title: 'Agent Usergroups',
                type: 'boolean',
                default: true,
              },
            },
            required: ['bot_token'],
          },
        },
      ])
    );

    const [slack] = await fetchBridgeTypes(SERVER);

    expect(slack.fields[1]).toEqual({
      key: 'agent_usergroups',
      label: 'Agent Usergroups',
      description: null,
      required: false,
      secret: false,
      kind: 'boolean',
      default: true,
    });
  });

  it('marks a field optional when the schema does not require it', async () => {
    fetchMock.mockResolvedValue(
      response(200, [
        {
          key: 'mattermost',
          config_schema: {
            properties: {
              url: { title: 'Url', type: 'string' },
              admin_password: { title: 'Admin Password', type: 'string' },
              public_url: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            },
            required: ['url', 'admin_password'],
          },
        },
      ])
    );

    const [mm] = await fetchBridgeTypes(SERVER);
    const byKey = Object.fromEntries(mm.fields.map((f) => [f.key, f]));

    expect(byKey.url).toMatchObject({ required: true, secret: false });
    expect(byKey.admin_password).toMatchObject({ required: true, secret: true });
    expect(byKey.public_url).toMatchObject({ required: false, secret: false });
    // No `title` in the schema — fall back to a humanised key rather than
    // showing the raw snake_case name.
    expect(byKey.public_url.label).toBe('Public Url');
  });

  it('masks a private key, which a bare api_key heuristic would miss', async () => {
    // Teams' Graph encryption key is as sensitive as a token but matches
    // neither `token` nor `api_key`.
    fetchMock.mockResolvedValue(
      response(200, [
        {
          key: 'teams',
          config_schema: {
            properties: {
              app_id: { title: 'App Id', type: 'string' },
              encryption_private_key: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            },
            required: ['app_id'],
          },
        },
      ])
    );

    const [teams] = await fetchBridgeTypes(SERVER);
    const byKey = Object.fromEntries(teams.fields.map((f) => [f.key, f]));

    expect(byKey.app_id.secret).toBe(false);
    expect(byKey.encryption_private_key.secret).toBe(true);
  });

  it('honours an explicit password format over the name heuristic', async () => {
    fetchMock.mockResolvedValue(
      response(200, [
        {
          key: 'custom',
          config_schema: {
            properties: { handshake: { title: 'Handshake', type: 'string', format: 'password' } },
            required: ['handshake'],
          },
        },
      ])
    );

    const [custom] = await fetchBridgeTypes(SERVER);
    expect(custom.fields[0].secret).toBe(true);
  });

  it('tolerates a type with no fields rather than throwing', async () => {
    fetchMock.mockResolvedValue(response(200, [{ key: 'stub', config_schema: {} }]));

    // No `channel_creation_supported` in the fixture — a server predating the
    // capability, which is the same "every platform could" default as the
    // bridge list uses.
    await expect(fetchBridgeTypes(SERVER)).resolves.toEqual([
      { key: 'stub', fields: [], channelCreationSupported: true, directorySearchSupported: true },
    ]);
  });

  it('reports a platform that cannot create channels at all', async () => {
    fetchMock.mockResolvedValue(
      response(200, [{ key: 'telegram', config_schema: {}, channel_creation_supported: false }])
    );

    const [telegram] = await fetchBridgeTypes(SERVER);
    expect(telegram.channelCreationSupported).toBe(false);
  });
});
