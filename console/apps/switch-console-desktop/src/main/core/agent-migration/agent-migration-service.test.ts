import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentMigrationEvent } from '@shared/core/agent-migration/agent-migration';
import {
  type AgentMigrationDeps,
  AgentMigrationService,
  MigrationBlockedError,
  MigrationCancelledError,
  type MigrationAgent,
  type ResolvedTarget,
  type SubagentRef,
  type TargetLookup,
} from './agent-migration-service';
import type { ManagedAgentRecord } from './managed-agents-store';
import type { BuiltDefinition } from './managed-definition';
import type { HandoffRequest, HandoffResult } from './session-handoff';

const WORKSPACE = 'workspace-1';
const CONTROLLER = 'controller-1';

const PARENT: MigrationAgent = {
  id: 'agent-1',
  name: 'builder',
  providerId: 'claude',
  switchAgentId: 'switch-1',
  workspaceId: WORKSPACE,
  serverId: 'server-1',
  dir: '/work/builder',
  sshHost: null,
};

const SUBAGENT_ROW: MigrationAgent = {
  ...PARENT,
  id: 'agent-2',
  name: 'reviewer',
  switchAgentId: 'switch-2',
};

const TARGET: ResolvedTarget = {
  display: { kind: 'this-computer', serverId: 'server-1', machineName: 'build-box' },
  controllerId: CONTROLLER,
  workspaceId: WORKSPACE,
  watcherRoot: (id) => `/data/watchers/${id}`,
};

const BUILT: BuiltDefinition = {
  definition: {
    provider: 'claude',
    model: 'sonnet',
    instructions: 'Build things.',
    auto_session: true,
    auto_approve: false,
    directory: '/work/builder',
  },
  desiredState: 'running',
  notCarried: [
    'The reasoning effort “high”: the managed agent runs at the provider’s default effort.',
  ],
};

function emptyHandoff(): HandoffResult {
  return { watchers: [], cleared: [], resumed: [] };
}

type World = {
  calls: string[];
  events: AgentMigrationEvent[];
  records: Map<string, ManagedAgentRecord>;
  subagents: SubagentRef[];
  busy: boolean[];
  lookup: TargetLookup;
  eligibility: { management: boolean; owner: string | null; ownedByMe: boolean };
  stoppedByHand: boolean;
  controllerRunning: boolean[];
  failAdoptOn: string | null;
  failStopWatchers: boolean;
  failFreshStart: boolean;
  failDesiredState: boolean;
  releaseOutcome: 'released' | 'already_gone';
  managedView: { controllerId: string | null; desiredState: 'running' | 'stopped' } | null;
  clock: number;
};

let world: World;

function deps(): AgentMigrationDeps {
  return {
    agents: {
      get: async (agentId) => [PARENT, SUBAGENT_ROW].find((agent) => agent.id === agentId) ?? null,
      list: async () => [PARENT],
      subagentsOf: async (agent) => (agent.id === PARENT.id ? world.subagents : []),
      parentOf: async (agent) =>
        agent.id === SUBAGENT_ROW.id && world.subagents.length ? PARENT : null,
      stoppedByHand: async () => world.stoppedByHand,
    },
    definitions: {
      build: async (_agent, subagent) =>
        subagent
          ? { ...BUILT, notCarried: ['Its definition file settings other than its prompt.'] }
          : BUILT,
    },
    targets: { resolve: async () => world.lookup },
    management: {
      eligibility: async () => world.eligibility,
      adopt: async (workspaceId, switchAgentId, body) => {
        world.calls.push(`adopt ${switchAgentId} ${body.desired_state} on ${body.controller_id}`);
        if (world.failAdoptOn === switchAgentId) throw new Error('controller_offline');
      },
      setDesiredState: async (_workspaceId, switchAgentId, desiredState) => {
        world.calls.push(`desired ${switchAgentId} ${desiredState}`);
        if (world.failDesiredState) throw new Error('provider_not_installed');
      },
      release: async (_workspaceId, switchAgentId) => {
        world.calls.push(`release ${switchAgentId}`);
        return world.releaseOutcome;
      },
      read: async () =>
        world.managedView
          ? {
              ...world.managedView,
              actual: { process: 'running', attached: true, reason: null, detail: null },
            }
          : null,
    },
    machine: {
      sessions: async (_agent, ids) => {
        const busy = world.busy.length > 1 ? world.busy.shift()! : (world.busy[0] ?? false);
        return [{ sessionId: 'session-a', switchAgentId: ids[0]!, busy }];
      },
      stopConsoleWatchers: async (agent, subagents) => {
        world.calls.push(
          `stop console ${[agent.name, ...subagents.map((subagent) => subagent.name)].join(',')}`
        );
        if (world.failStopWatchers) throw new Error('watcher did not stop');
      },
      startConsoleWatchers: async (agent, subagents) => {
        world.calls.push(
          `start console ${[agent.name, ...subagents.map((subagent) => subagent.name)].join(',')}`
        );
      },
      handoff: async (_agent, request: HandoffRequest) => {
        const ids = request.identities.map((identity) => identity.switchAgentId).join(',');
        world.calls.push(`${request.op} ${ids}`);
        if (request.op === 'status') {
          const running =
            world.controllerRunning.length > 1
              ? world.controllerRunning.shift()!
              : (world.controllerRunning[0] ?? false);
          return {
            ...emptyHandoff(),
            watchers: request.identities.map((identity) => ({
              switchAgentId: identity.switchAgentId,
              console: false,
              controller: running,
            })),
          };
        }
        if (request.op === 'fresh-start' && world.failFreshStart)
          throw new Error('The controller is already running agent switch-1');
        return emptyHandoff();
      },
    },
    credentials: {
      stash: async (_agent, identity) => {
        world.calls.push(`stash ${identity.slug}`);
        return true;
      },
      restore: async (_agent, identity) => {
        world.calls.push(`restore ${identity.slug}`);
      },
    },
    store: {
      list: async () => [...world.records.values()],
      get: async (agentId) => world.records.get(agentId) ?? null,
      forIdentity: async (agentId, switchAgentId) =>
        world.records.get(agentId) ??
        [...world.records.values()].find((record) =>
          record.identities.some((identity) => identity.switchAgentId === switchAgentId)
        ) ??
        null,
      set: async (record) => {
        if (!world.records.has(record.agentId)) world.calls.push(`record ${record.agentId}`);
        world.records.set(record.agentId, structuredClone(record));
      },
      delete: async (agentId) => {
        world.calls.push(`forget ${agentId}`);
        world.records.delete(agentId);
      },
    },
    emit: (event) => world.events.push(event),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => world.clock,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new Error('aborted');
      world.clock += ms;
    },
    pollMs: 1_000,
    turnWaitMs: 10_000,
    controllerStopWaitMs: 8_000,
  };
}

beforeEach(() => {
  world = {
    calls: [],
    events: [],
    records: new Map(),
    subagents: [],
    busy: [false],
    lookup: {
      display: TARGET.display,
      target: TARGET,
      blocker: null,
      canEnable: false,
      controller: { controllerId: CONTROLLER, state: 'running' },
    },
    eligibility: { management: true, owner: 'Ada', ownedByMe: true },
    stoppedByHand: false,
    controllerRunning: [false],
    failAdoptOn: null,
    failStopWatchers: false,
    failFreshStart: false,
    failDesiredState: false,
    releaseOutcome: 'released',
    managedView: { controllerId: CONTROLLER, desiredState: 'running' },
    clock: 0,
  };
});

describe('moving an agent onto its controller', () => {
  it('places it stopped, stops Console’s watcher, hands over, then starts it on the controller', async () => {
    const service = new AgentMigrationService(deps());
    await service.moveToManaged(PARENT.id);
    expect(world.calls).toEqual([
      'adopt switch-1 stopped on controller-1',
      'record agent-1',
      'stop console builder',
      'fresh-start switch-1',
      'stash builder',
      'desired switch-1 running',
    ]);
    const record = world.records.get(PARENT.id)!;
    expect(record.controllerId).toBe(CONTROLLER);
    expect(record.identities).toEqual([
      {
        switchAgentId: 'switch-1',
        slug: 'builder',
        subagent: null,
        credentialsStashed: true,
        controllerRoot: '/data/watchers/switch-1',
      },
    ]);
    expect(world.events.at(-1)).toEqual({ agentId: PARENT.id, runner: 'managed', operation: null });
  });

  it('reports the agent as managed afterwards, with what its controller says', async () => {
    const service = new AgentMigrationService(deps());
    await service.moveToManaged(PARENT.id);
    const state = await service.state(PARENT.id);
    expect(state.runner).toBe('managed');
    expect(state.managed).toMatchObject({
      controllerId: CONTROLLER,
      desiredState: 'running',
      actual: { process: 'running', attached: true },
      machine: { kind: 'running' },
      unreadable: null,
    });
  });

  it('reports the machine as not running it once Console finds its controller stopped', async () => {
    const service = new AgentMigrationService(deps());
    await service.moveToManaged(PARENT.id);
    world.lookup = {
      display: TARGET.display,
      target: null,
      blocker: 'build-box’s controller is not running. Start it again from the host’s page.',
      canEnable: false,
      controller: { controllerId: CONTROLLER, state: 'stopped' },
    };
    expect((await service.state(PARENT.id)).managed?.machine).toEqual({
      kind: 'stopped',
      reason: 'build-box’s controller is not running. Start it again from the host’s page.',
    });
  });

  it.each([
    ['Switch removed its controller', { controllerId: CONTROLLER, state: 'removed' as const }],
    ['the machine no longer has a controller', null],
    [
      'the machine has another controller now',
      { controllerId: 'controller-2', state: 'running' as const },
    ],
  ])('reports the machine as removed when %s', async (_what, controller) => {
    const service = new AgentMigrationService(deps());
    await service.moveToManaged(PARENT.id);
    world.lookup = {
      display: TARGET.display,
      target: null,
      blocker: 'Turn on “Run managed agents on this computer” for this server first.',
      canEnable: controller === null,
      controller,
    };
    const state = await service.state(PARENT.id);
    expect(state.managed?.machine).toEqual({ kind: 'removed' });
    expect(state.runner).toBe('managed');
    expect(state.blocker).toBeNull();
  });

  it('says Console cannot tell when the machine cannot be looked at', async () => {
    const service = new AgentMigrationService({
      ...deps(),
      targets: {
        resolve: async () => {
          throw new Error('ssh: connect to host build-box port 22: Connection refused');
        },
      },
    });
    world.records.set(PARENT.id, {
      agentId: PARENT.id,
      workspaceId: WORKSPACE,
      controllerId: CONTROLLER,
      placement: { kind: 'this-computer', serverId: 'server-1' },
      movedAt: '2026-10-03T00:00:00Z',
      identities: [
        {
          switchAgentId: 'switch-1',
          slug: 'builder',
          subagent: null,
          credentialsStashed: true,
          controllerRoot: '/data/watchers/switch-1',
        },
      ],
    });
    expect((await service.state(PARENT.id)).managed?.machine).toEqual({
      kind: 'unknown',
      reason:
        'Console could not look at the machine: ssh: connect to host build-box port 22: Connection refused',
    });
  });

  it('keeps an agent stopped by hand stopped on its controller', async () => {
    world.stoppedByHand = true;
    await new AgentMigrationService(deps()).moveToManaged(PARENT.id);
    expect(world.calls).not.toContain('desired switch-1 running');
    expect(world.records.has(PARENT.id)).toBe(true);
  });

  it('says what the managed definition does not carry before the move', async () => {
    const state = await new AgentMigrationService(deps()).state(PARENT.id);
    expect(state).toMatchObject({ runner: 'console', blocker: null, notCarried: BUILT.notCarried });
  });
});

describe('moving an agent on an SSH host', () => {
  it('places it on the host’s controller, with the watcher root in the host’s home', async () => {
    const remote: MigrationAgent = { ...PARENT, sshHost: 'gpu-1', dir: '/srv/builder' };
    const display = {
      kind: 'ssh-host' as const,
      sshHost: 'gpu-1',
      serverId: 'server-1',
      machineName: 'gpu-1.internal',
    };
    world.lookup = {
      display,
      target: {
        display,
        controllerId: 'controller-ssh',
        workspaceId: WORKSPACE,
        watcherRoot: (id) =>
          `~/.local/state/switch/agent-controller/console-server-1/watchers/${id}`,
      },
      blocker: null,
      canEnable: false,
      controller: { controllerId: 'controller-ssh', state: 'running' },
    };
    const service = new AgentMigrationService({
      ...deps(),
      agents: { ...deps().agents, get: async () => remote },
    });
    await service.moveToManaged(PARENT.id);
    expect(world.calls[0]).toBe('adopt switch-1 stopped on controller-ssh');
    expect(world.records.get(PARENT.id)).toMatchObject({
      placement: { kind: 'ssh-host', sshHost: 'gpu-1', serverId: 'server-1' },
      identities: [
        {
          controllerRoot:
            '~/.local/state/switch/agent-controller/console-server-1/watchers/switch-1',
        },
      ],
    });
    expect(await service.movedOnto({ kind: 'ssh-host', sshHost: 'gpu-1' })).toEqual(['builder']);
  });
});

describe('waiting for the agent to be idle', () => {
  it('waits for a running turn to end before changing anything', async () => {
    world.busy = [true, true, false];
    const service = new AgentMigrationService(deps());
    await service.moveToManaged(PARENT.id);
    const waiting = world.events.filter((event) => event.operation?.stage === 'waiting-for-turn');
    expect(waiting.length).toBe(2);
    expect(waiting[0]!.operation!.busySessions).toEqual(['session-a']);
    expect(world.calls[0]).toBe('adopt switch-1 stopped on controller-1');
  });

  it('gives up with nothing changed when the turn does not end in time', async () => {
    world.busy = [true];
    const service = new AgentMigrationService(deps());
    await expect(service.moveToManaged(PARENT.id)).rejects.toBeInstanceOf(MigrationBlockedError);
    expect(world.calls).toEqual([]);
    expect(world.records.size).toBe(0);
  });

  it('can be cancelled while it waits, with nothing changed', async () => {
    world.busy = [true];
    const service = new AgentMigrationService({
      ...deps(),
      sleep: async (_ms, signal) => {
        service.cancel(PARENT.id);
        if (signal?.aborted) throw new Error('aborted');
      },
    });
    await expect(service.moveToManaged(PARENT.id)).rejects.toBeInstanceOf(MigrationCancelledError);
    expect(world.calls).toEqual([]);
  });

  it('waits for the controller’s sessions too before bringing an agent back', async () => {
    const service = new AgentMigrationService(deps());
    await service.moveToManaged(PARENT.id);
    world.calls = [];
    world.busy = [true, false];
    await service.stopManaging(PARENT.id);
    expect(world.calls[0]).toBe('release switch-1');
    expect(world.clock).toBeGreaterThan(0);
  });
});

describe('bringing an agent back', () => {
  it('stops managing it, waits for the controller, hands back and starts Console’s watcher', async () => {
    const service = new AgentMigrationService(deps());
    await service.moveToManaged(PARENT.id);
    world.calls = [];
    world.controllerRunning = [true, false];
    await service.stopManaging(PARENT.id);
    expect(world.calls).toEqual([
      'release switch-1',
      'status switch-1',
      'status switch-1',
      'come-back switch-1',
      'restore builder',
      'forget agent-1',
      'start console builder',
    ]);
    expect(world.records.size).toBe(0);
    expect((await service.state(PARENT.id)).runner).toBe('console');
  });

  it('turns the controller’s watcher off itself when the controller does not', async () => {
    const service = new AgentMigrationService(deps());
    await service.moveToManaged(PARENT.id);
    world.calls = [];
    world.controllerRunning = [true, true, true, false];
    await service.stopManaging(PARENT.id);
    expect(world.calls).toContain('turn-off switch-1');
    expect(world.calls.at(-1)).toBe('start console builder');
  });

  it('keeps the record, to be tried again, when the controller never lets go', async () => {
    const service = new AgentMigrationService(deps());
    await service.moveToManaged(PARENT.id);
    world.controllerRunning = [true];
    await expect(service.stopManaging(PARENT.id)).rejects.toThrow(/has not stopped/);
    expect(world.records.has(PARENT.id)).toBe(true);
    world.controllerRunning = [false];
    world.releaseOutcome = 'already_gone';
    world.calls = [];
    await service.stopManaging(PARENT.id);
    expect(world.calls).toContain('start console builder');
    expect(world.records.size).toBe(0);
  });

  it('refuses an agent that is not managed', async () => {
    await expect(new AgentMigrationService(deps()).stopManaging(PARENT.id)).rejects.toBeInstanceOf(
      MigrationBlockedError
    );
  });
});

describe('subagents watched under the agent', () => {
  beforeEach(() => {
    world.subagents = [{ name: 'reviewer', switchAgentId: 'switch-2' }];
  });

  it('move with their parent, and come back with it', async () => {
    const service = new AgentMigrationService(deps());
    await service.moveToManaged(PARENT.id);
    expect(world.calls).toEqual([
      'adopt switch-1 stopped on controller-1',
      'adopt switch-2 stopped on controller-1',
      'record agent-1',
      'stop console builder,reviewer',
      'fresh-start switch-1,switch-2',
      'stash builder',
      'stash reviewer',
      'desired switch-1 running',
      'desired switch-2 running',
    ]);
    expect(world.records.get(PARENT.id)!.identities.map((identity) => identity.subagent)).toEqual([
      null,
      'reviewer',
    ]);
    world.calls = [];
    await service.stopManaging(PARENT.id);
    expect(world.calls).toEqual([
      'release switch-1',
      'release switch-2',
      'status switch-1,switch-2',
      'come-back switch-1,switch-2',
      'restore builder',
      'restore reviewer',
      'forget agent-1',
      'start console builder,reviewer',
    ]);
  });

  it('cannot move on their own, before or after their parent moves', async () => {
    const service = new AgentMigrationService(deps());
    expect(await service.state(SUBAGENT_ROW.id)).toMatchObject({
      runner: 'console',
      movesWithParent: 'builder',
    });
    await expect(service.moveToManaged(SUBAGENT_ROW.id)).rejects.toBeInstanceOf(
      MigrationBlockedError
    );
    await service.moveToManaged(PARENT.id);
    expect(await service.state(SUBAGENT_ROW.id)).toMatchObject({
      runner: 'managed',
      movesWithParent: 'builder',
    });
    await expect(service.stopManaging(SUBAGENT_ROW.id)).rejects.toThrow(/parent/);
  });
});

describe('a move that fails', () => {
  it('changes nothing when Switch refuses the placement', async () => {
    world.subagents = [{ name: 'reviewer', switchAgentId: 'switch-2' }];
    world.failAdoptOn = 'switch-2';
    await expect(new AgentMigrationService(deps()).moveToManaged(PARENT.id)).rejects.toThrow(
      'controller_offline'
    );
    expect(world.calls).toEqual([
      'adopt switch-1 stopped on controller-1',
      'adopt switch-2 stopped on controller-1',
      'release switch-1',
    ]);
    expect(world.records.size).toBe(0);
  });

  it('undoes the placement when Console’s watcher cannot be stopped', async () => {
    world.failStopWatchers = true;
    await expect(new AgentMigrationService(deps()).moveToManaged(PARENT.id)).rejects.toThrow(
      /stays with this Console/
    );
    expect(world.calls).toEqual([
      'adopt switch-1 stopped on controller-1',
      'record agent-1',
      'stop console builder',
      'release switch-1',
      'forget agent-1',
      'start console builder',
    ]);
    expect(world.records.size).toBe(0);
  });

  it('undoes everything when the machine cannot be prepared, keeping Console’s stream position', async () => {
    world.failFreshStart = true;
    await expect(new AgentMigrationService(deps()).moveToManaged(PARENT.id)).rejects.toThrow(
      /already running/
    );
    expect(world.calls).toEqual([
      'adopt switch-1 stopped on controller-1',
      'record agent-1',
      'stop console builder',
      'fresh-start switch-1',
      'release switch-1',
      'status switch-1',
      'forget agent-1',
      'start console builder',
    ]);
  });

  it('puts the credentials back when the controller cannot start it', async () => {
    world.failDesiredState = true;
    await expect(new AgentMigrationService(deps()).moveToManaged(PARENT.id)).rejects.toThrow(
      'provider_not_installed'
    );
    expect(world.calls.slice(-6)).toEqual([
      'release switch-1',
      'status switch-1',
      'come-back switch-1',
      'restore builder',
      'forget agent-1',
      'start console builder',
    ]);
    expect(world.records.size).toBe(0);
  });
});

describe('what keeps an agent from moving', () => {
  it.each([
    [
      'its owner is someone else',
      () => (world.eligibility = { management: true, owner: 'Grace', ownedByMe: false }),
      /Only its owner \(Grace\)/,
    ],
    [
      'the server has no agent management',
      () => (world.eligibility = { management: false, owner: null, ownedByMe: false }),
      /agent management turned on/,
    ],
    [
      'the machine cannot take it',
      () =>
        (world.lookup = {
          display: TARGET.display,
          target: null,
          blocker: 'Turn on “Run managed agents on this computer” first.',
          canEnable: true,
          controller: null,
        }),
      /Turn on/,
    ],
    [
      'the machine belongs to another workspace',
      () =>
        (world.lookup = {
          display: TARGET.display,
          target: { ...TARGET, workspaceId: 'workspace-2' },
          blocker: null,
          canEnable: false,
          controller: { controllerId: CONTROLLER, state: 'running' },
        }),
      /another workspace/,
    ],
  ])('refuses when %s, with nothing changed', async (_what, arrange, reason) => {
    arrange();
    const service = new AgentMigrationService(deps());
    expect((await service.state(PARENT.id)).blocker).toMatch(reason);
    await expect(service.moveToManaged(PARENT.id)).rejects.toBeInstanceOf(MigrationBlockedError);
    expect(world.calls).toEqual([]);
  });

  it('offers to turn the machine on when that is what is missing', async () => {
    world.lookup = {
      display: TARGET.display,
      target: null,
      blocker: 'Turn it on.',
      canEnable: true,
      controller: null,
    };
    expect((await new AgentMigrationService(deps()).state(PARENT.id)).canEnableTarget).toBe(true);
  });

  it('refuses an agent not linked to Switch', async () => {
    const service = new AgentMigrationService({
      ...deps(),
      agents: { ...deps().agents, get: async () => ({ ...PARENT, switchAgentId: null }) },
    });
    expect((await service.state(PARENT.id)).blocker).toMatch(/Link the agent/);
  });
});

describe('moving every agent on a machine', () => {
  it('moves the ones that can, and says why the others did not', async () => {
    const service = new AgentMigrationService(deps());
    const moved = await service.moveAll({ kind: 'this-computer', serverId: 'server-1' });
    expect(moved).toEqual({
      moved: [{ agentId: PARENT.id, name: 'builder' }],
      skipped: [],
      failed: [],
    });
    expect(await service.movedOnto({ kind: 'this-computer', serverId: 'server-1' })).toEqual([
      'builder',
    ]);
    const back = await service.stopManagingAll({ kind: 'this-computer', serverId: 'server-1' });
    expect(back.moved).toEqual([{ agentId: PARENT.id, name: 'builder' }]);
  });

  it('skips an agent that cannot move', async () => {
    world.eligibility = { management: true, owner: 'Grace', ownedByMe: false };
    const result = await new AgentMigrationService(deps()).moveAll({
      kind: 'this-computer',
      serverId: 'server-1',
    });
    expect(result.moved).toEqual([]);
    expect(result.skipped[0]).toMatchObject({
      name: 'builder',
      reason: expect.stringMatching(/owner/),
    });
  });
});
