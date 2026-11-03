import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enrolledControllerId: vi.fn(),
  disableThisComputer: vi.fn(),
  recordsOn: vi.fn(),
  disableHost: vi.fn(),
  revokeManagementController: vi.fn(),
  fetchManagementController: vi.fn(),
}));

vi.mock('@main/core/agent-migration/agent-migration', () => ({ agentMigrationService: {} }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@main/core/embedded-controller/embedded-controllers', () => ({
  embeddedControllerService: {
    enrolledControllerId: mocks.enrolledControllerId,
    disable: mocks.disableThisComputer,
  },
}));
vi.mock('@main/core/host-controllers/host-controllers', () => ({
  hostControllerService: { recordsOn: mocks.recordsOn, disable: mocks.disableHost },
}));
vi.mock('@main/core/workspaces/workspaces-store', () => ({ requireWorkspaceForServer: vi.fn() }));
vi.mock('@main/core/workspaces/workspace-session', () => ({
  withReachableServerWorkspaceSession: (_serverId: string, run: (server: unknown) => unknown) =>
    run({ id: 'server-1', url: 'https://switch.example.com' }),
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  AgentManagementUnavailableError: class extends Error {},
  GatewayError: class extends Error {},
  managementErrorMessage: vi.fn(),
  revokeManagementController: mocks.revokeManagementController,
  fetchManagementController: mocks.fetchManagementController,
}));

const { managedAgentsController } = await import('./controller');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enrolledControllerId.mockResolvedValue('this-computer');
  mocks.recordsOn.mockResolvedValue([{ controllerId: 'ssh-controller', sshHost: 'build-01' }]);
});

describe('removeDevice', () => {
  it('turns this computer off the way its own screen does', async () => {
    await managedAgentsController.removeDevice({
      serverId: 'server-1',
      machineId: 'this-computer',
    });
    expect(mocks.disableThisComputer).toHaveBeenCalledWith('server-1');
    expect(mocks.revokeManagementController).not.toHaveBeenCalled();
  });

  it('turns an SSH host of this Console off through its host controller', async () => {
    await managedAgentsController.removeDevice({
      serverId: 'server-1',
      machineId: 'ssh-controller',
    });
    expect(mocks.disableHost).toHaveBeenCalledWith('build-01', 'server-1', { force: false });
    expect(mocks.revokeManagementController).not.toHaveBeenCalled();
  });

  it('revokes any other device on the server', async () => {
    await managedAgentsController.removeDevice({ serverId: 'server-1', machineId: 'elsewhere' });
    expect(mocks.revokeManagementController).toHaveBeenCalledWith(
      { id: 'server-1', url: 'https://switch.example.com' },
      'elsewhere'
    );
    expect(mocks.disableThisComputer).not.toHaveBeenCalled();
    expect(mocks.disableHost).not.toHaveBeenCalled();
  });
});

describe('device', () => {
  it('tells this computer apart, and keeps a revoked device', async () => {
    mocks.fetchManagementController.mockResolvedValue({
      id: 'this-computer',
      name: 'mac',
      description: 'Work laptop',
      kind: 'console',
      state: 'revoked',
      lastSeenAt: null,
      revokedAt: '2026-11-02T10:00:00Z',
      providers: [],
      workspacesDir: null,
      os: 'macos',
      sealingKey: null,
      report: {
        createdAt: null,
        version: null,
        release: null,
        platform: null,
        machine: null,
        observedAt: null,
        agents: [],
      },
    });
    const device = await managedAgentsController.device({
      serverId: 'server-1',
      machineId: 'this-computer',
    });
    expect(device).toMatchObject({
      id: 'this-computer',
      state: 'revoked',
      description: 'Work laptop',
      revokedAt: '2026-11-02T10:00:00Z',
      local: { kind: 'this-computer' },
    });
  });
});
