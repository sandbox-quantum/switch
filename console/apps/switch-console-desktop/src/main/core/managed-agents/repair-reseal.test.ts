import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSealingKeyPair,
  openProviderLogin,
  sealingKeyId,
} from '@switch-console/agent-providers';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// V3b, Repair my cloud and the re-seal after it, through the main process (design v1.2).

const userData = mkdtempSync(join(tmpdir(), 'repair-reseal-'));
afterAll(() => rmSync(userData, { recursive: true, force: true }));

const mocks = vi.hoisted(() => ({
  fetchManagementControllers: vi.fn(),
  giveMachineLogin: vi.fn(),
  listCloudMachines: vi.fn(),
  repairController: vi.fn(),
  readLocalProviderSignIn: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock('electron', () => ({ app: { getPath: () => userData } }));
vi.mock('@main/core/agent-migration/agent-migration', () => ({ agentMigrationService: {} }));
vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: mocks.logInfo },
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
vi.mock('@main/core/switch-servers/gateway-client', () => {
  class GatewayError extends Error {
    constructor(
      readonly kind: string,
      message: string,
      readonly status?: number,
      readonly detail?: string,
      readonly code?: string,
      readonly body?: string
    ) {
      super(message);
    }
  }
  return {
    AgentManagementUnavailableError: class extends Error {},
    GatewayError,
    deleteAgent: vi.fn(),
    fetchAdvancedConfigSchema: vi.fn(),
    fetchManagedAgents: vi.fn(),
    fetchMachineOperation: vi.fn(),
    managementErrorMessage: vi.fn(),
    managementErrorCode: (error: { body?: string }) => {
      try {
        return (JSON.parse(error.body ?? '') as { error: { code: string } }).error.code;
      } catch {
        return null;
      }
    },
    setManagedAgentDesiredState: vi.fn(),
    updateManagedAgent: vi.fn(),
    fetchManagementControllers: mocks.fetchManagementControllers,
    giveMachineLogin: mocks.giveMachineLogin,
    listCloudMachines: mocks.listCloudMachines,
    repairController: mocks.repairController,
  };
});

const { managedAgentsController } = await import('./controller');
const { GatewayError } = (await import('@main/core/switch-servers/gateway-client')) as unknown as {
  GatewayError: new (...args: unknown[]) => Error;
};

const keys = generateSealingKeyPair();
const SEAL = { key: keys.publicKey, keyId: sealingKeyId(keys.publicKey) };
const codexAuth = (account: string) =>
  JSON.stringify({
    tokens: {
      id_token: 'i',
      access_token: 'zebra-access',
      refresh_token: 'r',
      account_id: account,
    },
  });

type Ctl = {
  id: string;
  revokedAt: string | null;
  createdAt: string | null;
  sealingKey: typeof SEAL | null;
};
const ctl = (id: string, over: Partial<Ctl> = {}): Ctl & { name: string; kind: string } => ({
  id,
  name: 'cloud',
  kind: 'ec2',
  revokedAt: null,
  createdAt: '2026-10-29T17:00:00Z',
  sealingKey: SEAL,
  ...over,
});

let machineSeq = 0;
/** One cloud machine through a whole repair: the old controller given Codex from this computer,
 * a press, then the box's new controller asking for it again. */
async function repairedMachine(account = 'acct-1') {
  const machineId = `machine-${++machineSeq}`;
  const old = `old-${machineSeq}`;
  mocks.fetchManagementControllers.mockResolvedValue([ctl(old)]);
  mocks.readLocalProviderSignIn.mockResolvedValue(codexAuth(account));
  await managedAgentsController.giveMachineLogin({
    serverId: 'server-1',
    machineId: old,
    provider: 'codex',
    login: { source: 'this-computer' },
  });
  mocks.fetchManagementControllers.mockResolvedValue([
    ctl(old, { revokedAt: new Date(Date.now() - 60_000).toISOString() }),
  ]);
  mocks.listCloudMachines.mockResolvedValue([{ machine_id: machineId, controller_id: old }]);
  await managedAgentsController.repairCloud({ serverId: 'server-1', machineId, controllerId: old });
  return { machineId, old };
}

function boxAsks(machineId: string, controllerId: string, providers = ['codex']) {
  mocks.listCloudMachines.mockResolvedValue([
    { machine_id: machineId, controller_id: controllerId, reseal_providers: providers },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.giveMachineLogin.mockResolvedValue({ operationId: 'op-1', revision: 1 });
  mocks.repairController.mockResolvedValue(undefined);
});

describe('repairing a cloud box', () => {
  it('refuses a machine and controller that don’t belong together, before calling Core', async () => {
    mocks.listCloudMachines.mockResolvedValue([{ machine_id: 'm', controller_id: 'someone-else' }]);
    const failure = await managedAgentsController
      .repairCloud({ serverId: 'server-1', machineId: 'm', controllerId: 'c' })
      .catch((error: unknown) => error as Error);
    expect((failure as Error).message).toBe(
      "This cloud can't be repaired from here. Reload and try again."
    );
    mocks.listCloudMachines.mockResolvedValue([]);
    await managedAgentsController
      .repairCloud({ serverId: 'server-1', machineId: 'm', controllerId: 'c' })
      .catch(() => {});
    expect(mocks.repairController).not.toHaveBeenCalled();
  });

  it('turns each refusal into its fixed line, never the server’s text', async () => {
    const MARKER = 'zebra-marker-7f3c';
    for (const [status, code, line] of [
      [409, 'repair_not_needed', "Your cloud is signing in again, so there's nothing to repair."],
      [
        403,
        'paused_by_switch',
        "Switch has paused your cloud, so it can't be repaired. Contact your admin.",
      ],
      [403, undefined, "The repair didn't go through. Try again in a minute."],
      [500, undefined, "The repair didn't go through. Try again in a minute."],
    ] as const) {
      const body = JSON.stringify({ error: { code: code ?? 'x', message: MARKER } });
      mocks.listCloudMachines.mockResolvedValue([{ machine_id: 'm', controller_id: 'c' }]);
      mocks.repairController.mockRejectedValueOnce(
        new GatewayError('http', MARKER, status, MARKER, undefined, code ? body : '{}')
      );
      const failure = await managedAgentsController
        .repairCloud({ serverId: 'server-1', machineId: 'm', controllerId: 'c' })
        .catch((error: unknown) => error as Error);
      expect((failure as Error).message).toBe(line);
      expect((failure as Error).message).not.toContain(MARKER);
    }
  });
});

describe('the re-seal after a repair', () => {
  it('copies by itself to the first new controller, sealed to that controller’s key', async () => {
    const { machineId } = await repairedMachine();
    mocks.giveMachineLogin.mockClear();
    mocks.fetchManagementControllers.mockResolvedValue([
      ctl('new-1', { createdAt: new Date().toISOString() }),
    ]);
    boxAsks(machineId, 'new-1');
    expect(
      await managedAgentsController.resealAfterRepair({ serverId: 'server-1', machineId })
    ).toEqual({
      copied: ['codex'],
      asked: [],
    });
    const [, controllerId, provider, sealed] = mocks.giveMachineLogin.mock.calls[0]!;
    expect([controllerId, provider]).toEqual(['new-1', 'codex']);
    expect(JSON.stringify(sealed)).not.toContain('zebra-access');
    expect(
      openProviderLogin({ keys, controllerId: 'new-1', provider: 'codex', sealed })
    ).toMatchObject({
      kind: 'auth-json',
    });
    // Counts only in the log.
    expect(JSON.stringify(mocks.logInfo.mock.calls)).not.toContain('zebra');
  });

  it('asks, not copies, for a second new controller within the window', async () => {
    const { machineId } = await repairedMachine();
    mocks.fetchManagementControllers.mockResolvedValue([
      ctl('first', { createdAt: new Date().toISOString() }),
    ]);
    boxAsks(machineId, 'first');
    await managedAgentsController.resealAfterRepair({ serverId: 'server-1', machineId });
    mocks.giveMachineLogin.mockClear();
    mocks.fetchManagementControllers.mockResolvedValue([
      ctl('second', { createdAt: new Date().toISOString() }),
    ]);
    boxAsks(machineId, 'second');
    expect(
      await managedAgentsController.resealAfterRepair({ serverId: 'server-1', machineId })
    ).toEqual({
      copied: [],
      asked: ['codex'],
    });
    expect(mocks.giveMachineLogin).not.toHaveBeenCalled();
  });

  it('asks for the revoked controller itself, and one Core created before the revocation', async () => {
    const { machineId, old } = await repairedMachine();
    mocks.giveMachineLogin.mockClear();
    mocks.fetchManagementControllers.mockResolvedValue([
      ctl('older', { createdAt: '2020-01-01T00:00:00Z' }),
    ]);
    boxAsks(machineId, 'older');
    expect(
      (await managedAgentsController.resealAfterRepair({ serverId: 'server-1', machineId })).asked
    ).toEqual(['codex']);
    mocks.fetchManagementControllers.mockResolvedValue([
      ctl(old, { createdAt: new Date().toISOString() }),
    ]);
    boxAsks(machineId, old);
    expect(
      (await managedAgentsController.resealAfterRepair({ serverId: 'server-1', machineId })).asked
    ).toEqual(['codex']);
    expect(mocks.giveMachineLogin).not.toHaveBeenCalled();
  });

  it('asks when this computer is now signed in to another account', async () => {
    const { machineId } = await repairedMachine('acct-1');
    mocks.giveMachineLogin.mockClear();
    mocks.readLocalProviderSignIn.mockResolvedValue(codexAuth('acct-2'));
    mocks.fetchManagementControllers.mockResolvedValue([
      ctl('new-2', { createdAt: new Date().toISOString() }),
    ]);
    boxAsks(machineId, 'new-2');
    expect(
      await managedAgentsController.resealAfterRepair({ serverId: 'server-1', machineId })
    ).toEqual({
      copied: [],
      asked: ['codex'],
    });
    expect(mocks.giveMachineLogin).not.toHaveBeenCalled();
  });

  it('asks when the record named no account but this computer’s sign-in now names one (QA)', async () => {
    const machineId = 'no-account-machine';
    mocks.fetchManagementControllers.mockResolvedValue([ctl('na-old')]);
    mocks.readLocalProviderSignIn.mockResolvedValue(
      JSON.stringify({ tokens: { id_token: 'i', access_token: 'a', refresh_token: 'r' } })
    );
    await managedAgentsController.giveMachineLogin({
      serverId: 'server-1',
      machineId: 'na-old',
      provider: 'codex',
      login: { source: 'this-computer' },
    });
    mocks.fetchManagementControllers.mockResolvedValue([
      ctl('na-old', { revokedAt: new Date(Date.now() - 60_000).toISOString() }),
    ]);
    mocks.listCloudMachines.mockResolvedValue([{ machine_id: machineId, controller_id: 'na-old' }]);
    await managedAgentsController.repairCloud({
      serverId: 'server-1',
      machineId,
      controllerId: 'na-old',
    });
    mocks.giveMachineLogin.mockClear();
    mocks.readLocalProviderSignIn.mockResolvedValue(codexAuth('acct-new'));
    mocks.fetchManagementControllers.mockResolvedValue([
      ctl('na-new', { createdAt: new Date().toISOString() }),
    ]);
    boxAsks(machineId, 'na-new');
    expect(
      await managedAgentsController.resealAfterRepair({ serverId: 'server-1', machineId })
    ).toEqual({
      copied: [],
      asked: ['codex'],
    });
    expect(mocks.giveMachineLogin).not.toHaveBeenCalled();
  });

  it('asks when the local sign-in is gone, and tries at most once per controller and provider', async () => {
    const { machineId } = await repairedMachine();
    mocks.giveMachineLogin.mockClear();
    mocks.readLocalProviderSignIn.mockResolvedValue(null);
    mocks.fetchManagementControllers.mockResolvedValue([
      ctl('new-3', { createdAt: new Date().toISOString() }),
    ]);
    boxAsks(machineId, 'new-3');
    expect(
      (await managedAgentsController.resealAfterRepair({ serverId: 'server-1', machineId })).asked
    ).toEqual(['codex']);
    mocks.readLocalProviderSignIn.mockResolvedValue(codexAuth('acct-1'));
    expect(
      (await managedAgentsController.resealAfterRepair({ serverId: 'server-1', machineId })).asked
    ).toEqual(['codex']);
    expect(mocks.giveMachineLogin).not.toHaveBeenCalled();
  });

  it('asks for a key that was typed, and does nothing without a note from Core', async () => {
    const machineId = 'typed-machine';
    mocks.fetchManagementControllers.mockResolvedValue([ctl('t-old')]);
    await managedAgentsController.giveMachineLogin({
      serverId: 'server-1',
      machineId: 't-old',
      provider: 'codex',
      login: { source: 'typed', kind: 'api-key', credential: 'sk-proj-zebra' },
    });
    mocks.fetchManagementControllers.mockResolvedValue([
      ctl('t-old', { revokedAt: new Date(Date.now() - 60_000).toISOString() }),
    ]);
    mocks.listCloudMachines.mockResolvedValue([{ machine_id: machineId, controller_id: 't-old' }]);
    await managedAgentsController.repairCloud({
      serverId: 'server-1',
      machineId,
      controllerId: 't-old',
    });
    mocks.giveMachineLogin.mockClear();
    mocks.fetchManagementControllers.mockResolvedValue([
      ctl('t-new', { createdAt: new Date().toISOString() }),
    ]);
    boxAsks(machineId, 't-new');
    expect(
      (await managedAgentsController.resealAfterRepair({ serverId: 'server-1', machineId })).asked
    ).toEqual(['codex']);
    boxAsks(machineId, 't-new', []);
    expect(
      await managedAgentsController.resealAfterRepair({ serverId: 'server-1', machineId })
    ).toEqual({
      copied: [],
      asked: [],
    });
    expect(mocks.giveMachineLogin).not.toHaveBeenCalled();
  });

  it('never acts for a machine that is not the owner’s', async () => {
    mocks.listCloudMachines.mockResolvedValue([]);
    expect(
      await managedAgentsController.resealAfterRepair({
        serverId: 'server-1',
        machineId: 'someone-else',
      })
    ).toEqual({ copied: [], asked: [] });
    expect(mocks.fetchManagementControllers).not.toHaveBeenCalled();
  });
});
