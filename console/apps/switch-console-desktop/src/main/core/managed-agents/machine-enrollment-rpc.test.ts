import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ issueMachineEnrollment: vi.fn() }));

vi.mock('@main/core/agent-migration/agent-migration', () => ({ agentMigrationService: {} }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@main/core/embedded-controller/embedded-controllers', () => ({
  embeddedControllerService: {},
}));
vi.mock('@main/core/host-controllers/host-controllers', () => ({ hostControllerService: {} }));
vi.mock('@main/core/workspaces/workspaces-store', () => ({ requireWorkspaceForServer: vi.fn() }));
vi.mock('@main/core/workspaces/workspace-session', () => ({
  withReachableServerWorkspaceSession: (_serverId: string, run: (server: unknown) => unknown) =>
    run({ id: 'server-1', url: 'https://switch.internal.example' }),
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  AgentManagementUnavailableError: class extends Error {},
  GatewayError: class extends Error {},
  managementErrorMessage: vi.fn(),
  issueMachineEnrollment: mocks.issueMachineEnrollment,
}));

const { managedAgentsController } = await import('./controller');

beforeEach(() => vi.clearAllMocks());

describe('machineEnrollment', () => {
  it('uses the address the server names', async () => {
    mocks.issueMachineEnrollment.mockResolvedValue({
      code: 'c',
      expiresAt: '2026-11-04T10:10:00Z',
      serverUrl: 'https://switch.example.com',
    });
    expect(await managedAgentsController.machineEnrollment('server-1')).toEqual({
      code: 'c',
      expiresAt: '2026-11-04T10:10:00Z',
      serverUrl: 'https://switch.example.com',
      loopback: false,
      fallback: false,
    });
  });

  it('says when it falls back to the address Console reaches the server at', async () => {
    mocks.issueMachineEnrollment.mockResolvedValue({
      code: 'c',
      expiresAt: '2026-11-04T10:10:00Z',
      serverUrl: null,
    });
    expect(await managedAgentsController.machineEnrollment('server-1')).toMatchObject({
      serverUrl: 'https://switch.internal.example',
      loopback: false,
      fallback: true,
    });
  });

  it('treats an empty address from the server as none named', async () => {
    mocks.issueMachineEnrollment.mockResolvedValue({
      code: 'c',
      expiresAt: '2026-11-04T10:10:00Z',
      serverUrl: '',
    });
    expect(await managedAgentsController.machineEnrollment('server-1')).toMatchObject({
      serverUrl: 'https://switch.internal.example',
      fallback: true,
    });
  });
});
