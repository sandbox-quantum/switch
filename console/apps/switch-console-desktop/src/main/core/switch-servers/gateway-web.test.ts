import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionCookie = vi.hoisted(() => vi.fn());
const reauthenticateManagedServer = vi.hoisted(() => vi.fn());
const cookiesSet = vi.hoisted(() => vi.fn(async () => {}));
const fromPartition = vi.hoisted(() => vi.fn(() => ({ cookies: { set: cookiesSet } })));
const loadURL = vi.hoisted(() => vi.fn(async () => {}));
const BrowserWindow = vi.hoisted(() =>
  vi.fn(function () {
    return { loadURL };
  })
);

vi.mock('electron', () => ({ BrowserWindow, session: { fromPartition } }));
vi.mock('./servers-store', () => ({ getSessionCookie }));
vi.mock('./auth', () => ({ reauthenticateManagedServer }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));

const { openAuthenticatedGatewayPage } = await import('./gateway-web');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  gatewayUrl: 'http://127.0.0.1:8080',
  managed: false,
} as never;
const MANAGED = {
  id: 'srv-local',
  name: 'Local',
  gatewayUrl: 'http://127.0.0.1:8080',
  managed: true,
} as never;

describe('openAuthenticatedGatewayPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a url that is not on the gateway origin, before opening anything', async () => {
    getSessionCookie.mockResolvedValue('jwt');

    await expect(
      openAuthenticatedGatewayPage(SERVER, 'http://evil.example.com/agents/1')
    ).rejects.toThrow(/gateway origin/);
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
});
