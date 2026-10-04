import { beforeEach, describe, expect, it } from 'vitest';
import type { Agent } from '@shared/core/agents/agents';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import type { Workspace } from '@shared/core/workspaces/workspaces';
import type { NewAgentChecks } from '../agents/add-agent';
import type { TargetLookup } from './agent-migration-service';
import type { ManagedAgentRecord } from './managed-agents-store';
import {
  type AddManagedAgentParams,
  type ManagedCreateOutcome,
  type NewManagedAgentDeps,
  NewManagedAgentService,
} from './new-managed-agent-service';

const WORKSPACE = { id: 'workspace-1' } as Workspace;
const SERVER = { id: 'server-1', apiUrl: 'https://switch.example.test' } as SwitchServer;

const PARAMS: AddManagedAgentParams = {
  sshHost: null,
  dir: '/work/pm',
  name: 'pm-agent',
  providerId: 'claude',
  serverId: 'server-1',
  description: 'Writes PRDs',
  displayName: 'PM',
  iconUrl: null,
  autoApprove: true,
  instructions: 'Be brief.',
  model: 'opus',
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

type Harness = {
  deps: NewManagedAgentDeps;
  calls: string[];
  records: Map<string, ManagedAgentRecord>;
  rows: Map<string, Agent>;
  created: { body: unknown } | null;
  set(patch: Partial<Config>): void;
};

type Config = {
  checks: NewAgentChecks;
  lookup: TargetLookup;
  management: boolean;
  createOutcome: ManagedCreateOutcome;
  failAt: string | null;
  deleteFails: boolean;
};

function harness(): Harness {
  const config: Config = {
    checks: { kind: 'ok', server: SERVER, workspace: WORKSPACE, slotAgentId: null },
    lookup: READY,
    management: true,
    createOutcome: { kind: 'created', switchAgentId: 'switch-9' },
    failAt: null,
    deleteFails: false,
  };
  const calls: string[] = [];
  const records = new Map<string, ManagedAgentRecord>();
  const rows = new Map<string, Agent>();
  const h: Harness = {
    calls,
    records,
    rows,
    created: null,
    set: (patch) => Object.assign(config, patch),
    deps: undefined as unknown as NewManagedAgentDeps,
  };
  const step = (name: string) => {
    calls.push(name);
    if (config.failAt === name) throw new Error(`${name} failed`);
  };
  h.deps = {
    check: async () => config.checks,
    machine: async () => config.lookup,
    managementAvailable: async () => config.management,
    management: {
      create: async (_workspaceId, body) => {
        step('create');
        h.created = { body };
        return config.createOutcome;
      },
      setIcon: async (_w, _id, iconUrl) => step(`icon ${iconUrl}`),
      setDesiredState: async (_w, _id, state) => step(`desired ${state}`),
      release: async () => step('release'),
      deleteAgent: async () => {
        calls.push('delete agent');
        if (config.deleteFails) throw new Error('delete refused');
      },
    },
    defaultIcon: (name) => `https://avatars.example.test/${name}.png`,
    writeConfig: async () => step('config'),
    store: {
      set: async (record) => {
        step('record');
        records.set(record.agentId, record);
      },
      delete: async (agentId) => {
        calls.push('forget record');
        records.delete(agentId);
      },
    },
    rows: {
      create: async ({ id, params, switchAgentId }) => {
        step('row');
        const agent = {
          id,
          locationId: 'location-1',
          name: params.name,
          providerId: params.providerId,
          switchAgentId,
        } as Agent;
        rows.set(id, agent);
        return agent;
      },
      discard: async (agentId) => {
        calls.push('discard row');
        rows.delete(agentId);
      },
    },
    announce: async () => step('announce'),
    newId: () => 'agent-new',
    now: () => Date.parse('2026-10-03T12:00:00Z'),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return h;
}

describe('NewManagedAgentService.add', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('places the agent stopped, records it before its row, then sets it running', async () => {
    const result = await new NewManagedAgentService(h.deps).add(PARAMS);

    expect(result.kind).toBe('created');
    expect(h.calls).toEqual([
      'create',
      'icon https://avatars.example.test/pm-agent.png',
      'config',
      'record',
      'row',
      'desired running',
      'announce',
    ]);
    expect(h.created?.body).toEqual({
      name: 'pm-agent',
      description: 'Writes PRDs',
      display_name: 'PM',
      controller_id: 'controller-1',
      desired_state: 'stopped',
      definition: {
        provider: 'claude',
        model: 'opus',
        instructions: 'Be brief.',
        auto_approve: true,
        directory: '/work/pm',
      },
    });
    expect(h.records.get('agent-new')).toEqual({
      agentId: 'agent-new',
      workspaceId: 'workspace-1',
      controllerId: 'controller-1',
      placement: { kind: 'this-computer', serverId: 'server-1' },
      identities: [
        {
          switchAgentId: 'switch-9',
          slug: 'pm-agent',
          subagent: null,
          credentialsStashed: false,
          controllerRoot: '/data/watchers/switch-9',
        },
      ],
      movedAt: '2026-10-03T12:00:00.000Z',
    });
  });

  it('records an SSH host placement for an agent on that host', async () => {
    h.set({
      lookup: {
        ...READY,
        target: {
          ...READY.target!,
          display: { kind: 'ssh-host', sshHost: 'box', serverId: 'server-1', machineName: 'box' },
        },
      },
    });
    await new NewManagedAgentService(h.deps).add({ ...PARAMS, sshHost: 'box', dir: '/srv/pm' });
    expect(h.records.get('agent-new')?.placement).toEqual({
      kind: 'ssh-host',
      sshHost: 'box',
      serverId: 'server-1',
    });
  });

  it('creates nothing when the machine cannot take the agent', async () => {
    h.set({
      lookup: {
        ...READY,
        target: null,
        blocker: 'This computer’s controller is not running (stopped).',
      },
    });
    const result = await new NewManagedAgentService(h.deps).add(PARAMS);
    expect(result).toEqual({
      kind: 'machine-unavailable',
      message: 'This computer’s controller is not running (stopped).',
    });
    expect(h.calls).toEqual([]);
  });

  it('creates nothing on a machine enrolled for another workspace', async () => {
    h.set({ lookup: { ...READY, target: { ...READY.target!, workspaceId: 'workspace-2' } } });
    const result = await new NewManagedAgentService(h.deps).add(PARAMS);
    expect(result.kind).toBe('machine-unavailable');
    expect(h.calls).toEqual([]);
  });

  it('passes a refusal from the checks through without asking the machine', async () => {
    h.set({ checks: { kind: 'name-conflict' } });
    expect(await new NewManagedAgentService(h.deps).add(PARAMS)).toEqual({
      kind: 'name-conflict',
    });
    expect(h.calls).toEqual([]);
  });

  it('says a name Switch already has is taken, and keeps nothing', async () => {
    h.set({ createOutcome: { kind: 'name-conflict' } });
    expect(await new NewManagedAgentService(h.deps).add(PARAMS)).toEqual({
      kind: 'name-conflict',
    });
    expect(h.calls).toEqual(['create']);
  });

  it('shows a placement refusal in Switch’s words', async () => {
    h.set({
      createOutcome: {
        kind: 'refused',
        message: 'Claude Code is not logged in on laptop.',
      },
    });
    expect(await new NewManagedAgentService(h.deps).add(PARAMS)).toEqual({
      kind: 'error',
      message: 'Claude Code is not logged in on laptop.',
    });
  });

  it('refuses instructions longer than a managed agent takes, before creating anything', async () => {
    const result = await new NewManagedAgentService(h.deps).add({
      ...PARAMS,
      instructions: 'x'.repeat(33 * 1024),
    });
    expect(result.kind).toBe('error');
    expect(h.calls).toEqual([]);
  });

  it('undoes everything, the agent on Switch included, when setting it running fails', async () => {
    h.set({ failAt: 'desired running' });
    await expect(new NewManagedAgentService(h.deps).add(PARAMS)).rejects.toThrow(
      /Could not finish creating pm-agent, so nothing was kept: desired running failed/
    );
    expect(h.calls.slice(-4)).toEqual(['discard row', 'forget record', 'release', 'delete agent']);
    expect(h.records.size).toBe(0);
    expect(h.rows.size).toBe(0);
  });

  it('says Switch still lists the agent when deleting it there fails', async () => {
    h.set({ failAt: 'config', deleteFails: true });
    await expect(new NewManagedAgentService(h.deps).add(PARAMS)).rejects.toThrow(
      /Switch still lists the agent, which could not be deleted/
    );
    expect(h.calls).not.toContain('discard row');
  });

  it('keeps the agent when only showing it in Console fails', async () => {
    h.set({ failAt: 'announce' });
    const result = await new NewManagedAgentService(h.deps).add(PARAMS);
    expect(result.kind).toBe('created');
    expect(h.records.has('agent-new')).toBe(true);
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
