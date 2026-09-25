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

const { fetchAgentRefusals, GatewayError } = await import('./gateway-client');

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

const REFUSAL = {
  id: 'ref-1',
  agent_id: 'agent-1',
  agent_name: 'planner',
  operation: 'update_template',
  reason: 'not_yours',
  message: 'You can only edit templates you saved.',
  subject: 'Triage pair',
  created_at: '2026-09-25T10:00:00Z',
};

const fetchMock = vi.fn();

describe('agent refusals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getSessionCookie.mockResolvedValue(validJwt());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the refusals into camelCase', async () => {
    fetchMock.mockResolvedValue(
      response(200, [
        REFUSAL,
        { ...REFUSAL, id: 'ref-2', agent_id: null, agent_name: null, subject: null },
      ])
    );

    const refusals = await fetchAgentRefusals(SERVER);

    expect(fetchMock.mock.calls[0][0]).toBe('https://switch.example.com/gateway/agent-refusals');
    expect(refusals).toEqual([
      {
        id: 'ref-1',
        agentId: 'agent-1',
        agentName: 'planner',
        operation: 'update_template',
        reason: 'not_yours',
        message: 'You can only edit templates you saved.',
        subject: 'Triage pair',
        createdAt: '2026-09-25T10:00:00Z',
      },
      {
        id: 'ref-2',
        agentId: null,
        agentName: null,
        operation: 'update_template',
        reason: 'not_yours',
        message: 'You can only edit templates you saved.',
        subject: null,
        createdAt: '2026-09-25T10:00:00Z',
      },
    ]);
  });

  it('answers null for a server that does not record refusals', async () => {
    fetchMock.mockResolvedValue(response(404, { detail: 'Not Found' }));
    await expect(fetchAgentRefusals(SERVER)).resolves.toBeNull();
  });

  it('passes other failures on', async () => {
    fetchMock.mockResolvedValue(response(500, { detail: 'boom' }));
    await expect(fetchAgentRefusals(SERVER)).rejects.toBeInstanceOf(GatewayError);
  });
});
