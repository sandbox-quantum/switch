import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Linking a messaging account, read off the wire (CHOO-3881).
 *
 * A current server holds a new link pending until a one-time code is posted
 * from the account, and hands the code back with the claim. A server from
 * before that links on the spot and sends no such field — Console talks to
 * both, so a missing field has to read as the old behaviour, never as a
 * pending link with no code.
 */

const getSessionCookie = vi.hoisted(() => vi.fn());

vi.mock('@main/core/managed-switch-server/managed-server-status', () => ({
  managedServerHostBlocked: vi.fn(() => null),
  managedServerStoppedPhase: vi.fn(() => null),
  noteManagedServerUnanswered: vi.fn(),
}));
vi.mock('./servers-store', () => ({ getSessionCookie, setSessionCookie: vi.fn() }));
vi.mock('./auth', () => ({
  refreshSession: vi.fn(),
  reauthenticateManagedServer: vi.fn(),
  extractAuthCookie: vi.fn(() => null),
}));
vi.mock('./console-identity', () => ({ consoleIdentityHeaders: async () => ({}) }));

const {
  cancelLinkRequestOnServer,
  claimIdentityOnServer,
  issueLinkCodeOnServer,
  requireLinkConfirmationOnServer,
} = await import('./identities');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  url: 'https://switch.example.com',
  managed: false,
} as never;

function validJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
  const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function response(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    headers: { get: () => null, getSetCookie: () => [] },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const BRIDGES = [{ bridge_id: 'b1', bridge_type: 'slack', display_name: 'Acme', status: 'active' }];

const SUMMARY = {
  id: 'eu-1',
  bridge_id: 'b1',
  external_user_id: 'U1',
  external_username: 'ada',
  claimed_by: [],
};

const CODE = {
  code: '7KQ2-M9XD',
  expires_at: '2026-10-27T12:30:00Z',
  expires_in_seconds: 1800,
  instructions: 'Post `!link-account 7KQ2-M9XD` from that account.',
};

const fetchMock = vi.fn();

/** Answer the claim with `claim`, and the bridge list with `BRIDGES`. */
function serve(claim: Response): void {
  fetchMock.mockImplementation(async (url: string) =>
    url.endsWith('/collaborations') ? response(200, BRIDGES) : claim
  );
}

const PARAMS = { bridgeId: 'b1', externalUserId: 'U1', username: 'ada' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  getSessionCookie.mockResolvedValue(validJwt());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('claimIdentityOnServer', () => {
  it('says it can show a code, which a current server requires', async () => {
    serve(response(200, SUMMARY));

    await claimIdentityOnServer(SERVER, PARAMS);

    const claim = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/identities'));
    expect(JSON.parse((claim![1] as { body: string }).body)).toEqual({
      external_user_id: 'U1',
      username: 'ada',
      expects_confirmation: true,
    });
  });

  it('comes back pending, carrying the code, when the server wants proof', async () => {
    serve(response(200, { ...SUMMARY, link_request: { user_id: 'u1', code: CODE } }));

    await expect(claimIdentityOnServer(SERVER, PARAMS)).resolves.toEqual({
      kind: 'pending',
      pending: {
        id: 'eu-1',
        bridgeId: 'b1',
        bridgeDisplayName: 'Acme',
        bridgeType: 'slack',
        externalUserId: 'U1',
        externalUsername: 'ada',
        requestedByName: null,
        codeExpiresAt: '2026-10-27T12:30:00Z',
      },
      code: {
        code: '7KQ2-M9XD',
        expiresAt: '2026-10-27T12:30:00Z',
        expiresInSeconds: 1800,
        instructions: 'Post `!link-account 7KQ2-M9XD` from that account.',
      },
      alreadyLinked: false,
    });
  });

  it('says when the caller already holds an unconfirmed link to the account', async () => {
    // Re-claiming an account linked before confirming existed asks for a code
    // too, but that link works meanwhile — cancelling must not take it away.
    serve(
      response(200, {
        ...SUMMARY,
        claimed_by: [{ user_id: 'u1', user_name: 'Ada', verified: false }],
        link_request: { user_id: 'u1', code: CODE },
      })
    );

    await expect(claimIdentityOnServer(SERVER, PARAMS)).resolves.toMatchObject({
      kind: 'pending',
      alreadyLinked: true,
    });
  });

  it('does not count someone else’s link to the account as the caller’s', async () => {
    serve(
      response(200, {
        ...SUMMARY,
        claimed_by: [{ user_id: 'u2', user_name: 'Grace', verified: true }],
        link_request: { user_id: 'u1', code: CODE },
      })
    );

    await expect(claimIdentityOnServer(SERVER, PARAMS)).resolves.toMatchObject({
      alreadyLinked: false,
    });
  });

  it('comes back pending without a code when the server issued none', async () => {
    serve(response(200, { ...SUMMARY, link_request: { user_id: 'u1', code: null } }));

    const result = await claimIdentityOnServer(SERVER, PARAMS);

    expect(result).toMatchObject({ kind: 'pending', code: null });
  });

  it('is linked and confirmed when the server sends no request back', async () => {
    // The account was already linked and confirmed: nothing to wait for.
    serve(response(200, { ...SUMMARY, link_request: null }));

    await expect(claimIdentityOnServer(SERVER, PARAMS)).resolves.toMatchObject({
      kind: 'claimed',
      identity: { id: 'eu-1', verified: true },
    });
  });

  it('is linked at once by a server that predates confirming links', async () => {
    serve(response(200, SUMMARY));

    await expect(claimIdentityOnServer(SERVER, PARAMS)).resolves.toEqual({
      kind: 'claimed',
      identity: {
        id: 'eu-1',
        bridgeId: 'b1',
        bridgeDisplayName: 'Acme',
        bridgeType: 'slack',
        externalUserId: 'U1',
        externalUsername: 'ada',
        verified: true,
      },
    });
  });
});

describe('issueLinkCodeOnServer', () => {
  it('returns the fresh code', async () => {
    fetchMock.mockResolvedValue(response(200, CODE));

    await expect(issueLinkCodeOnServer(SERVER, 'b1', 'eu-1')).resolves.toEqual({
      kind: 'issued',
      code: {
        code: '7KQ2-M9XD',
        expiresAt: '2026-10-27T12:30:00Z',
        expiresInSeconds: 1800,
        instructions: 'Post `!link-account 7KQ2-M9XD` from that account.',
      },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string }];
    expect(url).toBe('https://switch.example.com/gateway/collaborations/b1/identities/eu-1/code');
    expect(init.method).toBe('POST');
  });

  it('reads a code from a server that sends no lifetime', async () => {
    // Such a server's expiry can only be read off its own clock, `expires_at`.
    const { expires_in_seconds: _lifetime, ...older } = CODE;
    fetchMock.mockResolvedValue(response(200, older));

    await expect(issueLinkCodeOnServer(SERVER, 'b1', 'eu-1')).resolves.toMatchObject({
      code: { expiresAt: '2026-10-27T12:30:00Z', expiresInSeconds: null },
    });
  });

  it('passes on the server’s reason when the link is already confirmed', async () => {
    fetchMock.mockResolvedValue(
      response(409, { detail: 'This account has already confirmed the link' })
    );

    await expect(issueLinkCodeOnServer(SERVER, 'b1', 'eu-1')).resolves.toEqual({
      kind: 'refused',
      message: 'This account has already confirmed the link',
    });
  });

  it('passes on the server’s reason when there is nothing to confirm', async () => {
    fetchMock.mockResolvedValue(
      response(404, { detail: 'You have not started linking this account. Link it first.' })
    );

    await expect(issueLinkCodeOnServer(SERVER, 'b1', 'eu-1')).resolves.toEqual({
      kind: 'refused',
      message: 'You have not started linking this account. Link it first.',
    });
  });

  it('throws on anything it cannot name', async () => {
    fetchMock.mockResolvedValue(response(500, { detail: 'boom' }));

    await expect(issueLinkCodeOnServer(SERVER, 'b1', 'eu-1')).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe('cancelLinkRequestOnServer', () => {
  it('withdraws only the waiting request, never the link', async () => {
    fetchMock.mockResolvedValue(response(200, SUMMARY));

    await expect(cancelLinkRequestOnServer(SERVER, 'b1', 'eu-1')).resolves.toEqual({
      kind: 'cancelled',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string }];
    expect(url).toBe(
      'https://switch.example.com/gateway/collaborations/b1/identities/eu-1/request'
    );
    expect(init.method).toBe('DELETE');
  });

  it('passes on the server’s reason when nothing is waiting', async () => {
    fetchMock.mockResolvedValue(response(404, { detail: 'Nothing is waiting to be confirmed' }));

    await expect(cancelLinkRequestOnServer(SERVER, 'b1', 'eu-1')).resolves.toEqual({
      kind: 'refused',
      message: 'Nothing is waiting to be confirmed',
    });
  });

  it('throws on anything it cannot name', async () => {
    fetchMock.mockResolvedValue(response(500, { detail: 'boom' }));

    await expect(cancelLinkRequestOnServer(SERVER, 'b1', 'eu-1')).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe('requireLinkConfirmationOnServer', () => {
  it('says how many links now wait for their code', async () => {
    fetchMock.mockResolvedValue(response(200, { moved: 2 }));

    await expect(requireLinkConfirmationOnServer(SERVER, 'b1')).resolves.toEqual({
      kind: 'required',
      moved: 2,
    });
  });

  it('passes on the server’s reason when the caller is not an admin', async () => {
    fetchMock.mockResolvedValue(response(403, { detail: 'Workspace admin access required' }));

    await expect(requireLinkConfirmationOnServer(SERVER, 'b1')).resolves.toEqual({
      kind: 'refused',
      message: 'Workspace admin access required',
    });
  });

  it('passes on the server’s reason when the app is gone', async () => {
    fetchMock.mockResolvedValue(response(404, { detail: 'Bridge not found' }));

    await expect(requireLinkConfirmationOnServer(SERVER, 'b1')).resolves.toEqual({
      kind: 'refused',
      message: 'Bridge not found',
    });
  });
});
