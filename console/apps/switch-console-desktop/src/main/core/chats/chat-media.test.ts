import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A chat attachment is raw bytes of any type, HTML included: downloading an
// agent's `index.html` must give its bytes back, not the "this address doesn't
// route /gateway" error meant for a web page answering a management call.

const getSessionCookie = vi.hoisted(() => vi.fn());
vi.mock('@main/core/managed-switch-server/managed-server-status', () => ({
  managedServerHostBlocked: () => null,
  managedServerStoppedPhase: () => null,
  noteManagedServerUnanswered: vi.fn(),
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  getSessionCookie,
  setSessionCookie: vi.fn(),
}));
vi.mock('@main/core/switch-servers/auth', () => ({
  refreshSession: vi.fn(),
  reauthenticateManagedServer: vi.fn(),
  extractAuthCookie: vi.fn(() => null),
}));
vi.mock('@main/core/switch-servers/console-identity', () => ({
  consoleIdentityHeaders: async () => ({}),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { fetchChatMedia } = await import('./gateway');
const { gatewayFetch } = await import('@main/core/switch-servers/gateway-client');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  url: 'https://switch.example.com',
  dashboardUrl: null,
  managed: false,
} as never;

/** A token far from expiry, so no renewal call is made. */
function jwt(): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 7200 })}.sig`;
}

const PAGE = '<!doctype html><title>site</title><p>hello</p>';
const page = (status = 200) =>
  new Response(PAGE, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

describe('chat attachment download', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionCookie.mockResolvedValue(jwt());
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloads an HTML attachment: its bytes and type come back, with no error', async () => {
    fetchMock.mockResolvedValueOnce(page());
    const media = await fetchChatMedia(SERVER, '!room:x', 'mxc://x/abc');
    expect(media.mimeType).toBe('text/html; charset=utf-8');
    expect(new TextDecoder().decode(media.bytes)).toBe(PAGE);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://switch.example.com/gateway/chats/!room%3Ax/media?uri=mxc%3A%2F%2Fx%2Fabc'
    );
  });

  it('still reports a missing attachment (a 404 page) as the refusal it is', async () => {
    fetchMock.mockResolvedValueOnce(page(404));
    await expect(fetchChatMedia(SERVER, '!room:x', 'mxc://x/gone')).rejects.toMatchObject({
      name: 'GatewayError',
      status: 404,
    });
  });

  it('a management call answered by a web page still raises the "does not route /gateway" error', async () => {
    fetchMock.mockResolvedValueOnce(page());
    await expect(gatewayFetch(SERVER, '/me', { authenticated: true })).rejects.toMatchObject({
      name: 'NoManagementApiError',
    });
  });

  it('a management call answered by a 404 page still raises it too', async () => {
    fetchMock.mockResolvedValueOnce(page(404));
    await expect(gatewayFetch(SERVER, '/me', { authenticated: true })).rejects.toMatchObject({
      name: 'NoManagementApiError',
    });
  });
});
