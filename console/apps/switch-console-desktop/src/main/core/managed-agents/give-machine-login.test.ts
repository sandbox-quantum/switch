import {
  generateSealingKeyPair,
  openProviderLogin,
  sealingKeyId,
} from '@switch-console/agent-providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchManagementControllers: vi.fn(),
  giveMachineLogin: vi.fn(),
  fetchMachineOperation: vi.fn(),
  readLocalProviderSignIn: vi.fn(),
}));

vi.mock('@main/core/embedded-controller/embedded-controllers', () => ({
  embeddedControllerService: {},
}));
vi.mock('@main/core/host-controllers/host-controllers', () => ({ hostControllerService: {} }));
vi.mock('@main/core/workspaces/workspaces-store', () => ({ requireWorkspaceForServer: vi.fn() }));
vi.mock('@main/core/workspaces/workspace-session', () => ({
  withReachableServerWorkspaceSession: (_serverId: string, run: (server: unknown) => unknown) =>
    run({ id: 'server-1', url: 'https://switch.example.com' }),
}));
vi.mock('@main/core/switch-servers/local-provider-sign-in', () => ({
  localProviderAuthPath: () => '/home/me/.codex/auth.json',
  readLocalProviderSignIn: mocks.readLocalProviderSignIn,
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  AgentManagementUnavailableError: class extends Error {},
  GatewayError: class extends Error {},
  deleteAgent: vi.fn(),
  deleteManagedAgent: vi.fn(),
  fetchAdvancedConfigSchema: vi.fn(),
  fetchManagedAgents: vi.fn(),
  managementErrorMessage: vi.fn(),
  setManagedAgentDesiredState: vi.fn(),
  updateManagedAgent: vi.fn(),
  fetchManagementControllers: mocks.fetchManagementControllers,
  giveMachineLogin: mocks.giveMachineLogin,
  fetchMachineOperation: mocks.fetchMachineOperation,
}));

const { managedAgentsController } = await import('./controller');

const keys = generateSealingKeyPair();

function machine(sealingKey: { key: string; keyId: string } | null) {
  return { id: 'controller-1', name: 'build-box', sealingKey };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.giveMachineLogin.mockResolvedValue({ operationId: 'op-1', revision: 1 });
});

describe('giving a machine a provider login', () => {
  it('seals it to the machine’s own key before it leaves this computer', async () => {
    mocks.fetchManagementControllers.mockResolvedValue([
      machine({ key: keys.publicKey, keyId: sealingKeyId(keys.publicKey) }),
    ]);
    expect(
      await managedAgentsController.giveMachineLogin({
        serverId: 'server-1',
        machineId: 'controller-1',
        provider: 'claude',
        login: { source: 'typed', kind: 'setup-token', credential: ' sk-ant-oat-given ' },
      })
    ).toEqual({ operationId: 'op-1' });
    const [, controllerId, provider, sealed] = mocks.giveMachineLogin.mock.calls[0]!;
    expect([controllerId, provider]).toEqual(['controller-1', 'claude']);
    expect(JSON.stringify(sealed)).not.toContain('sk-ant');
    expect(
      openProviderLogin({ keys, controllerId: 'controller-1', provider: 'claude', sealed })
    ).toEqual({ kind: 'setup-token', credential: 'sk-ant-oat-given' });
  });

  it("sends this computer's own sign-in, for a provider that has one", async () => {
    mocks.fetchManagementControllers.mockResolvedValue([
      machine({ key: keys.publicKey, keyId: sealingKeyId(keys.publicKey) }),
    ]);
    mocks.readLocalProviderSignIn.mockResolvedValue('{"tokens":{}}');
    await managedAgentsController.giveMachineLogin({
      serverId: 'server-1',
      machineId: 'controller-1',
      provider: 'codex',
      login: { source: 'this-computer' },
    });
    const [, , , sealed] = mocks.giveMachineLogin.mock.calls[0]!;
    expect(
      openProviderLogin({ keys, controllerId: 'controller-1', provider: 'codex', sealed })
    ).toEqual({ kind: 'auth-json', credential: '{"tokens":{}}' });
    await expect(
      managedAgentsController.giveMachineLogin({
        serverId: 'server-1',
        machineId: 'controller-1',
        provider: 'claude',
        login: { source: 'this-computer' },
      })
    ).rejects.toThrow(/cannot be given/);
  });

  it('refuses a machine with no key, or a key that does not match its id', async () => {
    mocks.fetchManagementControllers.mockResolvedValue([machine(null)]);
    const give = () =>
      managedAgentsController.giveMachineLogin({
        serverId: 'server-1',
        machineId: 'controller-1',
        provider: 'claude',
        login: { source: 'typed', kind: 'api-key', credential: 'sk-ant-api-x' },
      });
    await expect(give()).rejects.toThrow(/no key/);
    mocks.fetchManagementControllers.mockResolvedValue([
      machine({ key: keys.publicKey, keyId: 'ffffffffffffffff' }),
    ]);
    await expect(give()).rejects.toThrow(/does not match/);
    expect(mocks.giveMachineLogin).not.toHaveBeenCalled();
  });

  it('says how the machine took the login up', async () => {
    const outcome = () =>
      managedAgentsController.machineLoginOutcome({
        serverId: 'server-1',
        machineId: 'controller-1',
        operationId: 'op-1',
      });
    mocks.fetchMachineOperation.mockResolvedValue({ state: 'claimed', error: null });
    expect(await outcome()).toEqual({ state: 'pending' });
    mocks.fetchMachineOperation.mockResolvedValue({ state: 'succeeded', error: null });
    expect(await outcome()).toEqual({ state: 'succeeded' });
    mocks.fetchMachineOperation.mockResolvedValue({
      state: 'failed',
      error: { code: 'provider_login_expired', message: 'It does not sign in.' },
    });
    expect(await outcome()).toEqual({
      state: 'failed',
      code: 'provider_login_expired',
      message: 'It does not sign in.',
    });
  });
});
