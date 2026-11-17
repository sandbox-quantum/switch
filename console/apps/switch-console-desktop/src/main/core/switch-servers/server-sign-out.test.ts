import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionCookie = vi.hoisted(() => vi.fn());
const managedServerHostBlocked = vi.hoisted(() => vi.fn((): unknown => null));
const managedServerStoppedPhase = vi.hoisted(() => vi.fn((): unknown => null));
const warn = vi.hoisted(() => vi.fn());

vi.mock('./servers-store', () => ({ getSessionCookie }));
vi.mock('./console-identity', () => ({ consoleIdentityHeaders: async () => ({}) }));
vi.mock('@main/core/managed-switch-server/managed-server-status', () => ({
  managedServerHostBlocked,
  managedServerStoppedPhase,
}));
vi.mock('@main/lib/logger', () => ({ log: { warn, info: vi.fn(), error: vi.fn() } }));

const { signOutOnServer } = await import('./server-sign-out');

const server = {
  id: 'srv',
  name: 'S',
  url: 'https://switch.example.com',
  managed: false,
  managementKind: null,
  sshHost: null,
} as unknown as Parameters<typeof signOutOnServer>[0];

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  managedServerHostBlocked.mockReturnValue(null);
  managedServerStoppedPhase.mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('signing out on the server', () => {
  it('posts the gateway logout with the session cookie Console holds', async () => {
    getSessionCookie.mockResolvedValue('jwt-held');
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    await signOutOnServer(server);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://switch.example.com/gateway/auth/logout');
    expect(init.method).toBe('POST');
    expect(init.headers.Cookie).toBe('switch_auth=jwt-held');
    expect(warn).not.toHaveBeenCalled();
  });

  it('makes no call without a session', async () => {
    getSessionCookie.mockResolvedValue(null);
    await signOutOnServer(server);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('warns rather than throws when the server cannot be reached or refuses', async () => {
    getSessionCookie.mockResolvedValue('jwt-held');
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(signOutOnServer(server)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/Could not reach/),
      expect.objectContaining({ serverId: 'srv', error: 'fetch failed' })
    );

    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(signOutOnServer(server)).resolves.toBeUndefined();
    expect(warn).toHaveBeenLastCalledWith(
      expect.stringMatching(/refused/),
      expect.objectContaining({ serverId: 'srv', status: 500 })
    );
  });

  it('does not call a managed server whose host is down or whose stack is stopped', async () => {
    getSessionCookie.mockResolvedValue('jwt-held');
    managedServerStoppedPhase.mockReturnValue('stopped');
    await signOutOnServer(server);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/not reachable/),
      expect.objectContaining({ serverId: 'srv' })
    );
  });
});
