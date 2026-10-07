import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TargetLookup } from './agent-migration-service';
import {
  type AddManagedAgentParams,
  type ManagedCreateOutcome,
  type NewManagedAgentDeps,
  NewManagedAgentService,
} from './new-managed-agent-service';

const PARAMS: AddManagedAgentParams = {
  machineId: 'controller-1',
  dir: '/work/pm',
  repository: null,
  name: 'pm-agent',
  providerId: 'claude',
  serverId: 'server-1',
  description: 'Writes PRDs',
  displayName: 'PM',
  iconUrl: null,
  autoApprove: true,
  instructions: 'Be brief.',
  model: 'opus',
  advancedConfig: { effort: 'high', tools: ['Read'] },
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

type Config = {
  lookup: TargetLookup;
  management: boolean;
  createOutcome: ManagedCreateOutcome;
};

type Harness = {
  deps: NewManagedAgentDeps;
  created: unknown[];
  set(patch: Partial<Config>): void;
};

function harness(): Harness {
  const config: Config = {
    lookup: READY,
    management: true,
    createOutcome: { kind: 'created', switchAgentId: 'switch-9' },
  };
  const created: unknown[] = [];
  return {
    created,
    set: (patch) => Object.assign(config, patch),
    deps: {
      workspaceFor: async () => 'workspace-1',
      machine: async () => config.lookup,
      managementAvailable: async () => config.management,
      create: async (_workspaceId, body) => {
        created.push(body);
        return config.createOutcome;
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

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
          auto_approve: true,
          directory: '/work/pm',
          repository: null,
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

  it('names the GitHub repository a Switch cloud machine clones for the agent', async () => {
    vi.stubEnv('SWITCH_CLOUD_ENABLED', 'true');
    await new NewManagedAgentService(h.deps).add({
      ...PARAMS,
      dir: null,
      repository: { installationId: 12, repositoryId: 34 },
    });
    expect(h.created).toMatchObject([
      { definition: { directory: null, repository: { installation_id: 12, repository_id: 34 } } },
    ]);
  });

  it('refuses a cloud machine agent while Switch Cloud is turned off', async () => {
    vi.stubEnv('SWITCH_CLOUD_ENABLED', 'false');
    const result = await new NewManagedAgentService(h.deps).add({
      ...PARAMS,
      dir: null,
      repository: { installationId: 12, repositoryId: 34 },
    });
    expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('turned off') });
    expect(h.created).toEqual([]);
  });

  it('says a name Switch already has is taken', async () => {
    h.set({ createOutcome: { kind: 'name-conflict' } });
    expect(await new NewManagedAgentService(h.deps).add(PARAMS)).toEqual({
      kind: 'name-conflict',
    });
  });

  it('shows a refusal of the agent or its placement in Switch’s words', async () => {
    h.set({
      createOutcome: { kind: 'refused', message: 'Claude Code is not logged in on laptop.' },
    });
    expect(await new NewManagedAgentService(h.deps).add(PARAMS)).toEqual({
      kind: 'error',
      message: 'Claude Code is not logged in on laptop.',
    });
  });

  it('refuses an advanced configuration field the provider does not offer, naming it', async () => {
    const result = await new NewManagedAgentService(h.deps).add({
      ...PARAMS,
      providerId: 'codex',
      advancedConfig: { tools: ['Read'] },
    });
    expect(result).toEqual({ kind: 'error', message: expect.stringContaining("'tools'") });
    expect(h.created).toEqual([]);
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
