import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionCookie = vi.hoisted(() => vi.fn());
const reauthenticateManagedServer = vi.hoisted(() => vi.fn());
const cookiesSet = vi.hoisted(() => vi.fn(async () => {}));
const onBeforeSendHeaders = vi.hoisted(() => vi.fn());
const fromPartition = vi.hoisted(() =>
  vi.fn(() => ({ cookies: { set: cookiesSet }, webRequest: { onBeforeSendHeaders } }))
);
const loadURL = vi.hoisted(() => vi.fn(async () => {}));
const BrowserWindow = vi.hoisted(() =>
  vi.fn(function () {
    return { loadURL };
  })
);

vi.mock('electron', () => ({ BrowserWindow, session: { fromPartition } }));
vi.mock('./servers-store', () => ({ getSessionCookie }));
vi.mock('./auth', () => ({ reauthenticateManagedServer }));
vi.mock('./console-identity', () => ({
  consoleIdentityHeaders: async (server: { managed: boolean }) =>
    server.managed
      ? { 'X-Switch-Console-Id': 'console-1', 'X-Switch-Console-Name': 'alice@laptop' }
      : {},
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));

const { openAuthenticatedGatewayPage } = await import('./gateway-web');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  url: 'http://127.0.0.1:8080',
  managed: false,
} as never;
const MANAGED = {
  id: 'srv-local',
  name: 'Local',
  url: 'http://127.0.0.1:8080',
  managed: true,
} as never;

describe('openAuthenticatedGatewayPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a url that is not on the dashboard origin, before opening anything', async () => {
    getSessionCookie.mockResolvedValue('jwt');

    await expect(
      openAuthenticatedGatewayPage(SERVER, 'http://evil.example.com/agents/1')
    ).rejects.toThrow(/dashboard origin/);
    expect(BrowserWindow).not.toHaveBeenCalled();
    expect(cookiesSet).not.toHaveBeenCalled();
  });

  it('injects the stored cookie for the gateway origin and opens the page', async () => {
    getSessionCookie.mockResolvedValue('stored-jwt');

    await openAuthenticatedGatewayPage(SERVER, 'http://127.0.0.1:8080/agents/abc');

    expect(cookiesSet).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://127.0.0.1:8080',
        name: 'switch_auth',
        value: 'stored-jwt',
        httpOnly: true,
        secure: false,
      })
    );
    expect(fromPartition).toHaveBeenCalledWith('persist:switch-gateway:srv-1');
    expect(loadURL).toHaveBeenCalledWith('http://127.0.0.1:8080/agents/abc');
    expect(reauthenticateManagedServer).not.toHaveBeenCalled();
  });

  it('opens pages on the dashboard address a server keeps apart, and nowhere else', async () => {
    getSessionCookie.mockResolvedValue('stored-jwt');
    const split = {
      id: 'srv-split',
      name: 'Split',
      url: 'https://switch-api.example.com',
      dashboardUrl: 'https://switch-gateway.example.com',
      managed: false,
    } as never;

    await expect(
      openAuthenticatedGatewayPage(split, 'https://switch-api.example.com/rooms/1')
    ).rejects.toThrow(/not on the dashboard origin https:\/\/switch-gateway\.example\.com/);
    expect(cookiesSet).not.toHaveBeenCalled();

    await openAuthenticatedGatewayPage(split, 'https://switch-gateway.example.com/rooms/1');

    expect(cookiesSet).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://switch-gateway.example.com', secure: true })
    );
    expect(loadURL).toHaveBeenCalledWith('https://switch-gateway.example.com/rooms/1');
  });

  it('mints a session for the managed server when none is stored', async () => {
    getSessionCookie.mockResolvedValue(null);
    reauthenticateManagedServer.mockResolvedValue('minted-jwt');

    await openAuthenticatedGatewayPage(MANAGED, 'http://127.0.0.1:8080/');

    expect(reauthenticateManagedServer).toHaveBeenCalledExactlyOnceWith(MANAGED);
    expect(cookiesSet).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'switch_auth', value: 'minted-jwt' })
    );
    expect(loadURL).toHaveBeenCalledWith('http://127.0.0.1:8080/');
  });

  it('still opens the page (unauthenticated) when no session can be obtained', async () => {
    getSessionCookie.mockResolvedValue(null);

    await openAuthenticatedGatewayPage(SERVER, 'http://127.0.0.1:8080/');

    // Non-managed with no stored session: no cookie injected, page still opens.
    expect(cookiesSet).not.toHaveBeenCalled();
    expect(loadURL).toHaveBeenCalledWith('http://127.0.0.1:8080/');
  });

  it('marks the dashboard’s requests to a managed gateway with this Console', async () => {
    getSessionCookie.mockResolvedValue('stored-jwt');

    await openAuthenticatedGatewayPage(MANAGED, 'http://127.0.0.1:8080/');

    expect(onBeforeSendHeaders).toHaveBeenCalledOnce();
    const [filter, listener] = onBeforeSendHeaders.mock.calls[0] as [
      { urls: string[] },
      (
        details: { requestHeaders: Record<string, string> },
        callback: (response: { requestHeaders: Record<string, string> }) => void
      ) => void,
    ];
    expect(filter.urls).toEqual(['http://127.0.0.1:8080/*']);
    const callback = vi.fn();
    listener({ requestHeaders: { Accept: 'text/html' } }, callback);
    expect(callback).toHaveBeenCalledWith({
      requestHeaders: {
        Accept: 'text/html',
        'X-Switch-Console-Id': 'console-1',
        'X-Switch-Console-Name': 'alice@laptop',
      },
    });
  });

  it('adds nothing to the requests of a server someone else runs', async () => {
    getSessionCookie.mockResolvedValue('stored-jwt');

    await openAuthenticatedGatewayPage(SERVER, 'http://127.0.0.1:8080/');

    expect(onBeforeSendHeaders).not.toHaveBeenCalled();
  });
});
