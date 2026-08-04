import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionCookie = vi.hoisted(() => vi.fn());
const refreshSession = vi.hoisted(() => vi.fn());
const reauthenticateManagedServer = vi.hoisted(() => vi.fn());

vi.mock('./servers-store', () => ({ getSessionCookie }));
vi.mock('./auth', () => ({ refreshSession, reauthenticateManagedServer }));

const { createRoom, fetchBridges, fetchMe, registerKnownAgent } = await import('./gateway-client');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  gatewayUrl: 'https://switch.example.com',
  managed: false,
} as never;
const MANAGED = {
  id: 'srv-local',
  name: 'Local',
  gatewayUrl: 'https://switch.example.com',
  managed: true,
} as never;

/** A structurally-valid JWT whose payload `exp` is `secondsFromNow` in the
 * future (or past when negative). Signature is a placeholder — the client only
 * base64-decodes the payload to read `exp`. */
function makeJwt(secondsFromNow: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow;
  const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function okMeResponse(): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({ id: 'u1', name: 'Ada', email: 'ada@example.com', role: 'user' }),
    headers: { getSetCookie: () => [] },
    text: async () => '',
  } as unknown as Response;
}

function unauthorizedResponse(): Response {
  return {
    status: 401,
    ok: false,
    json: async () => ({}),
    headers: { getSetCookie: () => [] },
    text: async () => 'Token expired',
  } as unknown as Response;
}

function cookieHeaderOf(call: unknown[]): string {
  const init = call[1] as { headers: Record<string, string> };
  return init.headers.Cookie;
}

const fetchMock = vi.fn(async () => okMeResponse());

describe('gatewayFetch proactive session renewal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async () => okMeResponse());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches the stored token without renewing when it is far from expiry', async () => {
    const jwt = makeJwt(2 * 60 * 60); // 2h out, beyond the 1h leeway
    getSessionCookie.mockResolvedValue(jwt);

    await fetchMe(SERVER);

    expect(refreshSession).not.toHaveBeenCalled();
    expect(cookieHeaderOf(fetchMock.mock.calls[0])).toBe(`switch_auth=${jwt}`);
  });

  it('renews and attaches the fresh token when the stored token is near expiry', async () => {
    const stale = makeJwt(10 * 60); // 10min out, inside the 1h leeway
    const fresh = makeJwt(24 * 60 * 60);
    getSessionCookie.mockResolvedValue(stale);
    refreshSession.mockResolvedValue(fresh);

    await fetchMe(SERVER);

    expect(refreshSession).toHaveBeenCalledExactlyOnceWith(SERVER, stale);
    expect(cookieHeaderOf(fetchMock.mock.calls[0])).toBe(`switch_auth=${fresh}`);
  });

  it('falls back to the current token when renewal does not succeed', async () => {
    const stale = makeJwt(5 * 60);
    getSessionCookie.mockResolvedValue(stale);
    refreshSession.mockResolvedValue(null);

    await fetchMe(SERVER);

    expect(refreshSession).toHaveBeenCalledOnce();
    // Call still goes out (with the stale token) — it will 401 and the caller
    // prompts an interactive sign-in rather than the renewal silently faking it.
    expect(cookieHeaderOf(fetchMock.mock.calls[0])).toBe(`switch_auth=${stale}`);
  });

  it('dedupes concurrent renewals into a single refresh round-trip', async () => {
    const stale = makeJwt(5 * 60);
    const fresh = makeJwt(24 * 60 * 60);
    getSessionCookie.mockResolvedValue(stale);
    let resolveRefresh: (value: string) => void = () => {};
    refreshSession.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRefresh = resolve;
      })
    );

    const calls = Promise.all([fetchMe(SERVER), fetchMe(SERVER), fetchMe(SERVER)]);
    resolveRefresh(fresh);
    await calls;

    expect(refreshSession).toHaveBeenCalledOnce();
    for (const call of fetchMock.mock.calls) {
      expect(cookieHeaderOf(call)).toBe(`switch_auth=${fresh}`);
    }
  });

  it('throws unauthorized without renewing when no token is stored', async () => {
    getSessionCookie.mockResolvedValue(null);

    await expect(fetchMe(SERVER)).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(refreshSession).not.toHaveBeenCalled();
    expect(reauthenticateManagedServer).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('gatewayFetch managed-server silent re-auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async () => okMeResponse());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mints a session for the managed server when none is stored', async () => {
    const minted = makeJwt(24 * 60 * 60);
    getSessionCookie.mockResolvedValue(null);
    reauthenticateManagedServer.mockResolvedValue(minted);

    await fetchMe(MANAGED);

    expect(reauthenticateManagedServer).toHaveBeenCalledExactlyOnceWith(MANAGED);
    expect(cookieHeaderOf(fetchMock.mock.calls[0])).toBe(`switch_auth=${minted}`);
  });

  it('re-logins and retries once on a 401 for the managed server', async () => {
    const stored = makeJwt(24 * 60 * 60); // fresh, so no proactive renewal
    const reissued = makeJwt(24 * 60 * 60);
    getSessionCookie.mockResolvedValue(stored);
    reauthenticateManagedServer.mockResolvedValue(reissued);
    fetchMock.mockResolvedValueOnce(unauthorizedResponse());

    const user = await fetchMe(MANAGED);

    expect(user.id).toBe('u1');
    expect(reauthenticateManagedServer).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cookieHeaderOf(fetchMock.mock.calls[0])).toBe(`switch_auth=${stored}`);
    expect(cookieHeaderOf(fetchMock.mock.calls[1])).toBe(`switch_auth=${reissued}`);
  });

  it('surfaces unauthorized when the managed re-login fails', async () => {
    const stored = makeJwt(24 * 60 * 60);
    getSessionCookie.mockResolvedValue(stored);
    reauthenticateManagedServer.mockResolvedValue(null);
    fetchMock.mockResolvedValue(unauthorizedResponse());

    await expect(fetchMe(MANAGED)).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(reauthenticateManagedServer).toHaveBeenCalledOnce();
    // Only the initial attempt — no retry when re-login yields no token.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not attempt re-login on a 401 for a non-managed server', async () => {
    const stored = makeJwt(24 * 60 * 60);
    getSessionCookie.mockResolvedValue(stored);
    fetchMock.mockResolvedValue(unauthorizedResponse());

    await expect(fetchMe(SERVER)).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(reauthenticateManagedServer).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function jsonResponse(body: unknown): Response {
  return {
    status: 200,
    ok: true,
    json: async () => body,
    headers: { getSetCookie: () => [] },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errorResponse(status: number, body: string): Response {
  return {
    status,
    ok: false,
    json: async () => ({}),
    headers: { getSetCookie: () => [] },
    text: async () => body,
  } as unknown as Response;
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  const init = call[1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe('room creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(makeJwt(24 * 60 * 60));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps the bridge list, defaulting is_default to false when absent', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          bridge_id: 'b1',
          bridge_type: 'mattermost',
          display_name: 'Mattermost',
          status: 'active',
          is_default: true,
        },
        { bridge_id: 'b2', bridge_type: 'slack', display_name: 'Slack', status: 'stopped' },
      ]) as never
    );

    await expect(fetchBridges(SERVER)).resolves.toEqual([
      {
        id: 'b1',
        type: 'mattermost',
        displayName: 'Mattermost',
        status: 'active',
        isDefault: true,
      },
      { id: 'b2', type: 'slack', displayName: 'Slack', status: 'stopped', isDefault: false },
    ]);
  });

  it('always names a bridge and a channel type, never the internal-only escape hatch', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'room-1',
        name: 'design',
        description: 'd',
        channel_type: 'channel_public',
        agent_count: 1,
        bridge_display_name: 'Mattermost',
        owner_id: 'u1',
        archived: false,
        created_at: '2026-01-01T00:00:00Z',
      }) as never
    );

    const room = await createRoom(SERVER, {
      name: 'design',
      description: 'd',
      bridgeId: 'b1',
      agentIds: ['a1'],
    });

    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body).toMatchObject({
      name: 'design',
      description: 'd',
      bridge_id: 'b1',
      channel_type: 'channel_public',
      agent_ids: ['a1'],
    });
    expect(body).not.toHaveProperty('internal_only');
    expect(room.ownerId).toBe('u1');
  });

  it('sends blank instructions as null rather than an empty string', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'room-1',
        name: 'design',
        description: 'd',
        channel_type: 'channel_public',
        agent_count: 0,
        bridge_display_name: null,
        archived: false,
        created_at: '2026-01-01T00:00:00Z',
      }) as never
    );

    await createRoom(SERVER, {
      name: 'design',
      description: 'd',
      instructions: '   ',
      bridgeId: 'b1',
      agentIds: [],
    });

    expect(bodyOf(fetchMock.mock.calls[0]).instructions).toBeNull();
  });

  it("unwraps the gateway's detail envelope so a failure can be shown in the user's terms", async () => {
    fetchMock.mockResolvedValue(errorResponse(400, '{"detail":"Bridge not running: b1"}') as never);

    await expect(
      createRoom(SERVER, { name: 'x', description: 'y', bridgeId: 'b1', agentIds: [] })
    ).rejects.toMatchObject({ status: 400, detail: 'Bridge not running: b1' });
  });

  it('leaves detail unset when the error body is not a detail envelope', async () => {
    fetchMock.mockResolvedValue(errorResponse(502, '<html>bad gateway</html>') as never);

    await expect(
      createRoom(SERVER, { name: 'x', description: 'y', bridgeId: 'b1', agentIds: [] })
    ).rejects.toMatchObject({ status: 502, detail: undefined });
  });
});

describe('registerKnownAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(makeJwt(24 * 60 * 60));
    fetchMock.mockImplementation(
      async () =>
        ({
          status: 200,
          ok: true,
          json: async () => ({ id: 'sw-1', api_key: 'tok-123' }),
          headers: { getSetCookie: () => [] },
          text: async () => '',
        }) as unknown as Response
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the caller-supplied agent_type rather than a hardcoded default', async () => {
    // The type governs the connector label and the hand-onboarding command the
    // gateway shows, so a default here would silently mislabel every non-Claude
    // agent (CHOO-1436).
    const registered = await registerKnownAgent(SERVER, {
      name: 'codex-hoot',
      description: 'Codex running in repo',
      agentType: 'codex',
      options: { channels_enabled: true, repo_dir: '/repo' },
    });

    expect(registered).toEqual({ id: 'sw-1', apiKey: 'tok-123' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      agent_type: 'codex',
      name: 'codex-hoot',
      description: 'Codex running in repo',
      options: { channels_enabled: true, repo_dir: '/repo' },
      overwrite: false,
    });
  });
});
