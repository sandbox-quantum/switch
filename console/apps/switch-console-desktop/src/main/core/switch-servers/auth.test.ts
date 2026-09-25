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
vi.mock('./console-identity', () => ({ consoleIdentityHeaders: async () => ({}) }));
vi.mock('@main/lib/logger', () => ({ log: { warn: logWarn, error: vi.fn(), info: vi.fn() } }));

const { reauthenticateManagedServer } = await import('./auth');

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
    // A password minted here would match no running stack, and would then be
    // kept as though it were the stack's (CHOO-2893).
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
