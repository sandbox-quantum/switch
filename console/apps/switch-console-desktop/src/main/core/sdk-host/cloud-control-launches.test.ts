import { beforeEach, expect, it, vi } from 'vitest';

const { FakeGatewayError } = vi.hoisted(() => ({
  FakeGatewayError: class extends Error {
    constructor(
      readonly kind: 'unauthorized' | 'http' | 'network',
      message: string,
      readonly status?: number
    ) {
      super(message);
    }
  },
}));

const gateway = vi.hoisted(() => ({ answer: null as (() => unknown) | null }));
const kvRows = vi.hoisted(() => new Map<string, unknown>());

vi.mock('@main/db/kv', () => ({
  KV: class {
    get = async (key: string) => kvRows.get(key) ?? null;
    set = async (key: string, value: unknown) => void kvRows.set(key, structuredClone(value));
    del = async (key: string) => void kvRows.delete(key);
    getAll = async () => Object.fromEntries(kvRows);
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

vi.mock('@main/core/workspaces/workspace-session', () => ({
  withServerWorkspaceSession: async (serverId: string, fn: (server: unknown) => unknown) =>
    fn({ id: serverId }),
}));

vi.mock('@main/core/switch-servers/gateway-client', () => ({
  GatewayError: FakeGatewayError,
  gatewayRequest: vi.fn(),
  gatewayFetch: vi.fn(async (_server: unknown, path: string) => {
    expect(path).toBe('/hosted-launches');
    return { json: async () => gateway.answer!() };
  }),
}));

const { gatewayFetch } = await import('@main/core/switch-servers/gateway-client');
const { listCloudAgents } = await import('./cloud-control');

function refuse(error: InstanceType<typeof FakeGatewayError>) {
  vi.mocked(gatewayFetch).mockRejectedValueOnce(error);
}

beforeEach(() => {
  gateway.answer = () => [];
});

it('reads a 404 from the launch list as a server without cloud agents', async () => {
  refuse(new FakeGatewayError('http', 'Switch gateway returned 404', 404));
  await expect(listCloudAgents('server')).resolves.toBeNull();
});

it('keeps an empty launch list distinct from a server without cloud agents', async () => {
  await expect(listCloudAgents('server')).resolves.toEqual([]);
});

it.each([
  ['an expired session', new FakeGatewayError('unauthorized', 'Switch session expired', 401)],
  ['a refusal', new FakeGatewayError('http', 'Switch gateway returned 403', 403)],
  ['a server fault', new FakeGatewayError('http', 'Switch gateway returned 500', 500)],
  ['an unreachable server', new FakeGatewayError('network', 'Could not reach the gateway')],
])('still raises %s', async (_name, error) => {
  refuse(error);
  await expect(listCloudAgents('server')).rejects.toBe(error);
});
