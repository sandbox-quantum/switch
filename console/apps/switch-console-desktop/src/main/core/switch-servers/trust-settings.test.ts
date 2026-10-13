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

const { fetchTrustSettingsFromServer, updateTrustSettingsOnServer, clearTrustSettingsOnServer } =
  await import('./trust-settings');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  gatewayUrl: 'https://switch.example.com',
  managed: false,
} as never;

const SAVE_PARAMS = {
  endpoint: 'https://trust.example',
  policyId: 'pol_123',
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

const SETTINGS_JSON = {
  endpoint: 'https://trust.example',
  policy_id: 'pol_123',
  has_api_key: true,
  api_key_last4: '-key',
  enabled: true,
};

const SETTINGS = {
  endpoint: 'https://trust.example',
  policyId: 'pol_123',
  hasApiKey: true,
  apiKeyLast4: '-key',
  enabled: true,
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

describe('fetchTrustSettingsFromServer', () => {
  it('returns the loaded settings on success', async () => {
    fetchMock.mockResolvedValue(response(200, SETTINGS_JSON));

    await expect(fetchTrustSettingsFromServer(SERVER)).resolves.toEqual({
      kind: 'loaded',
      settings: SETTINGS,
    });
  });

  it('maps a rejected session onto unauthenticated so the caller prompts a sign-in', async () => {
    fetchMock.mockResolvedValue(response(401, 'Token expired'));

    await expect(fetchTrustSettingsFromServer(SERVER)).resolves.toEqual({
      kind: 'unauthenticated',
    });
  });

  it('reports a non-operator as forbidden, not a thrown error', async () => {
    fetchMock.mockResolvedValue(response(403, { detail: 'Admin access required' }));

    await expect(fetchTrustSettingsFromServer(SERVER)).resolves.toEqual({ kind: 'forbidden' });
  });

  it('reports an unreachable gateway rather than failing silently', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(fetchTrustSettingsFromServer(SERVER)).resolves.toMatchObject({ kind: 'error' });
  });

  it('rethrows a server fault rather than flattening it into a form error', async () => {
    fetchMock.mockResolvedValue(response(500, 'Internal Server Error'));

    await expect(fetchTrustSettingsFromServer(SERVER)).rejects.toMatchObject({ status: 500 });
  });
});

describe('updateTrustSettingsOnServer', () => {
  it('returns the saved settings on success', async () => {
    fetchMock.mockResolvedValue(response(200, SETTINGS_JSON));

    await expect(updateTrustSettingsOnServer(SERVER, SAVE_PARAMS)).resolves.toEqual({
      kind: 'saved',
      settings: SETTINGS,
    });
  });

  it('PUTs the settings, omitting api_key when none is given', async () => {
    fetchMock.mockResolvedValue(response(200, SETTINGS_JSON));

    await updateTrustSettingsOnServer(SERVER, SAVE_PARAMS);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://switch.example.com/gateway/trust-settings');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      endpoint: 'https://trust.example',
      policy_id: 'pol_123',
    });
  });

  it('includes api_key in the body when one is given, to replace the stored key', async () => {
    fetchMock.mockResolvedValue(response(200, SETTINGS_JSON));

    await updateTrustSettingsOnServer(SERVER, { ...SAVE_PARAMS, apiKey: 'new-key' });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({ api_key: 'new-key' });
  });

  it('maps a rejected session onto unauthenticated', async () => {
    fetchMock.mockResolvedValue(response(401, 'Token expired'));

    await expect(updateTrustSettingsOnServer(SERVER, SAVE_PARAMS)).resolves.toEqual({
      kind: 'unauthenticated',
    });
  });

  it('reports a non-operator as forbidden', async () => {
    fetchMock.mockResolvedValue(response(403, { detail: 'Admin access required' }));

    await expect(updateTrustSettingsOnServer(SERVER, SAVE_PARAMS)).resolves.toEqual({
      kind: 'forbidden',
    });
  });

  it('reports a rejected endpoint or timeout as invalid, with the gateway’s own sentence', async () => {
    fetchMock.mockResolvedValue(response(422, { detail: 'endpoint must be an http(s) URL' }));

    await expect(
      updateTrustSettingsOnServer(SERVER, { ...SAVE_PARAMS, endpoint: 'not-a-url' })
    ).resolves.toEqual({
      kind: 'invalid',
      message: 'endpoint must be an http(s) URL',
    });
  });

  it('reports an unreachable gateway rather than failing silently', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(updateTrustSettingsOnServer(SERVER, SAVE_PARAMS)).resolves.toMatchObject({
      kind: 'error',
    });
  });

  it('rethrows a server fault rather than flattening it into a form error', async () => {
    fetchMock.mockResolvedValue(response(500, 'Internal Server Error'));

    await expect(updateTrustSettingsOnServer(SERVER, SAVE_PARAMS)).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe('clearTrustSettingsOnServer', () => {
  it('returns the cleared settings on success', async () => {
    fetchMock.mockResolvedValue(
      response(200, { ...SETTINGS_JSON, policy_id: null, has_api_key: false, enabled: false })
    );

    await expect(clearTrustSettingsOnServer(SERVER)).resolves.toEqual({
      kind: 'cleared',
      settings: { ...SETTINGS, policyId: null, hasApiKey: false, enabled: false },
    });
  });

  it('DELETEs the settings', async () => {
    fetchMock.mockResolvedValue(response(200, SETTINGS_JSON));

    await clearTrustSettingsOnServer(SERVER);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://switch.example.com/gateway/trust-settings');
    expect(init.method).toBe('DELETE');
  });

  it('maps a rejected session onto unauthenticated', async () => {
    fetchMock.mockResolvedValue(response(401, 'Token expired'));

    await expect(clearTrustSettingsOnServer(SERVER)).resolves.toEqual({ kind: 'unauthenticated' });
  });

  it('reports a non-operator as forbidden', async () => {
    fetchMock.mockResolvedValue(response(403, { detail: 'Admin access required' }));

    await expect(clearTrustSettingsOnServer(SERVER)).resolves.toEqual({ kind: 'forbidden' });
  });

  it('reports an unreachable gateway rather than failing silently', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(clearTrustSettingsOnServer(SERVER)).resolves.toMatchObject({ kind: 'error' });
  });

  it('rethrows a server fault rather than flattening it into a form error', async () => {
    fetchMock.mockResolvedValue(response(500, 'Internal Server Error'));

    await expect(clearTrustSettingsOnServer(SERVER)).rejects.toMatchObject({ status: 500 });
  });
});
