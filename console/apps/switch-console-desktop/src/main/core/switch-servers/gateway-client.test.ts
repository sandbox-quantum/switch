import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type LocalServerPhase,
  ManagedServerStoppedError,
} from '@shared/core/managed-switch-server/managed-switch-server';
import {
  type HostReachability,
  HostUnreachableError,
  unknownHostReachability,
} from '@shared/core/remote-hosts/reachability';
import { ownerOnlyPolicy } from '@shared/core/switch-servers/owner-policy';

const getSessionCookie = vi.hoisted(() => vi.fn());
const refreshSession = vi.hoisted(() => vi.fn());
const reauthenticateManagedServer = vi.hoisted(() => vi.fn());

const managedServerHostBlocked = vi.hoisted(() => vi.fn<() => HostReachability | null>(() => null));
const managedServerStoppedPhase = vi.hoisted(() =>
  vi.fn<() => LocalServerPhase | null>(() => null)
);

vi.mock('@main/core/managed-switch-server/managed-server-status', () => ({
  managedServerHostBlocked,
  managedServerStoppedPhase,
}));

vi.mock('./servers-store', () => ({ getSessionCookie }));
vi.mock('./auth', () => ({ refreshSession, reauthenticateManagedServer }));

const {
  createRoom,
  deleteBridge,
  fetchBridges,
  fetchMe,
  ownsOwnerAddressedAgent,
  registerKnownAgent,
  updateBridge,
} = await import('./gateway-client');

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

describe('gatewayFetch host reachability gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    managedServerHostBlocked.mockReturnValue(null);
    vi.unstubAllGlobals();
  });

  it('fails with the host state, without touching the network or the session', async () => {
    managedServerHostBlocked.mockReturnValue({
      ...unknownHostReachability('vm'),
      status: 'unreachable',
      lastError: 'connect ETIMEDOUT',
    });

    await expect(fetchMe(MANAGED)).rejects.toBeInstanceOf(HostUnreachableError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getSessionCookie).not.toHaveBeenCalled();
  });
});

describe('gatewayFetch managed-stack gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    managedServerStoppedPhase.mockReturnValue(null);
    vi.unstubAllGlobals();
  });

  it('fails with the lifecycle state, without touching the network or the session', async () => {
    managedServerStoppedPhase.mockReturnValue('stopped');

    await expect(fetchMe(MANAGED)).rejects.toBeInstanceOf(ManagedServerStoppedError);
    expect(fetchMock).not.toHaveBeenCalled();
    // The renewal that would otherwise warn about the same absence never runs.
    expect(getSessionCookie).not.toHaveBeenCalled();
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it('names the server, so the failure reads as the state the user is looking at', async () => {
    managedServerStoppedPhase.mockReturnValue('stopped');
    await expect(fetchMe(MANAGED)).rejects.toThrow(/Local's Switch stack is not running/);
  });

  it('lets calls through while the stack is up', async () => {
    getSessionCookie.mockResolvedValue(makeJwt(24 * 60 * 60));
    fetchMock.mockResolvedValue(okMeResponse());
    await fetchMe(MANAGED);
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

  it('maps the bridge list, defaulting is_default and home_url when absent', async () => {
    // `home_url` post-dates the pinned switch-core, so a current server omits
    // it entirely — that has to read as "no link", not undefined.
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          bridge_id: 'b1',
          bridge_type: 'mattermost',
          display_name: 'Mattermost',
          status: 'active',
          is_default: true,
          home_url: 'mattermost://chat.example.com/switch',
          channel_creation_supported: true,
          channel_creation_enabled: true,
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
        homeUrl: 'mattermost://chat.example.com/switch',
        channelCreationSupported: true,
        canCreateChannels: true,
        directorySearchSupported: true,
      },
      {
        id: 'b2',
        type: 'slack',
        displayName: 'Slack',
        status: 'stopped',
        isDefault: false,
        homeUrl: null,
        // Both fields post-date the pinned switch-core too, defaulting the
        // same way home_url does: absent reads as the pre-capability world,
        // where every bridge could create a channel.
        channelCreationSupported: true,
        canCreateChannels: true,
        directorySearchSupported: true,
      },
    ]);
  });

  it('reads the effective answer as the platform ceiling ANDed with the operator switch', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          bridge_id: 'b1',
          bridge_type: 'telegram',
          display_name: 'Telegram',
          status: 'active',
          channel_creation_supported: false,
          channel_creation_enabled: true,
        },
        {
          bridge_id: 'b2',
          bridge_type: 'slack',
          display_name: 'Slack',
          status: 'active',
          channel_creation_supported: true,
          channel_creation_enabled: false,
        },
      ]) as never
    );

    const [telegram, slack] = await fetchBridges(SERVER);

    // Telegram: the platform ceiling is the binding constraint, regardless of
    // what an operator's switch says.
    expect(telegram).toMatchObject({ channelCreationSupported: false, canCreateChannels: false });
    // Slack: the platform can, but the operator withheld it from this connection.
    expect(slack).toMatchObject({ channelCreationSupported: true, canCreateChannels: false });
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
      iconUrl: null,
      displayName: null,
    });

    expect(registered).toEqual({ id: 'sw-1', apiKey: 'tok-123' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      agent_type: 'codex',
      name: 'codex-hoot',
      description: 'Codex running in repo',
      options: { channels_enabled: true, repo_dir: '/repo' },
      icon_url: null,
      display_name: null,
      overwrite: false,
    });
  });

  it('sends the human display name alongside the identifier', async () => {
    // The two are different strings on purpose: `name` routes, `display_name`
    // is what a chat platform renders. Dropping the label here would leave the
    // create form's field with nowhere to land.
    await registerKnownAgent(SERVER, {
      name: 'switch-dev',
      description: 'Codex running in repo',
      agentType: 'codex',
      options: { channels_enabled: true, repo_dir: '/repo' },
      iconUrl: null,
      displayName: 'Switch Dev',
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({
      name: 'switch-dev',
      display_name: 'Switch Dev',
    });
  });
});

describe('ownsOwnerAddressedAgent', () => {
  let listedAgents: unknown[] = [];
  const routedFetch = vi.fn<(url: string) => Promise<Response>>();

  /** An agent as `GET /agents` returns it, with only the fields the probe uses
   * spelled out per case. */
  function listedAgent(fields: {
    id: string;
    owner_id: string | null;
    addressing_policy?: unknown;
  }): unknown {
    return {
      name: fields.id,
      description: '',
      connector_type: 'http',
      owner_name: null,
      known_agent_type: null,
      created_at: '2026-01-01T00:00:00Z',
      ...fields,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    listedAgents = [];
    // `GET /auth/me` answers as `u1`; everything else is the agent list.
    routedFetch.mockImplementation(async (url: string) =>
      url.endsWith('/auth/me') ? okMeResponse() : jsonResponse(listedAgents)
    );
    vi.stubGlobal('fetch', routedFetch);
    getSessionCookie.mockResolvedValue(makeJwt(24 * 60 * 60));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the whole answer off the agent list', async () => {
    // The policy is on the list response now, so the probe costs `/auth/me`
    // plus `/agents` and nothing per agent — however many the user owns
    // (CHOO-2137).
    listedAgents = Array.from({ length: 20 }, (_, i) =>
      listedAgent({
        id: `a${i}`,
        owner_id: 'u1',
        addressing_policy: ownerOnlyPolicy(),
      })
    );

    await expect(ownsOwnerAddressedAgent(SERVER)).resolves.toBe(true);
    expect(routedFetch).toHaveBeenCalledTimes(2);
  });

  it('ignores an owner-restricted agent belonging to somebody else', async () => {
    listedAgents = [
      listedAgent({ id: 'theirs', owner_id: 'u2', addressing_policy: ownerOnlyPolicy() }),
    ];

    await expect(ownsOwnerAddressedAgent(SERVER)).resolves.toBe(false);
  });

  it('ignores an agent of the user’s that anyone may address', async () => {
    listedAgents = [
      listedAgent({ id: 'open', owner_id: 'u1', addressing_policy: null }),
      listedAgent({ id: 'rule-less', owner_id: 'u1', addressing_policy: { rules: [] } }),
    ];

    await expect(ownsOwnerAddressedAgent(SERVER)).resolves.toBe(false);
  });

  it('counts a hand-built policy that names the owner, not just the shortcut', async () => {
    // A rule set the chooser calls `custom` still leans on owner recognition,
    // so an unlinked account costs the user just as much there.
    listedAgents = [
      listedAgent({
        id: 'scoped',
        owner_id: 'u1',
        addressing_policy: {
          rules: [
            { rooms: ['room-1'], room_groups: '*', users: [], agents: [], owner: true },
            { rooms: '*', room_groups: '*', users: ['u9'], agents: [], owner: false },
          ],
        },
      }),
    ];

    await expect(ownsOwnerAddressedAgent(SERVER)).resolves.toBe(true);
  });

  it('stays quiet against a server that does not report policies on the list', async () => {
    // Older switch-core carries `addressing_policy` only on `GET /agents/{id}`.
    // Absent has to read as "nothing to warn about" rather than warn on a guess.
    listedAgents = [listedAgent({ id: 'unknown-policy', owner_id: 'u1' })];

    await expect(ownsOwnerAddressedAgent(SERVER)).resolves.toBe(false);
  });

  it('propagates a failed list read instead of answering false', async () => {
    // The caller turns a rejection into a log line and no warning; a false here
    // would be indistinguishable from a real "you own nothing restricted".
    routedFetch.mockImplementation(async (url: string) =>
      url.endsWith('/auth/me') ? okMeResponse() : errorResponse(503, 'gateway down')
    );

    await expect(ownsOwnerAddressedAgent(SERVER)).rejects.toMatchObject({ status: 503 });
  });
});

describe('updateBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(makeJwt(24 * 60 * 60));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PATCHes only the field given, leaving an unset one out of the body', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        bridge_id: 'b1',
        bridge_type: 'slack',
        display_name: 'Slack',
        status: 'active',
        channel_creation_supported: true,
        channel_creation_enabled: false,
      }) as never
    );

    const bridge = await updateBridge(SERVER, 'b1', { channelCreationEnabled: false });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe('https://switch.example.com/gateway/collaborations/b1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ channel_creation_enabled: false });
    expect(bridge).toMatchObject({ canCreateChannels: false, channelCreationSupported: true });
  });

  it('sends no field at all when nothing changed', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        bridge_id: 'b1',
        bridge_type: 'slack',
        display_name: 'Slack',
        status: 'active',
      }) as never
    );

    await updateBridge(SERVER, 'b1', {});

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({});
  });
});

describe('deleteBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(makeJwt(24 * 60 * 60));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('DELETEs the bridge and reports it deleted', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }) as never);

    await expect(deleteBridge(SERVER, 'b1')).resolves.toEqual({ kind: 'deleted' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string }];
    expect(url).toBe('https://switch.example.com/gateway/collaborations/b1');
    expect(init.method).toBe('DELETE');
  });

  it('escapes the bridge id into the path', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }) as never);

    await deleteBridge(SERVER, 'b/1 2');

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://switch.example.com/gateway/collaborations/b%2F1%202');
  });

  it('reports a non-admin as forbidden', async () => {
    fetchMock.mockResolvedValue(errorResponse(403, '{"detail":"Admin only"}') as never);

    await expect(deleteBridge(SERVER, 'b1')).resolves.toEqual({ kind: 'forbidden' });
  });

  it('reports an unknown bridge as not-found rather than deleted', async () => {
    // Somebody else's deletion, or a stale list — either way the rooms this
    // call would have taken with it were not this call's to take.
    fetchMock.mockResolvedValue(errorResponse(404, '{"detail":"Bridge not found"}') as never);

    await expect(deleteBridge(SERVER, 'gone')).resolves.toEqual({ kind: 'not-found' });
  });

  it('reports an expired session as unauthenticated', async () => {
    fetchMock.mockResolvedValue(unauthorizedResponse() as never);

    await expect(deleteBridge(SERVER, 'b1')).resolves.toEqual({ kind: 'unauthenticated' });
  });

  it('propagates a failure it has no case for instead of claiming success', async () => {
    fetchMock.mockResolvedValue(errorResponse(500, 'adapter shutdown failed') as never);

    await expect(deleteBridge(SERVER, 'b1')).rejects.toMatchObject({ status: 500 });
  });
});
