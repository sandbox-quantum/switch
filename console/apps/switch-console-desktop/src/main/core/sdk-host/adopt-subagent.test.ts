import { beforeEach, expect, it, vi } from 'vitest';
import type { Agent } from '@shared/core/agents/agents';
import { adoptSubagent } from './adopt-subagent';

const mocks = vi.hoisted(() => ({
  local: vi.fn(),
  workspace: vi.fn(),
  server: vi.fn(),
  remote: vi.fn(),
  create: vi.fn(),
  emit: vi.fn(),
  start: vi.fn(),
  importConfig: vi.fn(),
}));
vi.mock('@main/core/agents/agent-events', () => ({ agentEvents: { _emit: mocks.emit } }));
vi.mock('@main/core/agents/createAgent', () => ({ createAgent: mocks.create }));
vi.mock('@main/core/agents/getAgents', () => ({ getLocationAgentsInWorkspace: mocks.local }));
vi.mock('@main/core/agents/remote-session-reconciler', () => ({
  remoteSessionReconciler: { start: mocks.start },
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({ fetchAgentDetail: mocks.remote }));
vi.mock('@main/core/switch-servers/servers-store', () => ({ getServer: mocks.server }));
vi.mock('@main/core/agents/agent-location', () => ({
  getAgentLocation: async () => ({ id: 'location', dir: '/repo', sshHost: 'vm-1' }),
}));
vi.mock('@main/core/agents/agent-workspace-fs', () => ({
  resolveWorkspaceFsFor: async () => ({ fs: {}, close: () => {} }),
}));
vi.mock('@main/core/agents/import-agent-config', () => ({ importAgentConfig: mocks.importConfig }));
vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: () => ({ behavior: { repoAgents: { definitionPath: () => '' } } }),
}));
vi.mock('@main/core/workspaces/workspaces-store', () => ({ requireWorkspace: mocks.workspace }));
const parent = {
  id: 'parent',
  locationId: 'location',
  workspaceId: 'workspace',
  apiEndpoint: 'https://example.test/agent',
  providerId: 'claude',
  autoApprove: false,
  providerConfig: { model: 'configured-model' },
} as unknown as Agent;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.local.mockResolvedValue([]);
  mocks.workspace.mockResolvedValue({ id: 'workspace', serverId: 'server' });
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
      workspaceId: 'workspace',
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

it('gives the subagent a config file from its own definition before creating it', async () => {
  const order: string[] = [];
  mocks.importConfig.mockImplementation(async () => {
    order.push('config');
    return true;
  });
  mocks.create.mockImplementation(async (value) => {
    order.push('row');
    return { ...value, id: 'local-child' };
  });

  await adoptSubagent(parent, 'reviewer', 'child');

  expect(mocks.importConfig).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'reviewer', providerConfig: parent.providerConfig })
  );
  expect(order).toEqual(['config', 'row']);
});
