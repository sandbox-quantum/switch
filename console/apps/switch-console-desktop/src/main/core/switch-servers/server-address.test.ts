import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

const listServers = vi.hoisted(() => vi.fn());
const clearDashboardUrl = vi.hoisted(() => vi.fn(async () => {}));
const logWarn = vi.hoisted(() => vi.fn());
const logInfo = vi.hoisted(() => vi.fn());

vi.mock('./servers-store', () => ({ listServers, clearDashboardUrl }));
vi.mock('@main/lib/logger', () => ({ log: { warn: logWarn, info: logInfo, error: vi.fn() } }));

const {
  assertServerAddress,
  NotTheServerAddressError,
  retireDashboardFallback,
  retireDashboardFallbacks,
  servesDashboard,
} = await import('./server-address');

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

function answer(status: number, contentType: string): Response {
  return new Response(contentType.startsWith('text/html') ? '<!doctype html>' : '{}', {
    status,
    headers: { 'content-type': contentType },
  });
}

const PAGE = () => answer(200, 'text/html; charset=utf-8');
const JSON_OK = () => answer(200, 'application/json');
const UNAUTHORIZED = () => answer(401, 'application/json');

function server(overrides: Partial<SwitchServer>): SwitchServer {
  return {
    id: 'srv',
    name: 'Split',
    url: 'https://switch-api.example.com',
    dashboardUrl: 'https://switch-gateway.example.com',
    managed: false,
    managementKind: null,
    sshHost: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

/** Answer each origin's root as given; anything else is a network failure. */
function roots(byOrigin: Record<string, () => Response | Promise<never>>): void {
  fetchMock.mockImplementation(async (url: string) => {
    const respond = byOrigin[new URL(url).origin];
    if (!respond) throw new TypeError('fetch failed');
    return respond();
  });
}

describe('assertServerAddress', () => {
  it('accepts an address whose health check is the API’s', async () => {
    fetchMock.mockResolvedValue(JSON_OK());

    await expect(assertServerAddress('https://switch.example.com/')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://switch.example.com/health',
      expect.objectContaining({ headers: { Accept: 'application/json' } })
    );
  });

  it('refuses an address that answers with a web page, saying what to enter', async () => {
    fetchMock.mockResolvedValue(PAGE());

    const checking = assertServerAddress('https://switch-gateway.example.com');

    await expect(checking).rejects.toBeInstanceOf(NotTheServerAddressError);
    await expect(checking).rejects.toThrow(
      /https:\/\/switch-gateway\.example\.com answered with a web page.*dashboard.*port 8000/
    );
  });

  it('leaves an address it cannot reach to the sign-in that follows', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(assertServerAddress('https://down.example.com')).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith(
      'switch-servers: could not check the server address before saving it',
      expect.objectContaining({ url: 'https://down.example.com' })
    );
  });

  it('leaves any other answer to the sign-in too', async () => {
    fetchMock.mockResolvedValue(answer(404, 'application/json'));

    await expect(assertServerAddress('https://other.example.com')).resolves.toBeUndefined();
  });
});

describe('servesDashboard', () => {
  it('is true for a page at the root', async () => {
    fetchMock.mockResolvedValue(PAGE());

    expect(await servesDashboard('https://switch.example.com/')).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://switch.example.com/',
      expect.objectContaining({ headers: { Accept: 'text/html' } })
    );
  });

  it('is false for a server that answers its root with anything else', async () => {
    fetchMock.mockResolvedValueOnce(UNAUTHORIZED());
    expect(await servesDashboard('https://old-api.example.com')).toBe(false);

    fetchMock.mockResolvedValueOnce(answer(502, 'text/html'));
    expect(await servesDashboard('https://proxy.example.com')).toBe(false);
  });

  it('is null when the address cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    expect(await servesDashboard('https://down.example.com')).toBeNull();
  });
});

describe('retireDashboardFallback', () => {
  it('drops the old address once the server serves its dashboard and the old host is gone', async () => {
    roots({ 'https://switch-api.example.com': PAGE });

    expect(await retireDashboardFallback(server({}))).toBe(true);
    expect(clearDashboardUrl).toHaveBeenCalledExactlyOnceWith(
      'srv',
      'https://switch-api.example.com'
    );
    expect(logInfo).toHaveBeenCalledWith(
      expect.stringContaining('serves its own dashboard'),
      expect.objectContaining({ oldAddressAnswered: false })
    );
  });

  it('drops it when the old host answers but no longer with the dashboard', async () => {
    roots({
      'https://switch-api.example.com': PAGE,
      'https://switch-gateway.example.com': () => answer(404, 'text/plain'),
    });

    expect(await retireDashboardFallback(server({}))).toBe(true);
    expect(clearDashboardUrl).toHaveBeenCalledOnce();
  });

  it('keeps it while the old host still serves the dashboard', async () => {
    // Its identity provider may still return there.
    roots({ 'https://switch-api.example.com': PAGE, 'https://switch-gateway.example.com': PAGE });

    expect(await retireDashboardFallback(server({}))).toBe(false);
    expect(clearDashboardUrl).not.toHaveBeenCalled();
  });

  it('keeps it while the server does not serve its own dashboard', async () => {
    roots({ 'https://switch-api.example.com': UNAUTHORIZED });

    expect(await retireDashboardFallback(server({}))).toBe(false);
    expect(clearDashboardUrl).not.toHaveBeenCalled();
  });

  it('keeps it when the server itself cannot be reached', async () => {
    roots({});

    expect(await retireDashboardFallback(server({}))).toBe(false);
    expect(clearDashboardUrl).not.toHaveBeenCalled();
  });

  it('asks nothing of a server with no separate dashboard', async () => {
    expect(await retireDashboardFallback(server({ dashboardUrl: null }))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves a managed server to the addresses its stack registers', async () => {
    roots({ 'https://switch-api.example.com': PAGE });

    expect(await retireDashboardFallback(server({ managed: true }))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(clearDashboardUrl).not.toHaveBeenCalled();
  });
});

describe('retireDashboardFallbacks', () => {
  it('checks every server, and one that fails does not stop the rest', async () => {
    listServers.mockResolvedValue([
      server({ id: 'broken' }),
      server({
        id: 'upgraded',
        url: 'https://new-api.example.com',
        dashboardUrl: 'https://new-gateway.example.com',
      }),
    ]);
    roots({
      'https://switch-api.example.com': PAGE,
      'https://new-api.example.com': PAGE,
    });
    clearDashboardUrl.mockRejectedValueOnce(new Error('database is locked'));

    await retireDashboardFallbacks();

    expect(clearDashboardUrl).toHaveBeenCalledTimes(2);
    expect(clearDashboardUrl).toHaveBeenCalledWith('upgraded', 'https://new-api.example.com');
    expect(logWarn).toHaveBeenCalledWith(
      'switch-servers: could not check whether a server still needs its old dashboard',
      { server: 'broken', error: 'Error: database is locked' }
    );
  });
});
