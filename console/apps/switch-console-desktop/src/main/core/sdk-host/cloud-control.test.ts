import { beforeEach, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({
  operations: new Map<string, { id: string; session_id: string; action: string }>(),
  sessions: new Set<string>(),
  restarts: 0,
  loseNextResponse: false,
  refuseNext: null as { status: number; detail: string } | null,
}));

const { FakeGatewayError } = vi.hoisted(() => ({
  FakeGatewayError: class extends Error {
    constructor(
      readonly kind: 'unauthorized' | 'http' | 'network',
      message: string,
      readonly status?: number,
      readonly detail?: string
    ) {
      super(message);
    }
  },
}));

vi.mock('@switch-console/agent-providers', () => ({
  CloudRelayClient: class {},
  CloudRelayError: class extends Error {},
  RELAY_TIMEOUT_MS: 1000,
}));

vi.mock('@main/core/switch-servers/servers-store', () => ({
  getServer: async () => ({ id: 'server' }),
}));

vi.mock('@main/core/switch-servers/gateway-client', () => ({
  GatewayError: FakeGatewayError,
  gatewayRequest: vi.fn(),
  gatewayFetch: vi.fn(
    async (_server: unknown, _path: string, init: { method?: string; body?: unknown }) => {
      if (server.refuseNext) {
        const { status, detail } = server.refuseNext;
        server.refuseNext = null;
        throw new FakeGatewayError('http', `Switch gateway returned ${status}`, status, detail);
      }
      const body = init.body as { id: string; session_id: string; action: string };
      let operation = server.operations.get(body.id);
      if (!operation) {
        operation = body;
        server.operations.set(body.id, operation);
        if (body.action === 'start') server.sessions.add(body.session_id);
        else server.restarts += 1;
      }
      if (server.loseNextResponse) {
        server.loseNextResponse = false;
        throw new FakeGatewayError('network', 'Could not reach the gateway: socket hang up');
      }
      return { json: async () => ({ ...operation, state: 'applied', error: null }) };
    }
  ),
}));

const { runCloudSessionOperation } = await import('./cloud-control');

const agent = 'cloud:server:00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-0000000000aa';
const restartId = '00000000-0000-4000-8000-0000000000bb';

beforeEach(() => {
  server.operations.clear();
  server.sessions.clear();
  server.restarts = 0;
  server.loseNextResponse = false;
  server.refuseNext = null;
});

it('reports a start whose response was lost as unknown, and the same id again starts one session', async () => {
  server.loseNextResponse = true;
  const first = await runCloudSessionOperation(agent, sessionId, sessionId, 'start');
  expect(first.state).toBe('unknown');
  expect(await runCloudSessionOperation(agent, sessionId, sessionId, 'start')).toEqual({
    state: 'applied',
  });
  expect([...server.sessions]).toEqual([sessionId]);
});

it('reports a restart whose response was lost as unknown, and the same id again restarts once', async () => {
  server.loseNextResponse = true;
  expect((await runCloudSessionOperation(agent, sessionId, restartId, 'restart')).state).toBe(
    'unknown'
  );
  expect(await runCloudSessionOperation(agent, sessionId, restartId, 'restart')).toEqual({
    state: 'applied',
  });
  expect(server.restarts).toBe(1);
});

it('reports a refusal the server answered as a definite failure', async () => {
  server.refuseNext = { status: 409, detail: 'Start the cloud worker and wait until it is ready.' };
  expect(await runCloudSessionOperation(agent, sessionId, sessionId, 'start')).toEqual({
    state: 'failed',
    message: 'Start the cloud worker and wait until it is ready.',
  });
});

it('refuses a start whose operation id is not its session id', async () => {
  await expect(runCloudSessionOperation(agent, sessionId, restartId, 'start')).rejects.toThrow(
    /identified by its session id/
  );
});
