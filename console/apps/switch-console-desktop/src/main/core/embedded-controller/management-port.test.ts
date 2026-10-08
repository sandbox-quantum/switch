import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedAgent } from '@main/core/switch-servers/gateway-client';

class AgentManagementUnavailableError extends Error {}
const fetchManagementControllers = vi.hoisted(() => vi.fn());
const fetchManagedAgents = vi.hoisted(() => vi.fn());
const revokeManagementController = vi.hoisted(() => vi.fn());
const updateManagementController = vi.hoisted(() => vi.fn());
const enrollConsoleController = vi.hoisted(() => vi.fn());
const managementErrorCode = vi.hoisted(() => vi.fn((): string | null => null));

vi.mock('@main/core/switch-servers/gateway-client', () => ({
  AgentManagementUnavailableError,
  enrollConsoleController,
  fetchManagedAgents,
  fetchManagementControllers,
  managementErrorCode,
  managementErrorMessage: (error: unknown) => (error as Error).message,
  revokeManagementController,
  updateManagementController,
}));
vi.mock('@main/core/workspaces/workspace-session', () => ({
  withReachableWorkspaceSession: async (
    _workspaceId: string,
    fn: (server: unknown) => Promise<unknown>
  ) => fn({ id: 'server-1', name: 'S', apiUrl: 'https://switch.example.com' }),
}));

const { gatewayManagementPort, placedOn } = await import('./management-port');

const agent = (agentId: string, controllerId: string | null, name: string): ManagedAgent => ({
  agentId,
  name,
  displayName: null,
  iconUrl: null,
  description: '',
  controllerId,
  desiredState: 'running',
  revision: 1,
  provider: 'claude',
  model: null,
  advancedConfig: {},
  instructions: '',
  isolation: 'shared',
  connections: [],
  directory: null,
  autoApprove: false,
  status: null,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('placedOn', () => {
  it('keeps only the agents placed on this controller, by name, with its state', () => {
    expect(
      placedOn(
        'controller-1',
        [
          {
            id: 'controller-1',
            name: 'box',
            description: 'The office box',
            kind: 'console',
            state: 'online',
            lastSeenAt: '2026-01-01T00:00:00Z',
            revokedAt: null,
            providers: [],
            workspacesDir: null,
          },
        ],
        [
          agent('a', 'controller-1', 'zed'),
          agent('b', 'controller-2', 'elsewhere'),
          agent('c', null, 'unplaced'),
          agent('d', 'controller-1', 'alpha'),
        ]
      )
    ).toEqual({
      kind: 'ok',
      controller: {
        name: 'box',
        description: 'The office box',
        state: 'online',
        lastSeenAt: '2026-01-01T00:00:00Z',
      },
      agents: [
        {
          agentId: 'd',
          name: 'alpha',
          displayName: null,
          provider: 'claude',
          desiredState: 'running',
          actual: null,
        },
        {
          agentId: 'a',
          name: 'zed',
          displayName: null,
          provider: 'claude',
          desiredState: 'running',
          actual: null,
        },
      ],
    });
    expect(placedOn('gone', [], []).controller).toBeNull();
  });
});

describe('gatewayManagementPort', () => {
  it('enrolls and says which server and agent bridge that was', async () => {
    enrollConsoleController.mockResolvedValue({ controllerId: 'c-1', credential: 'swcc_x' });
    expect(
      await gatewayManagementPort.enroll('workspace-1', {
        name: 'box',
        platform: { os: 'linux', arch: 'x64', os_version: '6' },
        version: '0.1.0',
      })
    ).toEqual({
      serverId: 'server-1',
      apiUrl: 'https://switch.example.com',
      controllerId: 'c-1',
      credential: 'swcc_x',
    });
  });

  it('reads a server without agent management as unavailable, and other failures as errors', async () => {
    fetchManagementControllers.mockRejectedValue(new AgentManagementUnavailableError('off'));
    expect(await gatewayManagementPort.read('workspace-1', null)).toEqual({ kind: 'unavailable' });
    fetchManagementControllers.mockRejectedValue(new Error('Not signed in to this Switch server.'));
    expect(await gatewayManagementPort.read('workspace-1', 'c-1')).toEqual({
      kind: 'error',
      message: 'Not signed in to this Switch server.',
    });
    fetchManagementControllers.mockResolvedValue([]);
    expect(await gatewayManagementPort.read('workspace-1', null)).toEqual({
      kind: 'ok',
      controller: null,
      agents: [],
    });
    expect(fetchManagedAgents).not.toHaveBeenCalled();
  });

  it('renames and describes the controller, and says what failed', async () => {
    updateManagementController.mockResolvedValue(undefined);
    await gatewayManagementPort.update('workspace-1', 'c-1', { name: 'laptop', description: null });
    expect(updateManagementController).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'server-1' }),
      'c-1',
      { name: 'laptop', description: null }
    );
    updateManagementController.mockRejectedValue(new Error('Controller not found'));
    await expect(
      gatewayManagementPort.update('workspace-1', 'c-1', { name: 'laptop' })
    ).rejects.toThrow(/Could not change this computer in Switch: Controller not found/);
  });

  it('treats a controller the server does not know as already revoked, and raises anything else', async () => {
    revokeManagementController.mockResolvedValue(undefined);
    expect(await gatewayManagementPort.revoke('workspace-1', 'c-1')).toBe('revoked');
    expect(revokeManagementController).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'server-1' }),
      'c-1'
    );
    revokeManagementController.mockRejectedValue(new Error('Controller not found'));
    managementErrorCode.mockReturnValueOnce('not_found');
    expect(await gatewayManagementPort.revoke('workspace-1', 'c-1')).toBe('already_gone');
    revokeManagementController.mockRejectedValue(new Error('Switch session expired'));
    await expect(gatewayManagementPort.revoke('workspace-1', 'c-1')).rejects.toThrow(
      /Could not remove this computer from Switch, so it keeps running: Switch session expired/
    );
  });
});
