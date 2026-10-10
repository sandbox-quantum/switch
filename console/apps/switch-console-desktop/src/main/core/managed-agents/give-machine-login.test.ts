import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSealingKeyPair,
  openProviderLogin,
  parseVertexLogin,
  sealingKeyId,
} from '@switch-console/agent-providers';
import {
  AUTHORIZED_USER_FIXTURE,
  SERVICE_ACCOUNT_KEY_FIXTURE,
} from '@switch-console/agent-providers/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    run({ id: 'server-1', gatewayUrl: 'https://switch.example.com' }),
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

  describe('through Vertex AI', () => {
    let gcloud: string;
    const previous = process.env.CLOUDSDK_CONFIG;
    beforeEach(() => {
      gcloud = mkdtempSync(join(tmpdir(), 'gcloud-'));
      process.env.CLOUDSDK_CONFIG = gcloud;
      mocks.fetchManagementControllers.mockResolvedValue([
        machine({ key: keys.publicKey, keyId: sealingKeyId(keys.publicKey) }),
      ]);
    });
    afterEach(() => {
      if (previous === undefined) delete process.env.CLOUDSDK_CONFIG;
      else process.env.CLOUDSDK_CONFIG = previous;
      rmSync(gcloud, { recursive: true, force: true });
    });

    const give = (
      credentials: { from: 'key'; json: string } | { from: 'this-computer' },
      provider: 'claude' | 'codex' = 'claude',
      project = 'cg-vertexai'
    ) =>
      managedAgentsController.giveMachineLogin({
        serverId: 'server-1',
        machineId: 'controller-1',
        provider,
        login: { source: 'vertex', project, region: 'global', credentials },
      });

    function given() {
      const [, , provider, sealed] = mocks.giveMachineLogin.mock.calls.at(-1)!;
      const login = openProviderLogin({ keys, controllerId: 'controller-1', provider, sealed });
      expect(login.kind).toBe('vertex');
      return parseVertexLogin(login.credential);
    }

    it('seals a pasted service account key with the project and region', async () => {
      await give({ from: 'key', json: `  ${JSON.stringify(SERVICE_ACCOUNT_KEY_FIXTURE)}\n` });
      expect(JSON.stringify(mocks.giveMachineLogin.mock.calls[0]![3])).not.toContain('PRIVATE KEY');
      expect(given()).toEqual({
        v: 1,
        project: 'cg-vertexai',
        region: 'global',
        credentials: SERVICE_ACCOUNT_KEY_FIXTURE,
      });
    });

    it("seals this computer's Google sign-in, from CLOUDSDK_CONFIG", async () => {
      writeFileSync(
        join(gcloud, 'application_default_credentials.json'),
        JSON.stringify(AUTHORIZED_USER_FIXTURE)
      );
      await give({ from: 'this-computer' });
      expect(given().credentials).toEqual(AUTHORIZED_USER_FIXTURE);
    });

    it('says to sign in with gcloud when this computer has no Google sign-in', async () => {
      await expect(give({ from: 'this-computer' })).rejects.toThrow(
        'Run `gcloud auth application-default login` on this computer first.'
      );
      expect(mocks.giveMachineLogin).not.toHaveBeenCalled();
    });

    it('refuses another provider, another credential type, or a bad project', async () => {
      const key = { from: 'key' as const, json: JSON.stringify(SERVICE_ACCOUNT_KEY_FIXTURE) };
      await expect(give(key, 'codex')).rejects.toThrow(/Only Claude/);
      await expect(
        give({ from: 'key', json: JSON.stringify({ type: 'external_account' }) })
      ).rejects.toThrow(/Only a service account key/);
      await expect(give({ from: 'key', json: '{' })).rejects.toThrow(/not JSON/);
      await expect(give({ from: 'key', json: ' ' })).rejects.toThrow(
        /Paste the service account key/
      );
      await expect(give(key, 'claude', 'Not A Project')).rejects.toThrow(/project id/);
      expect(mocks.giveMachineLogin).not.toHaveBeenCalled();
    });
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
