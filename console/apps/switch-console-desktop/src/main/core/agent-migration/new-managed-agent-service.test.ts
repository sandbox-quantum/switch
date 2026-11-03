import { beforeEach, describe, expect, it } from 'vitest';
import type { TelemetryAgentCreateFailure } from '@main/core/telemetry/events';
import type { TargetLookup } from './agent-migration-service';
import {
  type AddManagedAgentParams,
  type ManagedCreateOutcome,
  managedCreateFailureOf,
  type NewManagedAgentDeps,
  NewManagedAgentService,
} from './new-managed-agent-service';

const PARAMS: AddManagedAgentParams = {
  machineId: 'controller-1',
  dir: '/work/pm',
  name: 'pm-agent',
  providerId: 'claude',
  serverId: 'server-1',
  description: 'Writes PRDs',
  displayName: 'PM',
  iconUrl: null,
  autoMode: true,
  autoApprove: true,
  instructions: 'Be brief.',
  model: 'opus',
  advancedConfig: { effort: 'high', tools: ['Read'] },
  isolation: 'isolated',
  entryPoint: 'sidebar',
};

const READY: TargetLookup = {
  display: { kind: 'this-computer', serverId: 'server-1', machineName: 'laptop' },
  target: {
    display: { kind: 'this-computer', serverId: 'server-1', machineName: 'laptop' },
    controllerId: 'controller-1',
    workspaceId: 'workspace-1',
    watcherRoot: (id) => `/data/watchers/${id}`,
  },
  blocker: null,
  canEnable: false,
  controller: { controllerId: 'controller-1', state: 'running' },
};

/** What the session seam throws when there is no sign-in to use. */
class SignedOut extends Error {}

type Config = {
  lookup: TargetLookup;
  management: boolean;
  createOutcome: ManagedCreateOutcome | Error;
};

type Harness = {
  deps: NewManagedAgentDeps;
  created: unknown[];
  /** The failure reason of every `agent_created` reported, in order. */
  reported: TelemetryAgentCreateFailure[];
  set(patch: Partial<Config>): void;
};

function harness(): Harness {
  const config: Config = {
    lookup: READY,
    management: true,
    createOutcome: { kind: 'created', switchAgentId: 'switch-9' },
  };
  const created: unknown[] = [];
  const reported: TelemetryAgentCreateFailure[] = [];
  return {
    created,
    reported,
    set: (patch) => Object.assign(config, patch),
    deps: {
      workspaceFor: async () => 'workspace-1',
      machine: async () => config.lookup,
      managementAvailable: async () => config.management,
      create: async (_workspaceId, body) => {
        created.push(body);
        if (config.createOutcome instanceof Error) throw config.createOutcome;
        return config.createOutcome;
      },
      reportCreate: (_input, failure) => reported.push(failure),
      thrownFailure: (error) => (error instanceof SignedOut ? 'unauthenticated' : 'error'),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    },
  };
}

describe('NewManagedAgentService.add', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('creates the agent on the server, running on the machine’s controller, and keeps nothing locally', async () => {
    const result = await new NewManagedAgentService(h.deps).add(PARAMS);

    expect(result).toEqual({
      kind: 'created',
      serverId: 'server-1',
      workspaceId: 'workspace-1',
      switchAgentId: 'switch-9',
    });
    expect(h.created).toEqual([
      {
        name: 'pm-agent',
        description: 'Writes PRDs',
        display_name: 'PM',
        icon_url: null,
        controller_id: 'controller-1',
        desired_state: 'running',
        definition: {
          provider: 'claude',
          model: 'opus',
          advanced_config: { effort: 'high', tools: ['Read'] },
          instructions: 'Be brief.',
          auto_mode: true,
          auto_approve: true,
          directory: '/work/pm',
          isolation: 'isolated',
        },
      },
    ]);
  });

  it('places it on the machine the form chose, whatever it is', async () => {
    h.set({ lookup: { ...READY, target: null, blocker: 'Not this computer.' } });
    const result = await new NewManagedAgentService(h.deps).add({
      ...PARAMS,
      machineId: 'cloud-vm-7',
    });
    expect(result.kind).toBe('created');
    expect(h.created).toMatchObject([{ controller_id: 'cloud-vm-7' }]);
  });

  it('asks the machine for a fresh workspace when no directory is given', async () => {
    await new NewManagedAgentService(h.deps).add({ ...PARAMS, dir: null });
    expect(h.created).toMatchObject([{ definition: { directory: null } }]);
  });

  it('says a name Switch already has is taken', async () => {
    h.set({ createOutcome: { kind: 'name-conflict' } });
    expect(await new NewManagedAgentService(h.deps).add(PARAMS)).toEqual({
      kind: 'name-conflict',
    });
  });

  it('shows a refusal of the agent or its placement in Switch’s words', async () => {
    h.set({
      createOutcome: {
        kind: 'refused',
        message: 'Claude Code is not logged in on laptop.',
        reason: 'refused',
      },
    });
    expect(await new NewManagedAgentService(h.deps).add(PARAMS)).toEqual({
      kind: 'error',
      message: 'Claude Code is not logged in on laptop.',
    });
  });

  it('leaves the advanced configuration for Switch to judge against its own fields', async () => {
    h.set({
      createOutcome: {
        kind: 'refused',
        message: "advanced_config: codex has no setting 'tools' (it takes effort, verbosity)",
        reason: 'invalid',
      },
    });
    const result = await new NewManagedAgentService(h.deps).add({
      ...PARAMS,
      providerId: 'codex',
      advancedConfig: { tools: ['Read'] },
    });
    expect(h.created).toHaveLength(1);
    expect(result).toEqual({ kind: 'error', message: expect.stringContaining("'tools'") });
  });

  it('refuses instructions longer than a managed agent takes, before creating anything', async () => {
    const result = await new NewManagedAgentService(h.deps).add({
      ...PARAMS,
      instructions: 'x'.repeat(33 * 1024),
    });
    expect(result.kind).toBe('error');
    expect(h.created).toEqual([]);
  });
});

describe('NewManagedAgentService.add reporting', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('reports an agent it created', async () => {
    await new NewManagedAgentService(h.deps).add(PARAMS);
    expect(h.reported).toEqual(['none']);
  });

  it('reports a taken name as a name conflict', async () => {
    h.set({ createOutcome: { kind: 'name-conflict' } });
    await new NewManagedAgentService(h.deps).add(PARAMS);
    expect(h.reported).toEqual(['name_conflict']);
  });

  it('reports a refusal under the reason Switch gave, not as a fault', async () => {
    for (const reason of ['refused', 'invalid', 'unauthenticated'] as const) {
      const run = harness();
      run.set({ createOutcome: { kind: 'refused', message: 'No.', reason } });
      await new NewManagedAgentService(run.deps).add(PARAMS);
      expect(run.reported).toEqual([reason]);
    }
  });

  it('reports instructions it turned away before asking the server as invalid', async () => {
    await new NewManagedAgentService(h.deps).add({
      ...PARAMS,
      instructions: 'x'.repeat(33 * 1024),
    });
    expect(h.reported).toEqual(['invalid']);
  });

  it('reports a create the session seam refused for want of a sign-in as unauthenticated', async () => {
    h.set({ createOutcome: new SignedOut('Not signed in to this Switch server.') });
    await expect(new NewManagedAgentService(h.deps).add(PARAMS)).rejects.toThrow('Not signed in');
    expect(h.reported).toEqual(['unauthenticated']);
  });

  it('reports a create that threw, once, and still throws it', async () => {
    h.set({ createOutcome: new Error('connect ECONNREFUSED') });
    await expect(new NewManagedAgentService(h.deps).add(PARAMS)).rejects.toThrow('ECONNREFUSED');
    expect(h.reported).toEqual(['error']);
  });
});

describe('managedCreateFailureOf', () => {
  const failure = (
    status: number | undefined,
    code: string | null,
    kind: 'http' | 'unauthorized' | 'network' = 'http'
  ) => managedCreateFailureOf({ kind, status, code });

  it('reads a 409 that is a validation error as the name taken', () => {
    expect(failure(409, 'validation_error')).toBe('name-conflict');
    expect(failure(409, null)).toBe('name-conflict');
  });

  it('reads a 409 that names the machine as a refused placement, not a taken name', () => {
    for (const code of [
      'controller_offline',
      'controller_revoked',
      'provider_not_installed',
      'provider_login_expired',
    ])
      expect(failure(409, code)).toBe('refused');
  });

  it('files an expired session apart from a placement', () => {
    expect(failure(401, null, 'unauthorized')).toBe('unauthenticated');
  });

  it('files fields Switch would not accept as invalid', () => {
    expect(failure(422, 'validation_error')).toBe('invalid');
    expect(failure(400, 'definition_invalid')).toBe('invalid');
    expect(failure(400, null)).toBe('invalid');
  });

  it('files anything else Switch turned down as refused', () => {
    expect(failure(403, 'forbidden')).toBe('refused');
  });

  it('is not a refusal when the server could not be reached or failed', () => {
    expect(failure(undefined, null, 'network')).toBeNull();
    expect(failure(undefined, null, 'unauthorized')).toBeNull();
    expect(failure(503, 'internal')).toBeNull();
  });
});

describe('NewManagedAgentService.machineFor', () => {
  const ref = { serverId: 'server-1', workspaceId: 'workspace-1', sshHost: null };

  it('says Console runs the agent when the server has no agent management', async () => {
    const h = harness();
    h.set({ management: false });
    expect(await new NewManagedAgentService(h.deps).machineFor(ref)).toEqual({
      management: false,
    });
  });

  it('reports the machine and whether Console can turn it on', async () => {
    const h = harness();
    h.set({ lookup: { ...READY, target: null, blocker: 'Turn it on first.', canEnable: true } });
    expect(await new NewManagedAgentService(h.deps).machineFor(ref)).toEqual({
      management: true,
      target: READY.display,
      blocker: 'Turn it on first.',
      canEnable: true,
    });
  });

  it('refuses a machine enrolled for another workspace', async () => {
    const h = harness();
    h.set({ lookup: { ...READY, target: { ...READY.target!, workspaceId: 'workspace-2' } } });
    const machine = await new NewManagedAgentService(h.deps).machineFor(ref);
    expect(machine.management && machine.blocker).toMatch(/another workspace/);
  });
});
