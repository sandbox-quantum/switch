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

const {
  fetchDecisionSettingsFromServer,
  updateDecisionSettingsOnServer,
  clearDecisionSettingsOnServer,
  testDecisionSettingsOnServer,
} = await import('./decision-settings');
const { fetchRoomDetail, setRoomAutoRoute } = await import('./gateway-client');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  url: 'https://switch.example.com',
  dashboardUrl: null,
  managed: false,
} as never;

/** A far-from-expiry JWT, so no renewal path is exercised here. */
function validJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
  const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function response(status: number, body: unknown): Response {
  const text = body === null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => (typeof body === 'string' || body === null ? {} : body),
    headers: { get: () => null, getSetCookie: () => [] },
    text: async () => text,
  } as unknown as Response;
}

const SETTINGS_JSON = {
  source: 'workspace',
  effective: {
    backend: 'haiku_anthropic',
    endpoint: null,
    threshold: 0.4,
    available: true,
    reason: null,
  },
  workspace: {
    backend: 'haiku_anthropic',
    endpoint: null,
    threshold: 0.4,
    has_api_key: true,
    api_key_last4: 'AwcA',
    api_key_unreadable: false,
    updated_at: '2026-10-27T10:00:00Z',
  },
  server_default: { configured: true, endpoint: 'http://decision:8230', has_api_key: false },
  options: { haiku_anthropic: true, haiku_bedrock: false },
};

const SETTINGS = {
  source: 'workspace',
  effective: {
    backend: 'haiku_anthropic',
    endpoint: null,
    threshold: 0.4,
    available: true,
    reason: null,
  },
  workspace: {
    backend: 'haiku_anthropic',
    endpoint: null,
    threshold: 0.4,
    hasApiKey: true,
    apiKeyLast4: 'AwcA',
    apiKeyUnreadable: false,
    updatedAt: '2026-10-27T10:00:00Z',
  },
  serverDefault: { configured: true, endpoint: 'http://decision:8230', hasApiKey: false },
  options: { haikuAnthropic: true, haikuBedrock: false },
};

const DEFAULT_JSON = {
  source: 'server_default',
  effective: {
    backend: 'endpoint',
    endpoint: 'http://decision:8230',
    threshold: null,
    available: true,
    reason: null,
  },
  workspace: null,
  server_default: { configured: true, endpoint: 'http://decision:8230', has_api_key: false },
  options: { haiku_anthropic: true, haiku_bedrock: false },
};

const ENDPOINT_INPUT = {
  backend: 'endpoint' as const,
  endpoint: 'https://decide.example',
  threshold: 0.5,
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  getSessionCookie.mockResolvedValue(validJwt());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchDecisionSettingsFromServer', () => {
  it('returns the loaded settings on success, never a key', async () => {
    fetchMock.mockResolvedValue(response(200, SETTINGS_JSON));

    await expect(fetchDecisionSettingsFromServer(SERVER)).resolves.toEqual({
      kind: 'loaded',
      settings: SETTINGS,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://switch.example.com/gateway/decision-settings');
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('reads a workspace on the server default as having no setting of its own', async () => {
    fetchMock.mockResolvedValue(response(200, DEFAULT_JSON));

    const result = await fetchDecisionSettingsFromServer(SERVER);
    expect(result).toMatchObject({
      kind: 'loaded',
      settings: { source: 'server_default', workspace: null },
    });
  });

  it('maps a rejected session onto unauthenticated so the caller prompts a sign-in', async () => {
    fetchMock.mockResolvedValue(response(401, 'Token expired'));

    await expect(fetchDecisionSettingsFromServer(SERVER)).resolves.toEqual({
      kind: 'unauthenticated',
    });
  });

  it('reports a member who is not a workspace admin as forbidden, not a thrown error', async () => {
    fetchMock.mockResolvedValue(response(403, { detail: 'Workspace admin access required' }));

    await expect(fetchDecisionSettingsFromServer(SERVER)).resolves.toEqual({ kind: 'forbidden' });
  });

  it('reports a server without the route as unsupported', async () => {
    fetchMock.mockResolvedValue(response(404, { detail: 'Not Found' }));

    await expect(fetchDecisionSettingsFromServer(SERVER)).resolves.toEqual({
      kind: 'unsupported',
    });
  });

  it('reports an unreachable gateway rather than failing silently', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(fetchDecisionSettingsFromServer(SERVER)).resolves.toMatchObject({
      kind: 'error',
    });
  });

  it('rethrows a server fault rather than flattening it into a form error', async () => {
    fetchMock.mockResolvedValue(response(500, 'Internal Server Error'));

    await expect(fetchDecisionSettingsFromServer(SERVER)).rejects.toMatchObject({ status: 500 });
  });
});

describe('updateDecisionSettingsOnServer', () => {
  it('returns the saved settings on success', async () => {
    fetchMock.mockResolvedValue(response(200, SETTINGS_JSON));

    await expect(updateDecisionSettingsOnServer(SERVER, ENDPOINT_INPUT)).resolves.toEqual({
      kind: 'saved',
      settings: SETTINGS,
    });
  });

  it('PUTs the settings, omitting api_key when none is given so the stored one is kept', async () => {
    fetchMock.mockResolvedValue(response(200, SETTINGS_JSON));

    await updateDecisionSettingsOnServer(SERVER, ENDPOINT_INPUT);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://switch.example.com/gateway/decision-settings');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      backend: 'endpoint',
      endpoint: 'https://decide.example',
      threshold: 0.5,
    });
  });

  it('sends a new key, or the request to clear the stored one', async () => {
    fetchMock.mockResolvedValue(response(200, SETTINGS_JSON));

    await updateDecisionSettingsOnServer(SERVER, {
      backend: 'haiku_anthropic',
      apiKey: 'sk-ant-placeholder',
    });
    await updateDecisionSettingsOnServer(SERVER, { ...ENDPOINT_INPUT, clearApiKey: true });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      backend: 'haiku_anthropic',
      api_key: 'sk-ant-placeholder',
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ clear_api_key: true });
  });

  it('reports a refused value as invalid, with the gateway’s own sentence', async () => {
    fetchMock.mockResolvedValue(
      response(422, { detail: 'haiku_bedrock is not enabled on this server' })
    );

    await expect(
      updateDecisionSettingsOnServer(SERVER, { backend: 'haiku_bedrock' })
    ).resolves.toEqual({
      kind: 'invalid',
      message: 'haiku_bedrock is not enabled on this server',
    });
  });

  it('words a FastAPI validation list as its messages rather than raw JSON', async () => {
    fetchMock.mockResolvedValue(
      response(422, {
        detail: [
          {
            type: 'less_than_equal',
            loc: ['body', 'threshold'],
            msg: 'Input should be less than or equal to 1',
          },
        ],
      })
    );

    await expect(
      updateDecisionSettingsOnServer(SERVER, { ...ENDPOINT_INPUT, threshold: 1.5 })
    ).resolves.toEqual({
      kind: 'invalid',
      message: 'threshold: Input should be less than or equal to 1',
    });
  });

  it('maps a rejected session onto unauthenticated', async () => {
    fetchMock.mockResolvedValue(response(401, 'Token expired'));

    await expect(updateDecisionSettingsOnServer(SERVER, ENDPOINT_INPUT)).resolves.toEqual({
      kind: 'unauthenticated',
    });
  });

  it('reports a member who is not a workspace admin as forbidden', async () => {
    fetchMock.mockResolvedValue(response(403, { detail: 'Workspace admin access required' }));

    await expect(updateDecisionSettingsOnServer(SERVER, ENDPOINT_INPUT)).resolves.toEqual({
      kind: 'forbidden',
    });
  });

  it('reports an unreachable gateway rather than failing silently', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(updateDecisionSettingsOnServer(SERVER, ENDPOINT_INPUT)).resolves.toMatchObject({
      kind: 'error',
    });
  });

  it('rethrows a server fault rather than flattening it into a form error', async () => {
    fetchMock.mockResolvedValue(response(500, 'Internal Server Error'));

    await expect(updateDecisionSettingsOnServer(SERVER, ENDPOINT_INPUT)).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe('clearDecisionSettingsOnServer', () => {
  it('DELETEs the workspace’s setting, then reads back the server default it now uses', async () => {
    fetchMock
      .mockResolvedValueOnce(response(204, null))
      .mockResolvedValueOnce(response(200, DEFAULT_JSON));

    const result = await clearDecisionSettingsOnServer(SERVER);

    expect(result).toMatchObject({
      kind: 'cleared',
      settings: { source: 'server_default', workspace: null },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://switch.example.com/gateway/decision-settings');
    expect(init.method).toBe('DELETE');
    expect(fetchMock.mock.calls[1][0]).toBe('https://switch.example.com/gateway/decision-settings');
  });

  it('maps a rejected session onto unauthenticated', async () => {
    fetchMock.mockResolvedValue(response(401, 'Token expired'));

    await expect(clearDecisionSettingsOnServer(SERVER)).resolves.toEqual({
      kind: 'unauthenticated',
    });
  });

  it('reports a member who is not a workspace admin as forbidden', async () => {
    fetchMock.mockResolvedValue(response(403, { detail: 'Workspace admin access required' }));

    await expect(clearDecisionSettingsOnServer(SERVER)).resolves.toEqual({ kind: 'forbidden' });
  });

  it('reports an unreachable gateway rather than failing silently', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(clearDecisionSettingsOnServer(SERVER)).resolves.toMatchObject({ kind: 'error' });
  });

  it('rethrows a server fault rather than flattening it into a form error', async () => {
    fetchMock.mockResolvedValue(response(500, 'Internal Server Error'));

    await expect(clearDecisionSettingsOnServer(SERVER)).rejects.toMatchObject({ status: 500 });
  });
});

describe('testDecisionSettingsOnServer', () => {
  it('POSTs the unsaved values and returns the pick, confidence and latency', async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        ok: true,
        agent: 'deploy-bot',
        model_choice: 'deploy-bot',
        confidence: 0.91,
        latency_ms: 420,
        backend: 'endpoint',
        error: null,
      })
    );

    await expect(testDecisionSettingsOnServer(SERVER, ENDPOINT_INPUT)).resolves.toEqual({
      kind: 'tested',
      outcome: {
        ok: true,
        agent: 'deploy-bot',
        modelChoice: 'deploy-bot',
        confidence: 0.91,
        latencyMs: 420,
        backend: 'endpoint',
        error: null,
      },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://switch.example.com/gateway/decision-settings/test');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      backend: 'endpoint',
      endpoint: 'https://decide.example',
      threshold: 0.5,
    });
  });

  it('tests the server default as `default`, sending nothing of the workspace’s', async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        ok: true,
        agent: null,
        model_choice: 'none',
        confidence: 0.2,
        latency_ms: 300,
        backend: 'default',
        error: null,
      })
    );

    await testDecisionSettingsOnServer(SERVER, { backend: 'default' });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ backend: 'default' });
  });

  it('returns a failed decision as an answer, with its reason', async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        ok: false,
        agent: null,
        model_choice: null,
        confidence: null,
        latency_ms: null,
        backend: 'haiku_anthropic',
        error: { code: 'key_refused', message: 'The Anthropic API refused the key.' },
      })
    );

    await expect(
      testDecisionSettingsOnServer(SERVER, { backend: 'haiku_anthropic', apiKey: 'bad' })
    ).resolves.toMatchObject({
      kind: 'tested',
      outcome: {
        ok: false,
        error: { code: 'key_refused', message: 'The Anthropic API refused the key.' },
      },
    });
  });

  it('reports refused values as invalid', async () => {
    fetchMock.mockResolvedValue(response(422, { detail: 'endpoint must be an http(s) URL' }));

    await expect(
      testDecisionSettingsOnServer(SERVER, { backend: 'endpoint', endpoint: 'nope' })
    ).resolves.toEqual({ kind: 'invalid', message: 'endpoint must be an http(s) URL' });
  });

  it('reports a member who is not a workspace admin as forbidden', async () => {
    fetchMock.mockResolvedValue(response(403, { detail: 'Workspace admin access required' }));

    await expect(testDecisionSettingsOnServer(SERVER, ENDPOINT_INPUT)).resolves.toEqual({
      kind: 'forbidden',
    });
  });
});

describe('a room’s auto-route setting', () => {
  const ROOM_JSON = {
    id: 'room-1',
    name: 'ops',
    description: '',
    channel_type: null,
    agent_count: 2,
    bridge_display_name: null,
    archived: false,
    created_at: '2026-10-27T10:00:00Z',
  };

  it('reads auto_route from the room detail', async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        ...ROOM_JSON,
        auto_route: {
          on: true,
          available: true,
          reason: null,
          fallback_agent: 'agent-7',
          fallback_agent_name: 'triage-bot',
        },
      })
    );

    const room = await fetchRoomDetail(SERVER, 'room-1');
    expect(room.autoRoute).toEqual({
      on: true,
      available: true,
      reason: null,
      fallbackAgent: 'agent-7',
      fallbackAgentName: 'triage-bot',
    });
  });

  it('leaves it absent for a server that predates it', async () => {
    fetchMock.mockResolvedValue(response(200, ROOM_JSON));

    const room = await fetchRoomDetail(SERVER, 'room-1');
    expect(room.autoRoute).toBeUndefined();
  });

  it('PUTs only the fields changed and returns the setting as it now stands', async () => {
    fetchMock.mockResolvedValue(
      response(200, { on: false, available: true, reason: null, fallback_agent: null })
    );

    await expect(setRoomAutoRoute(SERVER, 'room-1', { on: false })).resolves.toEqual({
      on: false,
      available: true,
      reason: null,
      fallbackAgent: null,
      fallbackAgentName: null,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://switch.example.com/gateway/rooms/room-1/auto-route');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ on: false });

    await setRoomAutoRoute(SERVER, 'room-1', { fallbackAgent: null });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ fallback_agent: null });
  });
});
