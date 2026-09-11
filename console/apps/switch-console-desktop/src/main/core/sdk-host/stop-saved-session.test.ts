import { beforeEach, expect, it, vi } from 'vitest';
import { GatewayError } from '@main/core/switch-servers/gateway-client';
import { stopSavedSession } from './stop-saved-session';

const mocks = vi.hoisted(() => ({
  agent: vi.fn(),
  server: vi.fn(),
  snapshot: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: mocks.agent }));
vi.mock('@main/core/switch-servers/servers-store', () => ({ getServer: mocks.server }));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  GatewayError: class extends Error {
    constructor(
      readonly kind: string,
      message: string,
      readonly status?: number
    ) {
      super(message);
    }
  },
  fetchSdkSnapshot: mocks.snapshot,
}));
vi.mock('./stop-shared-session', () => ({ stopSharedSession: mocks.stop }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.agent.mockResolvedValue({ switchAgentId: 'remote-agent', serverId: 'server' });
  mocks.server.mockResolvedValue({ id: 'server' });
  mocks.snapshot.mockResolvedValue({});
  mocks.stop.mockResolvedValue(undefined);
});

it('stops a saved session even without a provisioned Console runtime', async () => {
  await stopSavedSession('session', 'agent');
  expect(mocks.stop).toHaveBeenCalledWith({ id: 'server' }, 'session');
});

it('allows removal when the server confirms that the session does not exist', async () => {
  mocks.snapshot.mockRejectedValue(new GatewayError('http', 'Missing', 404));
  await stopSavedSession('session', 'agent');
  expect(mocks.stop).not.toHaveBeenCalled();
});

it('preserves an uncertain stop even if its receipt is not found', async () => {
  mocks.stop.mockRejectedValue(new GatewayError('http', 'Receipt missing', 404));
  await expect(stopSavedSession('session', 'agent')).rejects.toThrow('Receipt missing');
});

it('does not treat an inaccessible server as a missing session', async () => {
  mocks.snapshot.mockRejectedValue(new GatewayError('network', 'Offline'));
  await expect(stopSavedSession('session', 'agent')).rejects.toThrow('Offline');
  expect(mocks.stop).not.toHaveBeenCalled();
});

it('reports missing server configuration before removing a linked session', async () => {
  mocks.server.mockResolvedValue(null);
  await expect(stopSavedSession('session', 'agent')).rejects.toThrow('Switch server is missing');
});
