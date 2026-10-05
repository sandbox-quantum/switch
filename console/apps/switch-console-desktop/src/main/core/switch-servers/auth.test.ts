import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readSecrets = vi.hoisted(() => vi.fn());
const getSessionCookie = vi.hoisted(() => vi.fn());
const setSessionCookie = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const logWarn = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({ BrowserWindow: vi.fn(), session: { fromPartition: vi.fn() } }));
vi.mock('@main/core/managed-switch-server/secrets', () => ({ readSecrets }));
vi.mock('@main/core/managed-switch-server/host/host-for-server', () => ({
  managedServerSecretsKey: (server: { sshHost: string | null }) =>
    server.sshHost
      ? `remote-switch-server:${server.sshHost}:secrets`
      : 'local-switch-server:secrets',
}));
vi.mock('./servers-store', () => ({ getSessionCookie, setSessionCookie }));
const consoleIdentityHeaders = vi.hoisted(() =>
  vi.fn(async (): Promise<Record<string, string>> => ({}))
);
vi.mock('./console-identity', () => ({ consoleIdentityHeaders }));
vi.mock('@main/lib/logger', () => ({ log: { warn: logWarn, error: vi.fn(), info: vi.fn() } }));

const { reauthenticateManagedServer, refreshSession, signup } = await import('./auth');

const REMOTE = {
  id: 'srv-remote',
  name: 'Team server',
  gatewayUrl: 'http://localhost:41000',
  apiUrl: 'http://localhost:41001',
  managed: true,
  managementKind: 'remote',
  sshHost: 'vm-1',
} as never;
const EXTERNAL = {
  id: 'srv-external',
  name: 'Company server',
  gatewayUrl: 'https://switch.example.com',
  apiUrl: 'https://switch-api.example.com',
  managed: false,
  managementKind: null,
  sshHost: null,
} as never;

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reauthenticateManagedServer', () => {
  it('signs in with the stored admin password', async () => {
    readSecrets.mockResolvedValue({ gatewayAdminPassword: 'stored-pw' });
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      headers: { getSetCookie: () => ['switch_auth=fresh-jwt; Path=/; HttpOnly'] },
      json: async () => ({ id: 'u1' }),
    });
    getSessionCookie.mockResolvedValue('fresh-jwt');

    expect(await reauthenticateManagedServer(REMOTE)).toBe('fresh-jwt');

    expect(readSecrets).toHaveBeenCalledWith({ secretsKey: 'remote-switch-server:vm-1:secrets' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:41000/gateway/auth/login');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'admin@switch.local',
      password: 'stored-pw',
    });
    expect(setSessionCookie).toHaveBeenCalledWith('srv-remote', 'fresh-jwt');
  });

  it('gives up, and makes up no password, when none is stored', async () => {
    readSecrets.mockResolvedValue(null);

    expect(await reauthenticateManagedServer(REMOTE)).toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining('no stored credentials'),
      expect.objectContaining({ server: 'srv-remote' })
    );
  });

  it('holds no credentials for a server someone else runs', async () => {
    expect(await reauthenticateManagedServer(EXTERNAL)).toBeNull();

    expect(readSecrets).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the sign-in panel when the stored password is refused', async () => {
    readSecrets.mockResolvedValue({ gatewayAdminPassword: 'stale-pw' });
    fetchMock.mockResolvedValue({
      status: 401,
      ok: false,
      headers: { getSetCookie: () => [] },
      text: async () => '',
    });

    expect(await reauthenticateManagedServer(REMOTE)).toBeNull();
    expect(setSessionCookie).not.toHaveBeenCalled();
  });
});

describe('refreshSession', () => {
  it('identifies the Console to a server it manages while renewing, and keeps the new session', async () => {
    consoleIdentityHeaders.mockResolvedValueOnce({
      'X-Switch-Console-Id': 'console-1',
      'X-Switch-Console-Name': 'alice@laptop',
    });
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { getSetCookie: () => ['switch_auth=fresh-jwt; Path=/; HttpOnly'] },
    });

    expect(await refreshSession(REMOTE, 'old-jwt')).toBe('fresh-jwt');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:41000/gateway/auth/refresh');
    expect(init.headers).toMatchObject({
      Cookie: 'switch_auth=old-jwt',
      'X-Switch-Console-Id': 'console-1',
      'X-Switch-Console-Name': 'alice@laptop',
    });
    expect(setSessionCookie).toHaveBeenCalledWith('srv-remote', 'fresh-jwt');
  });

  it('keeps the current session when renewal is refused', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, headers: { getSetCookie: () => [] } });

    expect(await refreshSession(REMOTE, 'old-jwt')).toBeNull();
    expect(setSessionCookie).not.toHaveBeenCalled();
  });
});

const SERVER = {
  id: 'srv-1',
  name: 'S',
  gatewayUrl: 'https://switch.example.com',
  managed: false,
} as never;

const USER = { id: 'u1', name: 'ada', email: 'ada@example.com', role: 'user', server: null };

function response(status: number, body: unknown, cookies: string[] = []): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: cookies.map((cookie) => ['Set-Cookie', cookie] as [string, string]),
  });
}

describe('signup', () => {
  it('creates the account and stores its session as a login does', async () => {
    fetchMock.mockResolvedValueOnce(
      response(201, { ...USER, machine: { status: 'starting', reason: null } }, [
        'switch_auth=SYNTHETIC-JWT; HttpOnly; Path=/',
      ])
    );

    const result = await signup(SERVER, { email: 'ada@example.com', password: 'correct-horse' });

    expect(result).toEqual({
      success: true,
      data: { user: USER, machine: { status: 'starting', reason: null } },
    });
    expect(setSessionCookie).toHaveBeenCalledWith('srv-1', 'SYNTHETIC-JWT');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://switch.example.com/gateway/auth/signup');
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'ada@example.com',
      password: 'correct-horse',
    });
  });

  it('sends a display name when one is given', async () => {
    fetchMock.mockResolvedValueOnce(
      response(201, { ...USER, machine: { status: 'unavailable', reason: 'None free.' } }, [
        'switch_auth=SYNTHETIC-JWT',
      ])
    );

    const result = await signup(SERVER, {
      email: 'ada@example.com',
      password: 'correct-horse',
      displayName: 'Ada',
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({
      display_name: 'Ada',
    });
    expect(result.success && result.data.machine).toEqual({
      status: 'unavailable',
      reason: 'None free.',
    });
  });

  it('reports an existing email with the server’s explanation', async () => {
    fetchMock.mockResolvedValueOnce(response(409, { detail: 'Email already registered' }));

    const result = await signup(SERVER, { email: 'ada@example.com', password: 'correct-horse' });

    expect(result).toEqual({
      success: false,
      error: { kind: 'email_taken', message: 'Email already registered' },
    });
    expect(setSessionCookie).not.toHaveBeenCalled();
  });

  it('reports the server’s sign-up cap with its explanation and no HTTP prefix', async () => {
    fetchMock.mockResolvedValueOnce(
      response(429, {
        detail: 'Too many sign-ups on this server in the last hour. Try again later.',
      })
    );

    const result = await signup(SERVER, { email: 'ada@example.com', password: 'correct-horse' });

    expect(result).toEqual({
      success: false,
      error: {
        kind: 'rate_limited',
        message: 'Too many sign-ups on this server in the last hour. Try again later.',
      },
    });
    expect(setSessionCookie).not.toHaveBeenCalled();
  });

  it('renders a validation refusal one sentence per field', async () => {
    fetchMock.mockResolvedValueOnce(
      response(422, {
        detail: [
          {
            type: 'string_too_short',
            loc: ['body', 'password'],
            msg: 'String should have at least 8 characters',
          },
          {
            type: 'value_error',
            loc: ['body', 'display_name'],
            msg: 'Value error, Too long.',
          },
        ],
      })
    );

    const result = await signup(SERVER, { email: 'ada@example.com', password: 'short' });

    expect(result).toEqual({
      success: false,
      error: {
        kind: 'invalid',
        message: 'Password: String should have at least 8 characters. Display name: Too long.',
      },
    });
  });

  it('fails without a session cookie rather than reporting a sign-in', async () => {
    fetchMock.mockResolvedValueOnce(
      response(201, { ...USER, machine: { status: 'starting', reason: null } })
    );

    const result = await signup(SERVER, { email: 'ada@example.com', password: 'correct-horse' });

    expect(result).toMatchObject({ success: false, error: { kind: 'failed' } });
    expect(setSessionCookie).not.toHaveBeenCalled();
  });
});
