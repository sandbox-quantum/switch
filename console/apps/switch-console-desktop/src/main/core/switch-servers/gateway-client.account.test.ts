import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionCookie = vi.hoisted(() => vi.fn());
const setSessionCookie = vi.hoisted(() => vi.fn());

vi.mock('@main/core/managed-switch-server/managed-server-status', () => ({
  managedServerHostBlocked: () => null,
  managedServerStoppedPhase: () => null,
  noteManagedServerUnanswered: () => undefined,
}));
vi.mock('./servers-store', () => ({ getSessionCookie, setSessionCookie }));
vi.mock('./auth', () => ({
  refreshSession: vi.fn(),
  reauthenticateManagedServer: vi.fn(),
  extractAuthCookie: (setCookies: string[]) =>
    setCookies.map((c) => /^switch_auth=([^;]*)/.exec(c)?.[1]).find(Boolean) ?? null,
}));
vi.mock('./console-identity', () => ({ consoleIdentityHeaders: async () => ({}) }));

const {
  changeMyPassword,
  createRegistrationKey,
  deleteApiKey,
  fetchMyApiKeys,
  revealApiKey,
  updateMyName,
} = await import('./gateway-client');
const { onSessionEnded } = await import('./session-ended');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  url: 'https://switch.example.com',
  dashboardUrl: null,
  managed: false,
} as never;

function makeJwt(secondsFromNow: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow;
  const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function response(status: number, body: unknown, setCookies: string[] = []): Response {
  return {
    status,
    ok: status < 400,
    json: async () => body,
    headers: { get: () => null, getSetCookie: () => setCookies },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response(200, {}));

function lastCall(): { url: string; method: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit | undefined];
  return {
    url,
    method: init?.method ?? 'GET',
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionCookie.mockResolvedValue(makeJwt(2 * 60 * 60));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('account', () => {
  it('changes the display name and reads back the user', async () => {
    fetchMock.mockImplementation(async () =>
      response(200, { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com', role: 'user' })
    );
    const user = await updateMyName(SERVER, 'Ada Lovelace');
    expect(lastCall()).toMatchObject({ method: 'PATCH', body: { name: 'Ada Lovelace' } });
    expect(lastCall().url).toMatch(/\/auth\/me$/);
    expect(user.name).toBe('Ada Lovelace');
  });

  it('says when the account has no password of its own, and leaves it unsaid otherwise', async () => {
    fetchMock.mockImplementation(async () =>
      response(200, {
        id: 'u1',
        name: 'Ada',
        email: 'ada@example.com',
        role: 'user',
        has_password: false,
      })
    );
    expect((await updateMyName(SERVER, 'Ada')).hasPassword).toBe(false);
    fetchMock.mockImplementation(async () =>
      response(200, { id: 'u1', name: 'Ada', email: 'ada@example.com', role: 'user' })
    );
    expect(await updateMyName(SERVER, 'Ada')).not.toHaveProperty('hasPassword');
  });

  it('changes the password in the server’s field names', async () => {
    fetchMock.mockImplementation(async () => response(200, { ok: true }));
    await changeMyPassword(SERVER, 'old-pass', 'new-password-1');
    expect(lastCall()).toMatchObject({
      method: 'PUT',
      body: { current_password: 'old-pass', new_password: 'new-password-1' },
    });
    expect(lastCall().url).toMatch(/\/auth\/me\/password$/);
  });

  it('keeps the new session the server answers a password change with', async () => {
    // The change ends every session, this one included; the cookie it sends
    // back is the only one that still works, so it has to replace the old.
    fetchMock.mockImplementation(async () =>
      response(200, { ok: true }, ['switch_auth=fresh-session; HttpOnly; Path=/; SameSite=Lax'])
    );
    await changeMyPassword(SERVER, 'old-pass', 'new-password-1');
    expect(setSessionCookie).toHaveBeenCalledWith('srv-1', 'fresh-session');
  });

  it('says the password changed when only keeping its new session failed', async () => {
    fetchMock.mockImplementation(async () =>
      response(200, { ok: true }, ['switch_auth=fresh-session; HttpOnly; Path=/'])
    );
    setSessionCookie.mockRejectedValueOnce(new Error('disk full'));
    const failure = await changeMyPassword(SERVER, 'old-pass', 'new-password-1').catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('PasswordChangedSessionNotSavedError');
    expect((failure as Error).message).toMatch(/^Your password was changed/);
  });

  it('leaves the stored session alone when the server sends no new one', async () => {
    fetchMock.mockImplementation(async () => response(200, { ok: true }));
    await changeMyPassword(SERVER, 'old-pass', 'new-password-1');
    expect(setSessionCookie).not.toHaveBeenCalled();
  });

  it('passes on the server’s reason when the current password is wrong', async () => {
    fetchMock.mockImplementation(async () =>
      response(403, { detail: 'Current password is incorrect' })
    );
    await expect(changeMyPassword(SERVER, 'nope', 'new-password-1')).rejects.toThrow(
      'Current password is incorrect'
    );
  });
});

describe('API keys', () => {
  it('lists the signed-in person’s keys', async () => {
    fetchMock.mockImplementation(async () =>
      response(200, [
        {
          id: 'k1',
          label: 'My scripts',
          type: 'registration',
          key_prefix: 'abc',
          created_at: 'd1',
          expires_at: 'e1',
        },
        { id: 'k2', label: 'release-bot', type: 'agent', key_prefix: 'def', created_at: 'd2' },
      ])
    );
    await expect(fetchMyApiKeys(SERVER)).resolves.toEqual([
      {
        id: 'k1',
        label: 'My scripts',
        type: 'registration',
        keyPrefix: 'abc',
        createdAt: 'd1',
        expiresAt: 'e1',
      },
      {
        id: 'k2',
        label: 'release-bot',
        type: 'agent',
        keyPrefix: 'def',
        createdAt: 'd2',
        expiresAt: null,
      },
    ]);
    expect(lastCall().url).toMatch(/\/api-keys$/);
  });

  it('creates a registration key and returns its value once', async () => {
    fetchMock.mockImplementation(async () =>
      response(200, {
        id: 'k3',
        label: 'CI',
        key: 'secret-value',
        created_at: 'd3',
        expires_at: 'e3',
      })
    );
    await expect(createRegistrationKey(SERVER, 'CI', 90)).resolves.toEqual({
      id: 'k3',
      label: 'CI',
      key: 'secret-value',
      createdAt: 'd3',
      expiresAt: 'e3',
    });
    expect(lastCall()).toMatchObject({
      method: 'POST',
      body: { label: 'CI', expires_in_days: 90 },
    });
  });

  it('asks for a key that never expires', async () => {
    fetchMock.mockImplementation(async () =>
      response(200, { id: 'k4', label: 'CI', key: 'v', created_at: 'd4', expires_at: null })
    );
    await expect(createRegistrationKey(SERVER, 'CI', 'never')).resolves.toMatchObject({
      expiresAt: null,
    });
    expect(lastCall()).toMatchObject({ body: { label: 'CI', expires_in_days: 'never' } });
  });

  it('reveals and deletes a key by id', async () => {
    fetchMock.mockImplementation(async () => response(200, { key: 'full-key' }));
    await expect(revealApiKey(SERVER, 'k1')).resolves.toBe('full-key');
    expect(lastCall().url).toMatch(/\/api-keys\/k1\/reveal$/);
    fetchMock.mockImplementation(async () => response(200, { ok: true }));
    await deleteApiKey(SERVER, 'k1');
    expect(lastCall()).toMatchObject({ method: 'DELETE' });
    expect(lastCall().url).toMatch(/\/api-keys\/k1$/);
  });
});

describe('a session the server has ended', () => {
  it('says so when a signed-in call is refused with 401', async () => {
    const ended: string[] = [];
    const stop = onSessionEnded((serverId) => ended.push(serverId));
    try {
      fetchMock.mockImplementation(async () => response(401, { detail: 'Session ended' }));
      await expect(updateMyName(SERVER, 'Ada')).rejects.toThrow();
      expect(ended).toEqual(['srv-1']);
    } finally {
      stop();
    }
  });

  it('says nothing for any other refusal', async () => {
    const ended: string[] = [];
    const stop = onSessionEnded((serverId) => ended.push(serverId));
    try {
      fetchMock.mockImplementation(async () => response(403, { detail: 'Forbidden' }));
      await expect(updateMyName(SERVER, 'Ada')).rejects.toThrow();
      expect(ended).toEqual([]);
    } finally {
      stop();
    }
  });
});
