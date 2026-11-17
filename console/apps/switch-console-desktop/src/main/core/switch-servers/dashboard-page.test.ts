import { beforeEach, describe, expect, it, vi } from 'vitest';

const openExternal = vi.hoisted(() => vi.fn(async () => {}));
const getSessionCookie = vi.hoisted(() => vi.fn());
const reauthenticateManagedServer = vi.hoisted(() => vi.fn());
const mintBrowserHandoff = vi.hoisted(() => vi.fn());
const assertServesDashboard = vi.hoisted(() => vi.fn(async () => {}));
const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const { GatewayError } = vi.hoisted(() => ({
  GatewayError: class GatewayError extends Error {
    constructor(
      readonly kind: 'unauthorized' | 'http' | 'network',
      message: string,
      readonly status?: number
    ) {
      super(message);
    }
  },
}));

vi.mock('@main/core/app/service', () => ({ appService: { openExternal } }));
vi.mock('@main/lib/logger', () => ({ log }));
vi.mock('./auth', () => ({ reauthenticateManagedServer }));
vi.mock('./gateway-client', () => ({ GatewayError, mintBrowserHandoff }));
vi.mock('./server-address', () => ({ assertServesDashboard }));
vi.mock('./servers-store', () => ({ getSessionCookie }));

const { openDashboardPage } = await import('./dashboard-page');

const CODE = 'c0de-c0de-c0de-c0de-c0de-c0de-c0de-c0de-c0d';
const LINK = `/auth/handoff#code=${CODE}`;
const REMOTE = {
  id: 'srv-1',
  name: 'Acme',
  url: 'https://switch.example.com',
  managed: false,
} as never;
const MANAGED = {
  id: 'srv-local',
  name: 'Local',
  url: 'http://127.0.0.1:8080',
  managed: true,
} as never;

describe('opening a dashboard page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionCookie.mockResolvedValue('console-session');
    mintBrowserHandoff.mockResolvedValue({ path: LINK, expiresAt: '2026-11-17T10:00:00Z' });
  });

  it('asks for a sign-in link and opens it on the dashboard in the browser', async () => {
    await openDashboardPage(REMOTE, 'https://switch.example.com/rooms/r1?workspace=t1#docs');

    expect(assertServesDashboard).toHaveBeenCalledExactlyOnceWith(REMOTE);
    expect(mintBrowserHandoff).toHaveBeenCalledExactlyOnceWith(
      REMOTE,
      '/rooms/r1?workspace=t1#docs'
    );
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(`https://switch.example.com${LINK}`);
  });

  it('opens the link on the dashboard address a server keeps apart', async () => {
    const split = {
      ...(REMOTE as object),
      url: 'https://switch-api.example.com',
      dashboardUrl: 'https://switch-gateway.example.com',
    } as never;

    await openDashboardPage(split, 'https://switch-gateway.example.com/agents/a1');

    expect(mintBrowserHandoff).toHaveBeenCalledWith(split, '/agents/a1');
    expect(openExternal).toHaveBeenCalledWith(`https://switch-gateway.example.com${LINK}`);
  });

  it('refuses a page on another origin, before asking for anything', async () => {
    await expect(openDashboardPage(REMOTE, 'https://evil.example.com/rooms/r1')).rejects.toThrow(
      /not on the dashboard origin https:\/\/switch\.example\.com/
    );

    const split = {
      ...(REMOTE as object),
      url: 'https://switch-api.example.com',
      dashboardUrl: 'https://switch-gateway.example.com',
    } as never;
    await expect(
      openDashboardPage(split, 'https://switch-api.example.com/rooms/1')
    ).rejects.toThrow(/dashboard origin/);
    expect(mintBrowserHandoff).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens nothing, and says why, where no dashboard is served', async () => {
    assertServesDashboard.mockRejectedValueOnce(new Error('Acme does not serve its dashboard'));

    await expect(openDashboardPage(REMOTE, 'https://switch.example.com/')).rejects.toThrow(
      'does not serve its dashboard'
    );
    expect(mintBrowserHandoff).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens the page signed out where Console has no session', async () => {
    getSessionCookie.mockResolvedValue(null);
    reauthenticateManagedServer.mockResolvedValue(null);

    await openDashboardPage(REMOTE, 'https://switch.example.com/rooms/r1');

    expect(mintBrowserHandoff).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://switch.example.com/rooms/r1');
  });

  it.each([404, 405])(
    'opens the page signed out on a server that predates the link (%i)',
    async (status) => {
      mintBrowserHandoff.mockRejectedValue(new GatewayError('http', 'no route', status));

      await openDashboardPage(REMOTE, 'https://switch.example.com/rooms/r1');

      expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://switch.example.com/rooms/r1');
    }
  );

  it('opens the page signed out when the server refuses Console’s session', async () => {
    mintBrowserHandoff.mockRejectedValue(new GatewayError('unauthorized', 'expired', 401));

    await openDashboardPage(REMOTE, 'https://switch.example.com/rooms/r1');

    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://switch.example.com/rooms/r1');
  });

  it.each([
    ['refused', new GatewayError('http', 'Too many sign-in links', 429)],
    ['broken', new GatewayError('http', 'boom', 500)],
    ['unreachable', new GatewayError('network', 'Could not reach')],
  ])('opens nothing when the server is otherwise %s', async (_case, error) => {
    mintBrowserHandoff.mockRejectedValue(error);

    await expect(openDashboardPage(REMOTE, 'https://switch.example.com/rooms/r1')).rejects.toBe(
      error
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens nothing when the link the server answers with leaves the dashboard', async () => {
    mintBrowserHandoff.mockResolvedValue({ path: '@evil.example/x', expiresAt: '' });

    await expect(openDashboardPage(REMOTE, 'https://switch.example.com/')).rejects.toThrow(
      /leaves its dashboard/
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('signs the managed server in again when Console holds no session for it', async () => {
    getSessionCookie.mockResolvedValue(null);
    reauthenticateManagedServer.mockResolvedValue('minted-session');

    await openDashboardPage(MANAGED, 'http://127.0.0.1:8080/agents/a1');

    expect(reauthenticateManagedServer).toHaveBeenCalledExactlyOnceWith(MANAGED);
    expect(assertServesDashboard).not.toHaveBeenCalled();
    expect(mintBrowserHandoff).toHaveBeenCalledWith(MANAGED, '/agents/a1');
    expect(openExternal).toHaveBeenCalledWith(`http://127.0.0.1:8080${LINK}`);
  });

  it('uses the session Console holds for the managed server without signing in again', async () => {
    await openDashboardPage(MANAGED, 'http://127.0.0.1:8080/');

    expect(reauthenticateManagedServer).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith(`http://127.0.0.1:8080${LINK}`);
  });

  it('never logs the link', async () => {
    await openDashboardPage(REMOTE, 'https://switch.example.com/rooms/r1');
    getSessionCookie.mockResolvedValue(null);
    reauthenticateManagedServer.mockResolvedValue(null);
    await openDashboardPage(REMOTE, 'https://switch.example.com/rooms/r1');

    const logged = JSON.stringify(Object.values(log).flatMap((fn) => fn.mock.calls));
    expect(logged).not.toContain(CODE);
  });
});
