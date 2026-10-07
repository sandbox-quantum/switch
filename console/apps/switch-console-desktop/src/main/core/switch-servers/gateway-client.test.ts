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
const setSessionCookie = vi.hoisted(() => vi.fn());
/** The real cookie parse, so a missing cookie is read the way the client reads it. */
const extractAuthCookie = vi.hoisted(() =>
  vi.fn((setCookies: string[]) => {
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      if (pair?.startsWith('switch_auth=')) return pair.slice('switch_auth='.length);
    }
    return null;
  })
);

const managedServerHostBlocked = vi.hoisted(() => vi.fn<() => HostReachability | null>(() => null));
const managedServerStoppedPhase = vi.hoisted(() =>
  vi.fn<() => LocalServerPhase | null>(() => null)
);
const noteManagedServerUnanswered = vi.hoisted(() => vi.fn());

vi.mock('@main/core/managed-switch-server/managed-server-status', () => ({
  managedServerHostBlocked,
  managedServerStoppedPhase,
  noteManagedServerUnanswered,
}));

vi.mock('./servers-store', () => ({ getSessionCookie, setSessionCookie }));
vi.mock('./auth', () => ({ refreshSession, reauthenticateManagedServer, extractAuthCookie }));
vi.mock('./console-identity', () => ({
  consoleIdentityHeaders: async (server: { managed: boolean }) =>
    server.managed
      ? { 'X-Switch-Console-Id': 'console-1', 'X-Switch-Console-Name': 'alice@laptop' }
      : {},
}));

const {
  getConnectionCatalog,
  getGitHubConnection,
  startGitHubConnection,
  completeGitHubConnection,
  confirmGitHubConnection,
  getClaudeConnection,
  getCloudProviderConnection,
  connectClaude,
  disconnectClaude,
  acceptInvitation,
  acceptPendingInvitation,
  beginMessagingAppInstall,
  fetchInstallablePlatforms,
  fetchPendingInvitations,
  fetchJoinableWorkspaces,
  joinWorkspaceByDomain,
  fetchJoinDomains,
  addJoinDomain,
  removeJoinDomain,
  createInvitation,
  fetchInvitations,
  fetchInviteEmailEnabled,
  createRoom,
  deleteBridge,
  cloudMachineLifecycle,
  ensureCloudMachine,
  fetchAuthConfig,
  fetchBridges,
  fetchMe,
  ownsOwnerAddressedAgent,
  registerKnownAgent,
  updateAgentDisplayName,
  updateBridge,
  AgentManagementUnavailableError,
  enrollConsoleController,
  fetchAdvancedConfigSchema,
  fetchManagedAgent,
  fetchManagedAgents,
  managementErrorCode,
  managementErrorMessage,
  revokeManagementController,
  updateManagementController,
  fetchManagementControllers,
  fetchAgentManagementAccess,
  updateCanManageAgents,
  updateManagedAgent,
  putManagedAgent,
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

describe('gatewayFetch console attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async () => okMeResponse());
    getSessionCookie.mockResolvedValue(makeJwt(2 * 60 * 60));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function headersOf(call: unknown[] | undefined): Record<string, string> {
    return ((call?.[1] as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;
  }

  it('says which Console is calling a server it manages', async () => {
    await fetchMe(MANAGED);

    expect(headersOf(fetchMock.mock.calls[0])).toMatchObject({
      'X-Switch-Console-Id': 'console-1',
      'X-Switch-Console-Name': 'alice@laptop',
    });
  });

  it('keeps saying so on the retry after a silent re-login', async () => {
    reauthenticateManagedServer.mockResolvedValue(makeJwt(24 * 60 * 60));
    fetchMock.mockResolvedValueOnce(unauthorizedResponse());

    await fetchMe(MANAGED);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersOf(fetchMock.mock.calls[1])).toMatchObject({
      'X-Switch-Console-Id': 'console-1',
    });
  });

  it('asks for the host to be read again when a managed server does not answer', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(fetchMe(MANAGED)).rejects.toThrow(/Could not reach/);

    expect(noteManagedServerUnanswered).toHaveBeenCalledExactlyOnceWith(MANAGED);
  });

  it('tells a server someone else runs nothing about the desktop', async () => {
    await fetchMe(SERVER);

    const headers = headersOf(fetchMock.mock.calls[0]);
    expect(headers).not.toHaveProperty('X-Switch-Console-Id');
    expect(headers).not.toHaveProperty('X-Switch-Console-Name');
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

  it('carries the code of a coded refusal beside its detail', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(
        409,
        '{"detail":"The owner stopped the cloud machine. Start it in Switch Console.","code":"machine_stopped"}'
      ) as never
    );

    await expect(cloudMachineLifecycle(SERVER, 'machine-1', 'retry', 3)).rejects.toMatchObject({
      status: 409,
      detail: 'The owner stopped the cloud machine. Start it in Switch Console.',
      code: 'machine_stopped',
    });
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

describe('cloud agent edits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(makeJwt(24 * 60 * 60));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PUTs a display name, or null to clear it', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'a1',
        name: 'helper',
        display_name: 'Helper',
        description: '',
        connector_type: 'mcp',
        owner_name: 'Ada',
        known_agent_type: null,
        created_at: '2026-01-01T00:00:00Z',
      }) as never
    );

    const agent = await updateAgentDisplayName(SERVER, 'a1', 'Helper');
    await updateAgentDisplayName(SERVER, 'a1', null);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe('https://switch.example.com/gateway/agents/a1/display-name');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ display_name: 'Helper' });
    const [, cleared] = fetchMock.mock.calls[1] as unknown as [string, { body: string }];
    expect(JSON.parse(cleared.body)).toEqual({ display_name: null });
    expect(agent.displayName).toBe('Helper');
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

describe('Claude cloud connection transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(makeJwt(7200));
  });
  afterEach(() => vi.unstubAllGlobals());
  it('refuses to send provider credentials over HTTP', async () => {
    await expect(
      connectClaude(
        {
          id: 'insecure',
          name: 'Insecure',
          gatewayUrl: 'http://switch.example.com',
          managed: false,
        } as never,
        'api-key',
        'SYNTHETIC'
      )
    ).rejects.toThrow('HTTPS');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('sends the credential only in an authenticated PUT body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'connected',
          kind: 'api-key',
          verified_at: '2026-01-01T00:00:00Z',
        })
      )
    );
    await connectClaude(SERVER, 'api-key', 'SYNTHETIC-CREDENTIAL');
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://switch.example.com/gateway/provider-connections/claude');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body as string)).toEqual({
      kind: 'api-key',
      credential: 'SYNTHETIC-CREDENTIAL',
    });
    expect(cookieHeaderOf(fetchMock.mock.calls[0])).toContain('switch_auth=');
  });
  it('reads metadata and deletes without a credential body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'not_connected' })));
    expect(await getClaudeConnection(SERVER)).toEqual({ status: 'not_connected' });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await disconnectClaude(SERVER);
    const [, options] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(options.method).toBe('DELETE');
    expect(options.body).toBeUndefined();
  });
  it('reads a login the cloud controller can no longer use as needing reconnecting', async () => {
    const reconnect = {
      status: 'reconnect_required',
      kind: 'setup-token',
      verified_at: '2026-01-01 00:00:00+00:00',
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(reconnect)));
    expect(await getClaudeConnection(SERVER)).toEqual(reconnect);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...reconnect, kind: 'api-key' }))
    );
    expect(await getCloudProviderConnection(SERVER, 'cursor')).toEqual({
      ...reconnect,
      kind: 'api-key',
    });
  });
  it('rejects malformed connection status', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'connected', kind: 'unknown' }))
    );
    await expect(getClaudeConnection(SERVER)).rejects.toThrow('invalid Claude connection status');
  });
  it('surfaces a failed verification instead of reporting a connection', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'Claude could not complete the check.' }), {
        status: 422,
      })
    );
    await expect(connectClaude(SERVER, 'api-key', 'SYNTHETIC-CREDENTIAL')).rejects.toThrow();
  });
});

describe('GitHub connection transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(makeJwt(7200));
  });
  afterEach(() => vi.unstubAllGlobals());
  it('sends objects, encoded once, for start, complete and confirm', async () => {
    const state = 'a'.repeat(43);
    const input = { port: 12345, state, completion_secret: 'b'.repeat(43) };
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: state,
          url: `https://switch.example.com/gateway/provider-connections/github/authorize?state=${state}`,
        })
      )
    );
    await startGitHubConnection(SERVER, input);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await completeGitHubConnection(SERVER, state, 'SYNTHETIC-CODE', input.completion_secret);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await confirmGitHubConnection(SERVER, state, input.completion_secret);
    const bodies = (fetchMock.mock.calls as unknown[][]).map((call) =>
      JSON.parse((call[1] as RequestInit).body as string)
    );
    expect(bodies).toEqual([
      input,
      { code: 'SYNTHETIC-CODE', completion_secret: input.completion_secret },
      { completion_secret: input.completion_secret },
    ]);
  });
  it('only accepts authorization URLs on the authenticated server', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'a'.repeat(43),
          url:
            'https://other.example.com/gateway/provider-connections/github/authorize?state=' +
            'a'.repeat(43),
        })
      )
    );
    await expect(
      startGitHubConnection(SERVER, {
        port: 12345,
        state: 'a'.repeat(43),
        completion_secret: 'b'.repeat(43),
      })
    ).rejects.toThrow('invalid GitHub authorization URL');
  });
  it('checks state matches the returned authorization id', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'a'.repeat(43),
          url: 'https://switch.example.com/gateway/provider-connections/github/authorize?state=wrong',
        })
      )
    );
    await expect(
      startGitHubConnection(SERVER, {
        port: 12345,
        state: 'a'.repeat(43),
        completion_secret: 'b'.repeat(43),
      })
    ).rejects.toThrow('invalid GitHub authorization URL');
  });
  it('validates repository status and strips unexpected secrets', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'connected',
          login: 'example-user',
          install_url: 'https://github.com/apps/example/installations/new',
          installations: [],
          access_token: 'SYNTHETIC',
        })
      )
    );
    expect(await getGitHubConnection(SERVER)).not.toHaveProperty('access_token');
  });
  it('reads the connection catalog and rejects an unknown status', async () => {
    const github = {
      slug: 'github',
      name: 'GitHub',
      category: 'Source control',
      description: 'Repositories.',
      enabled: true,
      auth_type: 'oauth',
      status: 'connected',
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ connections: [github] })));
    expect(await getConnectionCatalog(SERVER)).toEqual([github]);
    const [url] = fetchMock.mock.calls.at(-1) as unknown as [string];
    expect(url).toBe('https://switch.example.com/gateway/provider-connections/catalog');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ connections: [{ ...github, status: 'pending' }] }))
    );
    await expect(getConnectionCatalog(SERVER)).rejects.toThrow();
  });
});

describe('sign-up support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(makeJwt(7200));
  });
  afterEach(() => vi.unstubAllGlobals());

  const config = {
    password_login_enabled: true,
    oidc_enabled: false,
    oidc_provider_label: null,
  };

  it('reads whether the server allows sign-up', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...config, signup_enabled: true }));
    await expect(fetchAuthConfig(SERVER)).resolves.toEqual({
      passwordLoginEnabled: true,
      oidcEnabled: false,
      oidcProviderLabel: null,
      signupEnabled: true,
    });
  });

  it('treats a server predating sign-up as not offering it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(config));
    expect((await fetchAuthConfig(SERVER)).signupEnabled).toBe(false);
  });

  it('warms the cloud machine with an authenticated POST', async () => {
    const machine = {
      machine_id: 'm-1',
      state: 'provisioning',
      desired_state: 'running',
      stop_reason: null,
      sleeping: false,
      revision: 1,
      instance_type: null,
      error: null,
      error_code: null,
      retain_until: null,
      heartbeat_at: null,
      controller_id: null,
      disk: null,
      memory: null,
      agents: [],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(machine));
    await expect(ensureCloudMachine(SERVER)).resolves.toEqual(machine);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://switch.example.com/gateway/hosted-machines/ensure');
    expect(options.method).toBe('POST');
    expect(cookieHeaderOf(fetchMock.mock.calls[0])).toContain('switch_auth=');
  });

  it('raises the server’s explanation when no machine can be had', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(503, JSON.stringify({ detail: 'Cloud machines are not offered here.' }))
    );
    await expect(ensureCloudMachine(SERVER)).rejects.toThrow(
      new Error('Cloud machines are not offered here.')
    );
  });
});

describe('acceptInvitation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(makeJwt(24 * 60 * 60));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function acceptedResponse(setCookies: string[]): Response {
    return {
      status: 200,
      ok: true,
      json: async () => ({ id: 't1', slug: 'cryo', name: 'Cryo Team', role: 'member' }),
      headers: { getSetCookie: () => setCookies },
      text: async () => '',
    } as unknown as Response;
  }

  it('sends the token in the body and keeps the workspace-scoped cookie', async () => {
    fetchMock.mockResolvedValue(
      acceptedResponse(['switch_auth=scoped; Path=/; HttpOnly']) as never
    );

    const tenant = await acceptInvitation(SERVER, 'tok-1');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe('https://switch.example.com/gateway/invitations/accept');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ token: 'tok-1' });
    expect(setSessionCookie).toHaveBeenCalledExactlyOnceWith('srv-1', 'scoped');
    expect(tenant).toEqual({ id: 't1', slug: 'cryo', name: 'Cryo Team', role: 'member' });
  });

  it('raises when the server joins the workspace but sends no cookie', async () => {
    fetchMock.mockResolvedValue(acceptedResponse([]) as never);

    await expect(acceptInvitation(SERVER, 'tok-1')).rejects.toThrow(/no session cookie/);
    expect(setSessionCookie).not.toHaveBeenCalled();
  });

  it("surfaces the server's reason for refusing", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(403, JSON.stringify({ detail: 'This invitation has expired' })) as never
    );

    await expect(acceptInvitation(SERVER, 'tok-1')).rejects.toMatchObject({
      status: 403,
      detail: 'This invitation has expired',
    });
  });
});

describe("installing the deployment's own messaging app", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(makeJwt(24 * 60 * 60));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists the platforms the deployment has an app for', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ platforms: ['slack'] }) as never);

    await expect(fetchInstallablePlatforms(SERVER)).resolves.toEqual(['slack']);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://switch.example.com/gateway/messaging-apps'
    );
  });

  it('reads a server without the route as having no app to install', async () => {
    fetchMock.mockResolvedValue(errorResponse(404, '{"detail":"Not Found"}') as never);

    await expect(fetchInstallablePlatforms(SERVER)).resolves.toEqual([]);
  });

  it('raises on any other failure', async () => {
    fetchMock.mockResolvedValue(errorResponse(403, '{"detail":"Forbidden"}') as never);

    await expect(fetchInstallablePlatforms(SERVER)).rejects.toMatchObject({ status: 403 });
  });

  it('starts an install and returns the consent URL', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ authorize_url: 'https://slack.example/oauth?state=s' }) as never
    );

    await expect(beginMessagingAppInstall(SERVER, 'slack')).resolves.toBe(
      'https://slack.example/oauth?state=s'
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://switch.example.com/gateway/messaging-apps/slack/install');
    expect(init.method).toBe('POST');
  });

  it('raises when the deployment has no app for the platform', async () => {
    fetchMock.mockResolvedValue(errorResponse(501, '{"detail":"no app"}') as never);

    await expect(beginMessagingAppInstall(SERVER, 'slack')).rejects.toMatchObject({ status: 501 });
  });
});

describe('invitations addressed to the signed-in account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(makeJwt(24 * 60 * 60));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists them with the workspace and who invited you', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          id: 'inv-1',
          tenant_id: 't1',
          tenant_slug: 'cryo',
          tenant_name: 'Cryo Team',
          role: 'admin',
          expires_at: '2026-12-01T00:00:00+00:00',
          invited_by: 'Ada',
          created_at: '2026-11-24T00:00:00+00:00',
        },
      ]) as never
    );

    const listed = await fetchPendingInvitations(SERVER);

    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://switch.example.com/gateway/invitations/mine'
    );
    expect(listed).toEqual({
      kind: 'listed',
      invitations: [
        {
          id: 'inv-1',
          tenantId: 't1',
          workspaceName: 'Cryo Team',
          role: 'admin',
          expiresAt: '2026-12-01T00:00:00.000Z',
          invitedBy: 'Ada',
        },
      ],
    });
  });

  it('reads a server without the route as unable to say, not as none', async () => {
    fetchMock.mockResolvedValue(errorResponse(404, '{"detail":"Not Found"}') as never);

    await expect(fetchPendingInvitations(SERVER)).resolves.toEqual({ kind: 'unsupported' });
  });

  it('raises on any other failure', async () => {
    fetchMock.mockResolvedValue(errorResponse(500, 'boom') as never);

    await expect(fetchPendingInvitations(SERVER)).rejects.toMatchObject({ status: 500 });
  });

  it('accepts one by its workspace and id and keeps the workspace-scoped cookie', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ id: 't1', slug: 'cryo', name: 'Cryo Team', role: 'member' }),
      headers: { getSetCookie: () => ['switch_auth=scoped; Path=/; HttpOnly'] },
      text: async () => '',
    } as never);

    const tenant = await acceptPendingInvitation(SERVER, 't1', 'inv-1');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe('https://switch.example.com/gateway/invitations/mine/accept');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ tenant_id: 't1', invitation_id: 'inv-1' });
    expect(setSessionCookie).toHaveBeenCalledExactlyOnceWith('srv-1', 'scoped');
    expect(tenant).toEqual({ id: 't1', slug: 'cryo', name: 'Cryo Team', role: 'member' });
  });
});

describe('joining a workspace by e-mail domain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(makeJwt(24 * 60 * 60));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists the workspaces open to your domain', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          tenant_id: 't9',
          tenant_slug: 'skunk',
          tenant_name: 'Skunkworks',
          domain: 'acme.example',
        },
      ]) as never
    );

    const listed = await fetchJoinableWorkspaces(SERVER);

    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://switch.example.com/gateway/joinable-tenants'
    );
    expect(listed).toEqual({
      kind: 'listed',
      workspaces: [{ tenantId: 't9', workspaceName: 'Skunkworks', domain: 'acme.example' }],
    });
  });

  it('reads a server without the route as unable to say, not as none', async () => {
    fetchMock.mockResolvedValue(errorResponse(404, '{"detail":"Not Found"}') as never);

    await expect(fetchJoinableWorkspaces(SERVER)).resolves.toEqual({ kind: 'unsupported' });
    await expect(fetchJoinDomains(SERVER, 't1')).resolves.toEqual({ kind: 'unsupported' });
  });

  it('joins one and keeps the workspace-scoped cookie', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ id: 't9', slug: 'skunk', name: 'Skunkworks', role: 'member' }),
      headers: { getSetCookie: () => ['switch_auth=scoped; Path=/; HttpOnly'] },
      text: async () => '',
    } as never);

    const tenant = await joinWorkspaceByDomain(SERVER, 't9');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string }];
    expect(url).toBe('https://switch.example.com/gateway/joinable-tenants/t9/join');
    expect(init.method).toBe('POST');
    expect(setSessionCookie).toHaveBeenCalledExactlyOnceWith('srv-1', 'scoped');
    expect(tenant).toEqual({ id: 't9', slug: 'skunk', name: 'Skunkworks', role: 'member' });
  });

  it("reads a workspace's domains and the admin's own", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        domains: [
          { domain: 'acme.example', created_by: 'u1', created_at: '2026-11-24T00:00:00+00:00' },
        ],
        own_domain: 'acme.example',
        own_domain_refusal: null,
      }) as never
    );

    await expect(fetchJoinDomains(SERVER, 't1')).resolves.toEqual({
      kind: 'listed',
      domains: ['acme.example'],
      ownDomain: 'acme.example',
      ownDomainRefusal: null,
    });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://switch.example.com/gateway/tenants/t1/join-domains'
    );
  });

  it('adds and removes a domain', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}) as never);

    await addJoinDomain(SERVER, 't1', 'acme.example');
    await removeJoinDomain(SERVER, 't1', 'acme.example');

    const calls = fetchMock.mock.calls as unknown as [string, { method: string; body?: string }][];
    expect(calls[0]![0]).toBe('https://switch.example.com/gateway/tenants/t1/join-domains');
    expect(calls[0]![1].method).toBe('POST');
    expect(JSON.parse(calls[0]![1].body!)).toEqual({ domain: 'acme.example' });
    expect(calls[1]![0]).toBe(
      'https://switch.example.com/gateway/tenants/t1/join-domains/acme.example'
    );
    expect(calls[1]![1].method).toBe('DELETE');
  });

  it("surfaces the server's refusal of another domain", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(
        400,
        JSON.stringify({
          detail: 'You can only open the workspace to the domain of your own address, acme.example',
        })
      ) as never
    );

    await expect(addJoinDomain(SERVER, 't1', 'other.example')).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('workspace invitations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(makeJwt(24 * 60 * 60));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown): Response {
    return {
      status: 200,
      ok: true,
      json: async () => body,
      headers: { getSetCookie: () => [] },
      text: async () => '',
    } as unknown as Response;
  }

  const ROW = {
    id: 'inv-1',
    role: 'admin',
    email: 'ada@example.com',
    expires_at: '2026-10-05 12:00:00.123456+00:00',
    uses_remaining: 1,
    revoked_at: null,
    created_by: 'u1',
    created_at: '2026-09-28 12:00:00+00:00',
  };

  it("reads the server's timestamps as ISO, whatever separator it writes", async () => {
    fetchMock.mockResolvedValue(jsonResponse([ROW]) as never);

    const [invitation] = await fetchInvitations(SERVER, 'tenant 1');

    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://switch.example.com/gateway/tenants/tenant%201/invitations'
    );
    expect(invitation).toEqual({
      id: 'inv-1',
      role: 'admin',
      email: 'ada@example.com',
      expiresAt: '2026-10-05T12:00:00.123Z',
      usesRemaining: 1,
      revokedAt: null,
      createdAt: '2026-09-28T12:00:00.000Z',
    });
  });

  it('raises on a timestamp it cannot read rather than showing an invalid date', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ ...ROW, expires_at: 'soon' }]) as never);

    await expect(fetchInvitations(SERVER, 't1')).rejects.toThrow(/unreadable timestamp/);
  });

  it('posts the invitation and returns the token and what became of the e-mail', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ...ROW, token: 'tok-1', email_delivery: 'not_configured' }) as never
    );

    const created = await createInvitation(SERVER, 't1', {
      role: 'admin',
      email: 'ada@example.com',
      expiresInHours: 48,
      usesRemaining: 1,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; body: string },
    ];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      role: 'admin',
      email: 'ada@example.com',
      expires_in_hours: 48,
      uses_remaining: 1,
    });
    expect(created.token).toBe('tok-1');
    expect(created.emailDelivery).toBe('not_configured');
  });

  it('reads a server older than e-mailed invitations as not sending them', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ state: 'ready' }) as never);
    await expect(fetchInviteEmailEnabled(SERVER)).resolves.toBeNull();

    fetchMock.mockResolvedValue(errorResponse(404, '{"detail":"Not Found"}') as never);
    await expect(fetchInviteEmailEnabled(SERVER)).resolves.toBeNull();
  });

  it('keeps the link when an older server says nothing about the e-mail', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...ROW, token: 'tok-1' }) as never);

    const created = await createInvitation(SERVER, 't1', {
      role: 'member',
      email: 'ada@example.com',
      expiresInHours: 48,
      usesRemaining: 1,
    });

    expect(created.token).toBe('tok-1');
    expect(created.emailDelivery).toBe('unsupported');
  });
});

describe('agent management calls', () => {
  function respond(status: number, body: unknown): Response {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => JSON.parse(text),
      headers: { getSetCookie: () => [] },
      text: async () => text,
    } as unknown as Response;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(makeJwt(2 * 60 * 60));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('enrolls this Console as a controller of kind console', async () => {
    fetchMock.mockImplementation(async () =>
      respond(201, { controller_id: 'controller-1', credential: 'swcc_placeholder' })
    );
    const enrolled = await enrollConsoleController(SERVER, {
      name: 'build-box',
      platform: { os: 'linux', arch: 'x64', os_version: '6.1.0' },
      version: '0.1.0',
    });
    expect(enrolled).toEqual({ controllerId: 'controller-1', credential: 'swcc_placeholder' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://switch.example.com/gateway/management/controllers');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'build-box',
      kind: 'console',
      platform: { os: 'linux', arch: 'x64', os_version: '6.1.0' },
      version: '0.1.0',
    });
  });

  it('reads a bare 404 as a server without agent management, and an enveloped one as a refusal', async () => {
    fetchMock.mockImplementation(async () => respond(404, { detail: 'Not Found' }));
    await expect(fetchManagedAgents(SERVER)).rejects.toBeInstanceOf(
      AgentManagementUnavailableError
    );

    fetchMock.mockImplementation(async () =>
      respond(404, {
        error: { code: 'not_found', message: 'Controller not found', retryable: false },
      })
    );
    const refusal = await revokeManagementController(SERVER, 'controller-1').catch(
      (error: unknown) => error
    );
    expect(refusal).not.toBeInstanceOf(AgentManagementUnavailableError);
    expect(managementErrorCode(refusal)).toBe('not_found');
    expect(managementErrorMessage(refusal)).toBe('Controller not found');
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(url).toBe('https://switch.example.com/gateway/management/controllers/controller-1');
    expect(init.method).toBe('DELETE');
  });

  it('reads machine descriptions and renames or describes a machine', async () => {
    fetchMock.mockImplementation(async () =>
      respond(200, [
        {
          id: 'controller-1',
          name: 'box',
          description: 'The office box',
          kind: 'console',
          state: 'online',
          last_seen_at: null,
          revoked_at: null,
          workspaces_dir: '/data/workspaces',
        },
      ])
    );
    const [machine] = await fetchManagementControllers(SERVER);
    expect(machine?.description).toBe('The office box');
    expect(machine?.workspacesDir).toBe('/data/workspaces');

    fetchMock.mockImplementation(async () => respond(200, {}));
    await updateManagementController(SERVER, 'controller-1', { name: 'laptop', description: null });
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(url).toBe('https://switch.example.com/gateway/management/controllers/controller-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'laptop', description: null });
  });

  it("reads each machine's providers from its last status report, and invents none", async () => {
    const controller = {
      name: 'box',
      description: null,
      kind: 'daemon',
      state: 'online',
      last_seen_at: null,
      revoked_at: null,
    };
    fetchMock.mockImplementation(async () =>
      respond(200, [
        {
          ...controller,
          id: 'reported',
          status: {
            providers: [
              {
                provider: 'claude',
                installed: true,
                version: '2.1.0',
                auth: 'ok',
                auth_source: 'local',
                checked_at: '2026-01-01T00:00:00Z',
              },
              { provider: 'codex', installed: true, auth: 'something-new' },
              { provider: 'opencode', installed: false, auth: 'unknown' },
              { installed: true, auth: 'ok' },
              'garbage',
            ],
          },
        },
        { ...controller, id: 'silent', status: null },
        { ...controller, id: 'odd', status: { providers: 'none' } },
        { ...controller, id: 'old' },
      ])
    );
    const machines = await fetchManagementControllers(SERVER);
    expect(machines.map((machine) => machine.workspacesDir)).toEqual([null, null, null, null]);
    expect(machines.map((machine) => [machine.id, machine.providers])).toEqual([
      [
        'reported',
        [
          { provider: 'claude', installed: true, auth: 'ok' },
          { provider: 'codex', installed: true, auth: 'unknown' },
          { provider: 'opencode', installed: false, auth: 'unknown' },
        ],
      ],
      ['silent', []],
      ['odd', []],
      ['old', []],
    ]);
  });

  it("reads an agent's 'can manage agents', and whether management runs at all", async () => {
    // The agent's detail, then the management probe.
    fetchMock
      .mockImplementationOnce(async () => respond(200, { id: 'agent-1', can_manage_agents: true }))
      .mockImplementationOnce(async () => respond(404, { detail: 'Not Found' }));
    expect(await fetchAgentManagementAccess(SERVER, 'agent-1')).toEqual({
      available: false,
      canManageAgents: true,
    });
    fetchMock
      .mockImplementationOnce(async () => respond(200, { id: 'agent-1', can_manage_agents: false }))
      .mockImplementationOnce(async () => respond(200, []));
    expect(await fetchAgentManagementAccess(SERVER, 'agent-1')).toEqual({
      available: true,
      canManageAgents: false,
    });

    fetchMock.mockImplementation(async () => respond(200, {}));
    await updateCanManageAgents(SERVER, 'agent-1', true);
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(url).toBe('https://switch.example.com/gateway/agents/agent-1/can-manage-agents');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ enabled: true });
  });

  it('changes a managed agent’s settings over the server’s copy, keeping fields it does not know', async () => {
    fetchMock
      .mockImplementationOnce(async () =>
        respond(200, {
          agent_id: 'agent-1',
          definition: { provider: 'claude', model: 'opus', future_field: 7 },
        })
      )
      .mockImplementationOnce(async () => respond(200, {}));
    await updateManagedAgent(SERVER, 'agent-1', {
      definition: { advanced_config: { effort: 'high', tools: ['Read'] } },
      controllerId: 'controller-2',
    });
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(url).toBe('https://switch.example.com/gateway/management/agents/agent-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({
      definition: {
        provider: 'claude',
        model: 'opus',
        future_field: 7,
        advanced_config: { effort: 'high', tools: ['Read'] },
      },
      controller_id: 'controller-2',
    });
  });

  it('carries the repository the server holds over a PUT of the definition', async () => {
    const definition = {
      provider: 'claude',
      model: null,
      advanced_config: {},
      instructions: '',
      auto_approve: false,
      directory: null,
    };
    const repository = { installation_id: 7, repository_id: 42 };
    fetchMock
      .mockImplementationOnce(async () =>
        respond(200, { agent_id: 'agent-1', definition: { ...definition, repository } })
      )
      .mockImplementationOnce(async () => respond(200, {}));
    await putManagedAgent(SERVER, 'agent-1', {
      controller_id: 'controller-1',
      desired_state: 'running',
      definition: { ...definition, instructions: 'Be brief.' },
    });
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(url).toBe('https://switch.example.com/gateway/management/agents/agent-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      controller_id: 'controller-1',
      desired_state: 'running',
      definition: { ...definition, instructions: 'Be brief.', repository },
    });

    fetchMock
      .mockImplementationOnce(async () =>
        respond(404, { error: { code: 'not_found', message: 'Agent not found', retryable: false } })
      )
      .mockImplementationOnce(async () => respond(200, {}));
    await putManagedAgent(SERVER, 'agent-2', {
      controller_id: 'controller-1',
      desired_state: 'running',
      definition,
    });
    const [, adopted] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(JSON.parse(String(adopted.body)).definition).toEqual(definition);
  });

  it('does not PUT a definition when the server’s copy could not be read', async () => {
    fetchMock.mockImplementation(async () =>
      respond(403, { error: { code: 'forbidden', message: 'Not yours', retryable: false } })
    );
    await expect(
      putManagedAgent(SERVER, 'agent-1', {
        controller_id: null,
        desired_state: 'stopped',
        definition: {
          provider: 'claude',
          model: null,
          advanced_config: {},
          instructions: '',
          auto_approve: false,
          directory: null,
        },
      })
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps managed agents, definition and last report included', async () => {
    fetchMock.mockImplementation(async () =>
      respond(200, [
        {
          agent_id: 'agent-1',
          name: 'scout',
          display_name: 'Scout',
          icon_url: 'https://icons.example.test/scout.png',
          description: 'Finds things',
          controller_id: 'controller-1',
          desired_state: 'running',
          revision: 3,
          definition: {
            provider: 'claude',
            model: 'opus',
            advanced_config: { effort: 'high', maxTurns: 4, background: true, tools: ['Read'] },
            instructions: 'Be brief.',
            auto_approve: true,
            directory: '/work/scout',
            isolation: 'isolated',
          },
          status: {
            process: 'failed',
            attached: false,
            reason: 'crash_loop',
            detail: 'x',
            directory: '/work/scout',
          },
        },
        {
          agent_id: 'agent-3',
          name: 'older',
          display_name: null,
          controller_id: 'controller-1',
          desired_state: 'running',
          definition: { provider: 'codex', directory: null },
          status: { process: 'running', attached: true },
        },
        {
          agent_id: 'agent-2',
          name: 'idle',
          display_name: null,
          controller_id: null,
          desired_state: 'stopped',
          definition: {},
          status: null,
        },
      ])
    );
    expect(await fetchManagedAgents(SERVER)).toEqual([
      {
        agentId: 'agent-1',
        name: 'scout',
        displayName: 'Scout',
        iconUrl: 'https://icons.example.test/scout.png',
        description: 'Finds things',
        controllerId: 'controller-1',
        desiredState: 'running',
        revision: 3,
        provider: 'claude',
        model: 'opus',
        advancedConfig: { effort: 'high', maxTurns: 4, background: true, tools: ['Read'] },
        instructions: 'Be brief.',
        isolation: 'isolated',
        directory: '/work/scout',
        autoApprove: true,
        status: {
          process: 'failed',
          attached: false,
          reason: 'crash_loop',
          detail: 'x',
          directory: '/work/scout',
        },
      },
      {
        agentId: 'agent-3',
        name: 'older',
        displayName: null,
        iconUrl: null,
        description: '',
        controllerId: 'controller-1',
        desiredState: 'running',
        revision: 0,
        provider: 'codex',
        model: null,
        advancedConfig: {},
        instructions: '',
        isolation: 'shared',
        directory: null,
        autoApprove: false,
        status: { process: 'running', attached: true, reason: null, detail: null, directory: null },
      },
      {
        agentId: 'agent-2',
        name: 'idle',
        displayName: null,
        iconUrl: null,
        description: '',
        controllerId: null,
        desiredState: 'stopped',
        revision: 0,
        provider: 'unknown',
        model: null,
        advancedConfig: {},
        instructions: '',
        isolation: 'shared',
        directory: null,
        autoApprove: false,
        status: null,
      },
    ]);
  });

  it('refuses an advanced configuration of a shape no field takes rather than dropping it', async () => {
    fetchMock.mockImplementation(async () =>
      respond(200, {
        agent_id: 'agent-1',
        name: 'scout',
        display_name: null,
        controller_id: null,
        desired_state: 'running',
        definition: { provider: 'claude', advanced_config: { tools: [1, 2] } },
        status: null,
      })
    );
    await expect(fetchManagedAgent(SERVER, 'agent-1')).rejects.toThrow(
      /advanced configuration for managed agent agent-1/
    );
  });

  it('reads each provider’s advanced configuration fields in Console’s field shape', async () => {
    fetchMock.mockImplementation(async () =>
      respond(200, {
        providers: {
          opencode: {
            fields: [
              {
                key: 'variant',
                label: 'Reasoning variant',
                type: 'text',
                help: 'Follows the model.',
                placeholder: null,
                options: null,
                catalogue: { kind: 'model-variant', model_field: 'model' },
              },
              {
                key: 'smallModel',
                label: 'Utility model',
                type: 'text',
                help: null,
                placeholder: 'e.g. local/model',
                options: null,
                catalogue: { kind: 'model' },
              },
              {
                key: 'webSearch',
                label: 'Web search',
                type: 'select',
                help: null,
                placeholder: null,
                options: [
                  { value: '', label: 'Default' },
                  { value: 'true', label: 'On' },
                ],
                catalogue: null,
              },
            ],
          },
          cursor: { fields: [] },
        },
      })
    );
    expect(await fetchAdvancedConfigSchema(SERVER)).toEqual({
      opencode: [
        {
          key: 'variant',
          label: 'Reasoning variant',
          type: 'text',
          help: 'Follows the model.',
          catalogue: { kind: 'model-variant', modelField: 'model' },
        },
        {
          key: 'smallModel',
          label: 'Utility model',
          type: 'text',
          placeholder: 'e.g. local/model',
          catalogue: { kind: 'model' },
        },
        {
          key: 'webSearch',
          label: 'Web search',
          type: 'select',
          options: [
            { value: '', label: 'Default' },
            { value: 'true', label: 'On' },
          ],
        },
      ],
      cursor: [],
    });
    const [url] = fetchMock.mock.calls.at(-1) as unknown as [string];
    expect(url).toBe('https://switch.example.com/gateway/management/advanced-config');
  });

  it('refuses an advanced configuration schema it cannot read', async () => {
    fetchMock.mockImplementation(async () =>
      respond(200, { providers: { claude: { fields: [{ key: 'tools', type: 'grid' }] } } })
    );
    await expect(fetchAdvancedConfigSchema(SERVER)).rejects.toThrow();
  });
});
