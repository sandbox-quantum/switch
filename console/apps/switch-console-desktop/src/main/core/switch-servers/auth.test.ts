import { get } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readSecrets = vi.hoisted(() => vi.fn());
const getSessionCookie = vi.hoisted(() => vi.fn());
const setSessionCookie = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const logWarn = vi.hoisted(() => vi.fn());
const keepSeparateDashboard = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  session: { fromPartition: vi.fn() },
  shell: { openExternal: vi.fn(async () => {}) },
}));
vi.mock('@main/app/deeplinks', () => ({ appReturnUrl: () => null, bringToFront: vi.fn() }));
vi.mock('@main/core/managed-switch-server/secrets', () => ({ readSecrets }));
vi.mock('@main/core/managed-switch-server/host/host-for-server', () => ({
  managedServerSecretsKey: (server: { sshHost: string | null }) =>
    server.sshHost
      ? `remote-switch-server:${server.sshHost}:secrets`
      : 'local-switch-server:secrets',
}));
vi.mock('./servers-store', () => ({ getSessionCookie, setSessionCookie }));
vi.mock('./server-address', () => ({ keepSeparateDashboard }));
const consoleIdentityHeaders = vi.hoisted(() =>
  vi.fn(async (): Promise<Record<string, string>> => ({}))
);
vi.mock('./console-identity', () => ({ consoleIdentityHeaders }));
vi.mock('@main/lib/logger', () => ({ log: { warn: logWarn, error: vi.fn(), info: vi.fn() } }));

const {
  callbackHostHop,
  cancelOidcLogin,
  oidcLogin,
  reauthenticateManagedServer,
  refreshSession,
  signup,
} = await import('./auth');
const electron = await import('electron');

const REMOTE = {
  id: 'srv-remote',
  name: 'Team server',
  url: 'http://localhost:41001',
  dashboardUrl: 'http://localhost:41000',
  managed: true,
  managementKind: 'remote',
  sshHost: 'vm-1',
} as never;
const EXTERNAL = {
  id: 'srv-external',
  name: 'Company server',
  url: 'https://switch-api.example.com',
  dashboardUrl: 'https://switch.example.com',
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
      headers: { get: () => null, getSetCookie: () => ['switch_auth=fresh-jwt; Path=/; HttpOnly'] },
      json: async () => ({ id: 'u1' }),
    });
    getSessionCookie.mockResolvedValue('fresh-jwt');

    expect(await reauthenticateManagedServer(REMOTE)).toBe('fresh-jwt');

    expect(readSecrets).toHaveBeenCalledWith({ secretsKey: 'remote-switch-server:vm-1:secrets' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:41001/gateway/auth/login');
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
      headers: { get: () => null, getSetCookie: () => [] },
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
      headers: { get: () => null, getSetCookie: () => ['switch_auth=fresh-jwt; Path=/; HttpOnly'] },
    });

    expect(await refreshSession(REMOTE, 'old-jwt')).toBe('fresh-jwt');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:41001/gateway/auth/refresh');
    expect(init.headers).toMatchObject({
      Cookie: 'switch_auth=old-jwt',
      'X-Switch-Console-Id': 'console-1',
      'X-Switch-Console-Name': 'alice@laptop',
    });
    expect(setSessionCookie).toHaveBeenCalledWith('srv-remote', 'fresh-jwt');
  });

  it('keeps the current session when renewal is refused', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => null, getSetCookie: () => [] },
    });

    expect(await refreshSession(REMOTE, 'old-jwt')).toBeNull();
    expect(setSessionCookie).not.toHaveBeenCalled();
  });
});

const SIGNUP_SERVER = {
  id: 'srv-1',
  name: 'S',
  url: 'https://switch.example.com',
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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('creates the account and stores its session as a login does', async () => {
    fetchMock.mockResolvedValueOnce(
      response(201, { ...USER, machine: { status: 'starting', reason: null } }, [
        'switch_auth=SYNTHETIC-JWT; HttpOnly; Path=/',
      ])
    );

    const result = await signup(SIGNUP_SERVER, {
      email: 'ada@example.com',
      password: 'correct-horse',
    });

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

    const result = await signup(SIGNUP_SERVER, {
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

    const result = await signup(SIGNUP_SERVER, {
      email: 'ada@example.com',
      password: 'correct-horse',
    });

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

    const result = await signup(SIGNUP_SERVER, {
      email: 'ada@example.com',
      password: 'correct-horse',
    });

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

    const result = await signup(SIGNUP_SERVER, { email: 'ada@example.com', password: 'short' });

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

    const result = await signup(SIGNUP_SERVER, {
      email: 'ada@example.com',
      password: 'correct-horse',
    });

    expect(result).toMatchObject({ success: false, error: { kind: 'failed' } });
    expect(setSessionCookie).not.toHaveBeenCalled();
  });
});

describe('oidcLogin', () => {
  /** Opens the sign-in window, reports the page it loaded, and closes it. */
  async function loadedPage(server: unknown): Promise<string> {
    const loadURL = vi.fn(async () => {});
    let closed: (() => void) | undefined;
    vi.mocked(electron.session.fromPartition).mockReturnValue({
      cookies: { get: vi.fn(async () => []) },
    } as never);
    vi.mocked(electron.BrowserWindow).mockImplementation(function () {
      return {
        loadURL,
        webContents: { on: vi.fn() },
        on: (event: string, listener: () => void) => {
          if (event === 'closed') closed = listener;
        },
        isDestroyed: () => false,
        destroy: vi.fn(),
      } as never;
    });
    const result = oidcLogin(server as never, null, false);
    closed?.();
    expect(await result).toMatchObject({ success: false, error: { kind: 'cancelled' } });
    return (loadURL.mock.calls[0] as unknown as [string])[0];
  }

  it('starts on the dashboard’s host for a server that keeps one apart', async () => {
    // The identity provider of an older split server returns to the dashboard's
    // host, and the server keeps the sign-in state in a cookie on the host the
    // flow started on.
    expect(await loadedPage(EXTERNAL)).toBe('https://switch.example.com/gateway/auth/oidc/login');
  });

  it('starts on the server’s own address otherwise', async () => {
    expect(
      await loadedPage({
        id: 'srv-one',
        name: 'One address',
        url: 'https://switch.example.org',
        dashboardUrl: null,
        managed: false,
      })
    ).toBe('https://switch.example.org/gateway/auth/oidc/login');
  });
});

describe('callbackHostHop', () => {
  const start = 'https://switch-api.example.com/gateway/auth/oidc/login';
  const idp = (redirectUri: string) =>
    `https://idp.example/authorize?${new URLSearchParams({ redirect_uri: redirectUri, state: 's' })}`;

  it('names the host the provider will return to, when it is another', () => {
    expect(
      callbackHostHop(start, idp('https://switch-gateway.example.com/gateway/auth/oidc/callback'))
    ).toBe('https://switch-gateway.example.com');
  });

  it.each([
    ['the host it started on', idp('https://switch-api.example.com/gateway/auth/oidc/callback')],
    ['the same host on another port', idp('https://switch-api.example.com:8443/cb')],
    ['no return address', 'https://idp.example/authorize?state=s'],
    ['a return address that is not a web address', idp('javascript:alert(1)')],
    ['a return address that does not parse', idp('not a url')],
    // A proxy with a sign-in of its own in front of the dashboard.
    ['a callback that is not Switch’s', idp('https://auth.example.com/oauth2/callback')],
  ])('leaves a sign-in alone that returns to %s', (_case, redirect) => {
    expect(callbackHostHop(start, redirect)).toBeNull();
  });
});

describe('oidcLogin following an older server to its callback host', () => {
  const ONE_ADDRESS = {
    id: 'srv-old',
    name: 'Older server',
    url: 'https://switch-api.example.com',
    dashboardUrl: null,
    managed: false,
  } as never;
  const CALLBACK = 'https://switch-gateway.example.com/gateway/auth/oidc/callback';
  const idp = (redirectUri: string) =>
    `https://idp.example/authorize?${new URLSearchParams({ redirect_uri: redirectUri, state: 's' })}`;

  /** Opens the sign-in window with handles on what it would see and do. */
  function signInWindow(firstLoad: Promise<void> = Promise.resolve()) {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    const loadURL = vi.fn(async (_url: string) => {});
    loadURL.mockImplementationOnce(() => firstLoad);
    let cookie: string | null = null;
    vi.mocked(electron.session.fromPartition).mockReturnValue({
      cookies: { get: vi.fn(async () => (cookie === null ? [] : [{ value: cookie }])) },
    } as never);
    vi.mocked(electron.BrowserWindow).mockImplementation(function () {
      return {
        loadURL,
        webContents: {
          on: (event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, [...(listeners.get(event) ?? []), listener]);
          },
        },
        on: vi.fn(),
        isDestroyed: () => false,
        destroy: vi.fn(),
      } as never;
    });
    const emit = (event: string, ...args: unknown[]) =>
      (listeners.get(event) ?? []).forEach((listener) => listener(...args));
    return {
      loadURL,
      /** A server-side redirect of the window's main frame, or of a subframe. */
      redirect(url: string, isMainFrame = true) {
        const preventDefault = vi.fn();
        emit('will-redirect', { url, isMainFrame, preventDefault });
        return preventDefault;
      },
      /** The server sets the session cookie, and the window lands. */
      signedIn() {
        cookie = 'jwt';
        emit('did-navigate');
      },
    };
  }

  it('restarts on the host the provider returns to, and keeps it as the dashboard', async () => {
    const win = signInWindow();
    const result = oidcLogin(ONE_ADDRESS, null, false);

    expect(win.redirect(idp(CALLBACK))).toHaveBeenCalledOnce();
    expect(win.loadURL.mock.calls.map(([url]) => url)).toEqual([
      'https://switch-api.example.com/gateway/auth/oidc/login',
      'https://switch-gateway.example.com/gateway/auth/oidc/login',
    ]);

    win.signedIn();
    expect(await result).toEqual({ success: true, data: true });
    expect(keepSeparateDashboard).toHaveBeenCalledExactlyOnceWith(
      ONE_ADDRESS,
      'https://switch-gateway.example.com'
    );
  });

  it('carries the sign-in option to the host it restarts on', async () => {
    const win = signInWindow();
    const result = oidcLogin(ONE_ADDRESS, 'google', false);

    win.redirect(idp(CALLBACK));
    expect(win.loadURL.mock.calls.map(([url]) => url)).toEqual([
      'https://switch-api.example.com/gateway/auth/oidc/login?provider=google',
      'https://switch-gateway.example.com/gateway/auth/oidc/login?provider=google',
    ]);

    win.signedIn();
    expect(await result).toMatchObject({ success: true });
  });

  it('leaves a sign-in alone that returns to the host it started on', async () => {
    const win = signInWindow();
    const result = oidcLogin(ONE_ADDRESS, null, false);

    expect(
      win.redirect(idp('https://switch-api.example.com/gateway/auth/oidc/callback'))
    ).not.toHaveBeenCalled();

    win.signedIn();
    expect(await result).toMatchObject({ success: true });
    expect(win.loadURL).toHaveBeenCalledOnce();
    expect(keepSeparateDashboard).not.toHaveBeenCalled();
  });

  it('asks only the first redirect that leaves the starting host', async () => {
    const win = signInWindow();
    const result = oidcLogin(ONE_ADDRESS, null, false);

    // The same host again (an upgrade to HTTPS, say) is not the decision.
    expect(
      win.redirect('https://switch-api.example.com/gateway/auth/oidc/login?again=1')
    ).not.toHaveBeenCalled();
    // A subframe is not the sign-in.
    expect(win.redirect(idp(CALLBACK), false)).not.toHaveBeenCalled();
    expect(win.redirect(idp(CALLBACK))).toHaveBeenCalledOnce();
    // From here on the provider's pages cannot send it anywhere else.
    expect(win.redirect(idp('https://elsewhere.example.net/cb'))).not.toHaveBeenCalled();

    win.signedIn();
    await result;
    expect(win.loadURL).toHaveBeenCalledTimes(2);
  });

  it('does not take the first load, cancelled by the hop, for a failure', async () => {
    let cancel!: (cause: Error) => void;
    const win = signInWindow(new Promise((_resolve, reject) => (cancel = reject)));
    const result = oidcLogin(ONE_ADDRESS, null, false);

    win.redirect(idp(CALLBACK));
    cancel(new Error('ERR_ABORTED (-3)'));
    await Promise.resolve();
    win.signedIn();

    expect(await result).toMatchObject({ success: true });
  });

  it('is signed in even when the host cannot be kept', async () => {
    keepSeparateDashboard.mockRejectedValueOnce(new Error('database is locked'));
    const win = signInWindow();
    const result = oidcLogin(ONE_ADDRESS, null, false);

    win.redirect(idp(CALLBACK));
    win.signedIn();

    expect(await result).toMatchObject({ success: true });
    expect(logWarn).toHaveBeenCalledWith(
      'switch-servers: could not keep the host the sign-in returned to',
      expect.objectContaining({ error: 'Error: database is locked' })
    );
  });
});

describe('oidcLogin in the system browser', () => {
  /** Starts the sign-in, reports the page the browser was sent to, and cancels it. */
  async function openedPage(server: { id: string }): Promise<URL> {
    const result = oidcLogin(server as never, 'google', true);
    await vi.waitFor(() => expect(electron.shell.openExternal).toHaveBeenCalledOnce());
    cancelOidcLogin(server.id);
    expect(await result).toMatchObject({ success: false, error: { kind: 'cancelled' } });
    return new URL(vi.mocked(electron.shell.openExternal).mock.calls[0]![0]);
  }

  it('starts on the dashboard’s host for a server that keeps one apart', async () => {
    const page = await openedPage(EXTERNAL);
    expect(`${page.origin}${page.pathname}`).toBe(
      'https://switch.example.com/gateway/auth/oidc/login'
    );
    expect(page.searchParams.get('provider')).toBe('google');
    expect(page.searchParams.get('return_to')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/switch-sign-in$/
    );
  });

  it('starts on the server’s own address otherwise', async () => {
    // A current server answers a sign-in on its own address itself.
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://idp.example/authorize' } })
    );
    const page = await openedPage({
      id: 'srv-one',
      name: 'One address',
      url: 'https://switch.example.org',
      dashboardUrl: null,
      managed: false,
    } as never);
    expect(`${page.origin}${page.pathname}`).toBe(
      'https://switch.example.org/gateway/auth/oidc/login'
    );
    expect(keepSeparateDashboard).not.toHaveBeenCalled();
  });

  it('follows an older server to the host its sign-in returns to, and keeps it', async () => {
    const OLDER = {
      id: 'srv-older',
      name: 'Older',
      url: 'https://switch-api.example.com',
      dashboardUrl: null,
      managed: false,
    };
    const toProvider = `https://idp.example/authorize?${new URLSearchParams({
      redirect_uri: 'https://switch-gateway.example.com/gateway/auth/oidc/callback',
    })}`;
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/gateway/auth/oidc/login')
        ? new Response(null, { status: 302, headers: { location: toProvider } })
        : new Response('{}', { status: 200, headers: { 'set-cookie': 'switch_auth=jwt; Path=/' } })
    );

    const result = oidcLogin(OLDER as never, null, true);
    await vi.waitFor(() => expect(electron.shell.openExternal).toHaveBeenCalledOnce());
    const page = new URL(vi.mocked(electron.shell.openExternal).mock.calls[0]![0]);
    expect(`${page.origin}${page.pathname}`).toBe(
      'https://switch-gateway.example.com/gateway/auth/oidc/login'
    );

    // The browser comes back to this computer with a code, as the server sends it.
    const back = new URL(page.searchParams.get('return_to')!);
    back.search = new URLSearchParams({
      code: 'c',
      state: page.searchParams.get('state')!,
    }).toString();
    await new Promise<void>((resolve, reject) =>
      get(back, (res) => res.resume().on('end', resolve)).on('error', reject)
    );

    expect(await result).toEqual({ success: true, data: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://switch-api.example.com/gateway/auth/oidc/exchange',
      expect.anything()
    );
    expect(keepSeparateDashboard).toHaveBeenCalledExactlyOnceWith(
      OLDER,
      'https://switch-gateway.example.com'
    );
  });

  it('starts on the server’s own address when it cannot ask where sign-in returns', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const page = await openedPage({
      id: 'srv-down',
      name: 'Unreachable for a moment',
      url: 'https://switch.example.net',
      dashboardUrl: null,
      managed: false,
    } as never);
    expect(page.origin).toBe('https://switch.example.net');
    expect(logWarn).toHaveBeenCalledWith(
      'switch-servers: could not ask where the server’s sign-in returns to',
      expect.objectContaining({ server: 'srv-down' })
    );
  });
});
