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

const { bridgeInstallState, disconnectBridgeOnServer } = await import('./disconnect-bridge');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  gatewayUrl: 'https://switch.example.com',
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
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => (typeof body === 'string' ? {} : body),
    headers: { getSetCookie: () => [] },
    text: async () => text,
  } as unknown as Response;
}

const INSTALL = {
  id: 'install-1',
  platform: 'teams',
  external_workspace_id: 'tenant-1',
  status: 'active',
  scopes: '',
  bridge_id: 'b1',
  installed_at: '2026-01-01T00:00:00Z',
  ended_at: null,
};

const fetchMock = vi.fn();

describe('disconnectBridgeOnServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(validJwt());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ends the install backing the bridge, rather than deleting the bridge directly', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/messaging-apps/installs')) {
        return response(200, { installs: [INSTALL] });
      }
      if (url.includes('/messaging-apps/installs/install-1')) {
        return response(200, {});
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(disconnectBridgeOnServer(SERVER, 'b1')).resolves.toEqual({ kind: 'deleted' });

    const urls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(urls).toEqual([
      'https://switch.example.com/gateway/messaging-apps/installs',
      'https://switch.example.com/gateway/messaging-apps/installs/install-1',
    ]);
    // Never the plain bridge delete — the server refuses that with 409 for an
    // install-backed bridge, so this must not even try it.
    expect(urls.some((u) => u.includes('/collaborations/'))).toBe(false);
  });

  it('ignores an ended install for this bridge and falls back to deleting the bridge', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/messaging-apps/installs')) {
        return response(200, { installs: [{ ...INSTALL, ended_at: '2026-02-01T00:00:00Z' }] });
      }
      if (url.includes('/collaborations/b1')) {
        return response(200, {});
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(disconnectBridgeOnServer(SERVER, 'b1')).resolves.toEqual({ kind: 'deleted' });

    const urls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(urls).toContain('https://switch.example.com/gateway/collaborations/b1');
  });

  it('deletes the bridge directly when no install names it', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/messaging-apps/installs')) {
        return response(200, { installs: [{ ...INSTALL, bridge_id: 'some-other-bridge' }] });
      }
      if (url.includes('/collaborations/b1')) {
        return response(200, {});
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(disconnectBridgeOnServer(SERVER, 'b1')).resolves.toEqual({ kind: 'deleted' });
  });

  it('falls back to deleting the bridge when the server predates installs (404)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/messaging-apps/installs')) {
        return response(404, { detail: 'Not Found' });
      }
      if (url.includes('/collaborations/b1')) {
        return response(200, {});
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(disconnectBridgeOnServer(SERVER, 'b1')).resolves.toEqual({ kind: 'deleted' });
  });

  it('maps a non-admin ending the install onto forbidden', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/messaging-apps/installs')) {
        return response(200, { installs: [INSTALL] });
      }
      return response(403, { detail: 'Admin only' });
    });

    await expect(disconnectBridgeOnServer(SERVER, 'b1')).resolves.toEqual({ kind: 'forbidden' });
  });

  it('maps an already-ended install onto not-found rather than claiming success', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/messaging-apps/installs')) {
        return response(200, { installs: [INSTALL] });
      }
      return response(404, { detail: 'Install not found' });
    });

    await expect(disconnectBridgeOnServer(SERVER, 'b1')).resolves.toEqual({ kind: 'not-found' });
  });

  it('rethrows a server fault rather than flattening it into a result', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/messaging-apps/installs')) {
        return response(200, { installs: [INSTALL] });
      }
      return response(500, 'Internal Server Error');
    });

    await expect(disconnectBridgeOnServer(SERVER, 'b1')).rejects.toMatchObject({ status: 500 });
  });

  it('maps an expired session while looking up the install onto unauthenticated', async () => {
    fetchMock.mockImplementation(async () => response(401, { detail: 'expired' }));
    refreshSession.mockResolvedValue(null);

    await expect(disconnectBridgeOnServer(SERVER, 'b1')).resolves.toEqual({
      kind: 'unauthenticated',
    });
  });

  it('maps a non-admin looking up the install onto forbidden', async () => {
    fetchMock.mockImplementation(async () => response(403, { detail: 'admins only' }));

    await expect(disconnectBridgeOnServer(SERVER, 'b1')).resolves.toEqual({ kind: 'forbidden' });
  });

  it('reports the platform refusing to let go, in its own words', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/messaging-apps/installs')) {
        return response(200, { installs: [INSTALL] });
      }
      return response(502, { detail: 'Slack refused to revoke the token' });
    });

    // The server's own sentence (`detail`), not the raw
    // "Switch gateway returned 502: {...}" status-line message.
    await expect(disconnectBridgeOnServer(SERVER, 'b1')).resolves.toEqual({
      kind: 'error',
      message: 'Slack refused to revoke the token',
    });
  });
});

describe('bridgeInstallState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(validJwt());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says a bridge backed by a live install is installed', async () => {
    fetchMock.mockImplementation(async () => response(200, { installs: [INSTALL] }));
    await expect(bridgeInstallState(SERVER, 'b1')).resolves.toBe('installed');
  });

  it('says a bridge no live install names is not installed', async () => {
    fetchMock.mockImplementation(async () =>
      response(200, { installs: [{ ...INSTALL, ended_at: '2026-02-01T00:00:00Z' }] })
    );
    await expect(bridgeInstallState(SERVER, 'b1')).resolves.toBe('not-installed');
  });

  it('says it does not know when it could not ask', async () => {
    fetchMock.mockImplementation(async () => response(403, { detail: 'admins only' }));
    await expect(bridgeInstallState(SERVER, 'b1')).resolves.toBe('unknown');
  });

  it('rethrows a server fault rather than flattening it into "unknown"', async () => {
    fetchMock.mockImplementation(async () => response(500, 'Internal Server Error'));
    await expect(bridgeInstallState(SERVER, 'b1')).rejects.toMatchObject({ status: 500 });
  });
});

describe('disconnecting a Telegram connection', () => {
  const CHAT = { ...INSTALL, platform: 'telegram', external_workspace_id: '-1001' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(validJwt());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('disconnects every chat, then deletes the connection', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/messaging-apps/installs')) {
        return response(200, {
          installs: [
            { ...CHAT, id: 'chat-1' },
            { ...CHAT, id: 'chat-2', external_workspace_id: '-1002' },
            { ...CHAT, id: 'chat-gone', ended_at: '2026-02-01T00:00:00Z' },
          ],
        });
      }
      if (url.includes('/messaging-apps/installs/') || url.includes('/collaborations/b1')) {
        return response(200, {});
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(disconnectBridgeOnServer(SERVER, 'b1')).resolves.toEqual({ kind: 'deleted' });

    const urls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(urls).toEqual([
      'https://switch.example.com/gateway/messaging-apps/installs',
      'https://switch.example.com/gateway/messaging-apps/installs/chat-1',
      'https://switch.example.com/gateway/messaging-apps/installs/chat-2',
      'https://switch.example.com/gateway/collaborations/b1',
    ]);
  });

  it('carries on past a chat someone else already disconnected', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/messaging-apps/installs')) {
        return response(200, {
          installs: [
            { ...CHAT, id: 'chat-1' },
            { ...CHAT, id: 'chat-2' },
          ],
        });
      }
      if (url.endsWith('/messaging-apps/installs/chat-1')) {
        return response(404, { detail: 'Install not found' });
      }
      if (url.includes('/messaging-apps/installs/') || url.includes('/collaborations/b1')) {
        return response(200, {});
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(disconnectBridgeOnServer(SERVER, 'b1')).resolves.toEqual({ kind: 'deleted' });
  });

  it('stops at a chat the bot cannot leave, leaving the connection in place', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/messaging-apps/installs')) {
        return response(200, {
          installs: [
            { ...CHAT, id: 'chat-1' },
            { ...CHAT, id: 'chat-2' },
          ],
        });
      }
      if (url.endsWith('/messaging-apps/installs/chat-1')) {
        return response(502, { detail: 'Telegram refused to let the bot leave chat -1001.' });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(disconnectBridgeOnServer(SERVER, 'b1')).resolves.toEqual({
      kind: 'error',
      message: 'Telegram refused to let the bot leave chat -1001.',
    });

    const urls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(urls.some((u) => u.includes('chat-2') || u.includes('/collaborations/'))).toBe(false);
  });
});
