import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionCookie = vi.hoisted(() => vi.fn());
const refreshSession = vi.hoisted(() => vi.fn());
const reauthenticateManagedServer = vi.hoisted(() => vi.fn());
const managedServerHostBlocked = vi.hoisted(() => vi.fn(() => null));
const managedServerStoppedPhase = vi.hoisted(() => vi.fn(() => null));

vi.mock('@main/core/managed-switch-server/managed-server-status', () => ({
  managedServerHostBlocked,
  managedServerStoppedPhase,
}));
vi.mock('./servers-store', () => ({ getSessionCookie }));
vi.mock('./auth', () => ({ refreshSession, reauthenticateManagedServer }));
vi.mock('./console-identity', () => ({ consoleIdentityHeaders: async () => ({}) }));

const { updateTemplate, GatewayError } = await import('./gateway-client');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  gatewayUrl: 'https://switch.example.com',
  managed: false,
} as never;

function validJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
  const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function response(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    headers: { getSetCookie: () => [] },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const STORED = {
  id: 'tpl/1',
  owner_id: 'u1',
  owner_name: 'Ana',
  name: 'Triage pair',
  description: 'Two agents and their room',
  kind: 'group',
  version: 3,
  content: 'room:\n  name: n\n',
};

const fetchMock = vi.fn();

describe('updateTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(validJwt());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('patches only the fields that changed and returns the new version', async () => {
    fetchMock.mockResolvedValue(response(200, STORED));

    const saved = await updateTemplate(SERVER, 'tpl/1', {
      description: 'Two agents and their room',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://switch.example.com/gateway/templates/tpl%2F1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ description: 'Two agents and their room' });
    expect(saved).toMatchObject({ id: 'tpl/1', version: 3, definition: STORED.content });
  });

  it('sends the new kind alongside a document whose shape changed', async () => {
    fetchMock.mockResolvedValue(response(200, STORED));
    await updateTemplate(SERVER, 'tpl/1', { content: 'agent:\n  name: a\n', kind: 'agent' });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ content: 'agent:\n  name: a\n', kind: 'agent' });
  });

  it('reports a name the owner already uses', async () => {
    fetchMock.mockResolvedValue(response(409, { detail: 'You already have a template named x' }));

    await expect(updateTemplate(SERVER, 'tpl/1', { name: 'x' })).rejects.toBeInstanceOf(
      GatewayError
    );
  });
});
