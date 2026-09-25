import { beforeEach, expect, it, vi } from 'vitest';
import type { Agent } from '@shared/core/agents/agents';
import { adoptSubagent } from './adopt-subagent';

const mocks = vi.hoisted(() => ({
  local: vi.fn(),
  server: vi.fn(),
  remote: vi.fn(),
  create: vi.fn(),
  emit: vi.fn(),
  start: vi.fn(),
}));
vi.mock('@main/core/agents/agent-events', () => ({ agentEvents: { _emit: mocks.emit } }));
vi.mock('@main/core/agents/createAgent', () => ({ createAgent: mocks.create }));
vi.mock('@main/core/agents/getAgents', () => ({ getLocationAgentsOnServer: mocks.local }));
vi.mock('@main/core/agents/remote-session-reconciler', () => ({
  remoteSessionReconciler: { start: mocks.start },
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({ fetchAgentDetail: mocks.remote }));
vi.mock('@main/core/switch-servers/servers-store', () => ({ getServer: mocks.server }));
const parent = {
  id: 'parent',
  locationId: 'location',
  serverId: 'server',
  apiEndpoint: 'https://example.test/agent',
  providerId: 'claude',
  autoApprove: false,
  providerConfig: { model: 'configured-model' },
} as unknown as Agent;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.local.mockResolvedValue([]);
  mocks.server.mockResolvedValue({ id: 'server' });
  mocks.remote.mockResolvedValue({ id: 'child', ownerName: 'Owner' });
  mocks.create.mockImplementation(async (value) => ({ ...value, id: 'local-child' }));
});

it('adopts the child identity and discovers its sessions using its own credentials name', async () => {
  await adoptSubagent(parent, 'reviewer', 'child');
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      locationId: 'location',
      name: 'reviewer',
      switchAgentId: 'child',
      providerId: 'claude',
      serverId: 'server',
      autoApprove: false,
      providerConfig: parent.providerConfig,
    })
  );
  expect(mocks.emit).toHaveBeenCalledWith(
    'agent:created',
    expect.objectContaining({ id: 'local-child' }),
    'unknown'
  );
  expect(mocks.start).toHaveBeenCalledWith('local-child');
});

it('reuses a matching child row across Console restart', async () => {
  mocks.local.mockResolvedValue([
    { id: 'existing', switchAgentId: 'child', name: 'reviewer', providerId: 'claude' },
  ]);
  await adoptSubagent(parent, 'reviewer', 'child');
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.start).toHaveBeenCalledWith('existing');
});

it('does not relink a name that belongs to a different identity', async () => {
  mocks.local.mockResolvedValue([{ name: 'reviewer', switchAgentId: 'another-child' }]);
  await expect(adoptSubagent(parent, 'reviewer', 'child')).rejects.toThrow(
    'different Switch identity'
  );
  expect(mocks.create).not.toHaveBeenCalled();
});

it('surfaces server verification failure before starting the child watcher', async () => {
  mocks.remote.mockRejectedValue(new Error('Sign in required'));
  await expect(adoptSubagent(parent, 'reviewer', 'child')).rejects.toThrow('Sign in required');
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
});
