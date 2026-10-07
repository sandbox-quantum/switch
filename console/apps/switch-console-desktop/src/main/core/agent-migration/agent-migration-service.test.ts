import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentMigrationEvent } from '@shared/core/agent-migration/agent-migration';
import {
  type AgentMigrationDeps,
  AgentMigrationService,
  MigrationBlockedError,
  type MigrationAgent,
  type ResolvedTarget,
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
    advanced_config: { effort: 'high' },
    instructions: 'Build things.',
    auto_approve: false,
    directory: '/work/builder',
  },
  desiredState: 'running',
  notCarried: ['The location’s shell setup: managed sessions start without running it first.'],
};

function emptyHandoff(): HandoffResult {
  return { watchers: [] };
}

type World = {
  calls: string[];
  events: AgentMigrationEvent[];
  records: Map<string, ManagedAgentRecord>;
  roomsMidTurn: string[];
  untellable: string[];
  lookup: TargetLookup;
  /** What the machine looks like once `enable` has turned it on; null leaves it as it was. */
  lookupAfterEnable: TargetLookup | null;
  enableFails: boolean;
  eligibility: { management: boolean; owner: string | null; ownedByMe: boolean };
  stoppedByHand: boolean;
  controllerRunning: boolean[];
  failAdoptOn: string | null;
  failStopWatchers: boolean;
  failStartFresh: boolean;
  failDesiredState: boolean;
  releaseOutcome: 'released' | 'already_gone';
  managedView: { controllerId: string | null; desiredState: 'running' | 'stopped' } | null;
  clock: number;
  /** The lookup for one agent; `lookup` for every agent when unset. */
  lookupFor: ((agent: MigrationAgent) => TargetLookup) | null;
};

let world: World;

function deps(): AgentMigrationDeps {
  return {
    agents: {
      get: async (agentId) => (agentId === PARENT.id ? PARENT : null),
      list: async () => [PARENT],
      stoppedByHand: async () => world.stoppedByHand,
    },
    definitions: {
      build: async () => BUILT,
    },
    targets: {
      resolve: async (agent) => (world.lookupFor ? world.lookupFor(agent) : world.lookup),
      enable: async (agent) => {
        world.calls.push(`enable ${agent.sshHost ?? 'this computer'}`);
        if (world.enableFails) throw new Error('ssh: connect to host gpu-1: Connection refused');
        world.lookup = world.lookupAfterEnable ?? world.lookup;
      },
    },
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
      roomsMidTurn: async () => world.roomsMidTurn,
      tellTurnsCut: async (_agent, roomIds) => {
        world.calls.push(`tell ${roomIds.join(',')}`);
        return roomIds
          .filter((roomId) => world.untellable.includes(roomId))
          .map((roomId) => ({ roomId, reason: 'HTTP 403' }));
      },
      stopConsoleWatcher: async (agent) => {
        world.calls.push(`stop console ${agent.name}`);
        if (world.failStopWatchers) throw new Error('watcher did not stop');
      },
      startConsoleWatcher: async (agent) => {
        world.calls.push(`start console ${agent.name}`);
      },
      handoff: async (_agent, request: HandoffRequest) => {
        const ids = request.identities.map((identity) => identity.switchAgentId).join(',');
        world.calls.push(
          request.op === 'start-fresh'
            ? `start-fresh ${request.side} ${ids}`
            : `${request.op} ${ids}`
        );
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
        if (request.op === 'start-fresh' && request.side === 'controller' && world.failStartFresh)
          throw new Error('A watcher of agent switch-1 is still running there');
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
    sleep: async (ms) => {
      world.clock += ms;
    },
    pollMs: 1_000,
    controllerStopWaitMs: 8_000,
    machineReadyWaitMs: 5_000,
    unmanageableRecheckMs: 60_000,
  };
}

beforeEach(() => {
  world = {
    calls: [],
    events: [],
    records: new Map(),
    roomsMidTurn: [],
    untellable: [],
    lookup: {
      display: TARGET.display,
      target: TARGET,
      blocker: null,
      canEnable: false,
      controller: { controllerId: CONTROLLER, state: 'running' },
    },
    lookupAfterEnable: null,
    enableFails: false,
    eligibility: { management: true, owner: 'Ada', ownedByMe: true },
    stoppedByHand: false,
    controllerRunning: [false],
    failAdoptOn: null,
    failStopWatchers: false,
    failStartFresh: false,
    failDesiredState: false,
    releaseOutcome: 'released',
    managedView: { controllerId: CONTROLLER, desiredState: 'running' },
    clock: 0,
    lookupFor: null,
  };
});

describe('moving an agent onto its controller', () => {
  it('places it stopped, stops Console’s watcher, then starts it afresh on the controller', async () => {
    const service = new AgentMigrationService(deps());
    expect(await service.moveToManaged(PARENT.id)).toEqual({ untold: [] });
    expect(world.calls).toEqual([
      'adopt switch-1 stopped on controller-1',
      'record agent-1',
      'stop console builder',
      'stash builder',
      'start-fresh controller switch-1',
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
        ...deps().targets,
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
  });
});

describe('a turn running when the agent moves', () => {
  it('is cut without waiting, after its room is told, while the agent can still post', async () => {
    world.roomsMidTurn = ['room-a', 'room-b'];
    const service = new AgentMigrationService(deps());
    expect(await service.moveToManaged(PARENT.id)).toEqual({ untold: [] });
    expect(world.calls.slice(0, 2)).toEqual([
      'tell room-a,room-b',
      'adopt switch-1 stopped on controller-1',
    ]);
    expect(world.clock).toBe(0);
    expect(world.events.some((event) => event.operation?.stage === 'telling-rooms')).toBe(true);
  });

  it('does not hold the move up when a room cannot be told, and says which', async () => {
    world.roomsMidTurn = ['room-a', 'room-b'];
    world.untellable = ['room-b'];
    const service = new AgentMigrationService(deps());
    expect(await service.moveToManaged(PARENT.id)).toEqual({
      untold: [{ roomId: 'room-b', reason: 'HTTP 403' }],
    });
    expect(world.records.has(PARENT.id)).toBe(true);
  });

  it('tells no room when nothing is running', async () => {
    await new AgentMigrationService(deps()).moveToManaged(PARENT.id);
    expect(world.calls.some((call) => call.startsWith('tell'))).toBe(false);
  });
});

describe('bringing an agent back', () => {
  it('stops managing it, waits for the controller, and starts Console’s watcher afresh', async () => {
    const service = new AgentMigrationService(deps());
    await service.moveToManaged(PARENT.id);
    world.calls = [];
    world.controllerRunning = [true, false];
    await service.stopManaging(PARENT.id);
    expect(world.calls).toEqual([
      'release switch-1',
      'status switch-1',
      'status switch-1',
      'start-fresh console switch-1',
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

describe('a move that fails', () => {
  it('changes nothing when Switch refuses the placement', async () => {
    world.failAdoptOn = 'switch-1';
    await expect(new AgentMigrationService(deps()).moveToManaged(PARENT.id)).rejects.toThrow(
      'controller_offline'
    );
    expect(world.calls).toEqual(['adopt switch-1 stopped on controller-1']);
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
    world.failStartFresh = true;
    await expect(new AgentMigrationService(deps()).moveToManaged(PARENT.id)).rejects.toThrow(
      /still running/
    );
    expect(world.calls).toEqual([
      'adopt switch-1 stopped on controller-1',
      'record agent-1',
      'stop console builder',
      'stash builder',
      'start-fresh controller switch-1',
      'release switch-1',
      'status switch-1',
      'restore builder',
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
      'start-fresh console switch-1',
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

describe('moving every agent automatically', () => {
  const REMOTE: MigrationAgent = {
    ...PARENT,
    id: 'agent-2',
    name: 'trainer',
    switchAgentId: 'switch-2',
    sshHost: 'gpu-1',
    dir: '/srv/trainer',
  };
  const OTHER_SERVER: MigrationAgent = {
    ...PARENT,
    id: 'agent-3',
    name: 'other',
    switchAgentId: 'switch-3',
    serverId: 'server-2',
    workspaceId: 'workspace-2',
    sshHost: 'gpu-1',
    dir: '/srv/other',
  };
  const UNLINKED: MigrationAgent = {
    ...PARENT,
    id: 'agent-4',
    name: 'loose',
    switchAgentId: null,
    workspaceId: null,
    serverId: null,
  };
  let all: MigrationAgent[];
  const service = (overrides: Partial<AgentMigrationDeps> = {}) =>
    new AgentMigrationService({
      ...deps(),
      agents: {
        ...deps().agents,
        get: async (agentId) => all.find((agent) => agent.id === agentId) ?? null,
        list: async () => all,
      },
      ...overrides,
    });
  const adopted = () =>
    world.calls.filter((call) => call.startsWith('adopt')).map((call) => call.split(' ')[1]);

  beforeEach(() => {
    all = [PARENT, REMOTE, OTHER_SERVER, UNLINKED];
    world.lookupFor = (agent) =>
      agent.workspaceId === 'workspace-2'
        ? {
            ...world.lookup,
            target: world.lookup.target && { ...world.lookup.target, workspaceId: 'workspace-2' },
          }
        : world.lookup;
  });

  it('moves every linked agent, on every machine and server, and leaves unlinked ones', async () => {
    const migration = service();
    await migration.migrateEverything();
    expect(adopted()).toEqual(['switch-1', 'switch-2', 'switch-3']);
    expect(migration.migrationProblems()).toEqual([]);
  });

  it('cuts a running turn rather than waiting for it', async () => {
    world.roomsMidTurn = ['room-a'];
    await service().migrateEverything();
    expect(world.calls).toContain('tell room-a');
    expect(adopted()).toHaveLength(3);
  });

  it('does not move an agent twice', async () => {
    const migration = service();
    await migration.migrateEverything();
    world.calls = [];
    await migration.migrateEverything();
    expect(adopted()).toEqual([]);
  });

  it.each([
    ['someone else owns', { management: true, owner: 'Grace', ownedByMe: false }],
    [
      'is on a server without agent management',
      { management: false, owner: null, ownedByMe: false },
    ],
  ])(
    'leaves an agent that %s alone, without reporting it, and asks again later',
    async (_what, eligibility) => {
      world.eligibility = eligibility;
      let asked = 0;
      const base = deps().management;
      const migration = service({
        management: {
          ...base,
          eligibility: async (...args) => {
            asked++;
            return base.eligibility(...args);
          },
        },
      });
      await migration.migrateEverything();
      expect(adopted()).toEqual([]);
      expect(migration.migrationProblems()).toEqual([]);
      expect(asked).toBe(3);
      await migration.migrateEverything();
      expect(asked).toBe(3);
      world.clock += 60_000;
      await migration.migrateEverything();
      expect(asked).toBe(6);
    }
  );

  it('skips an agent when Switch cannot be asked, without reporting it', async () => {
    const migration = service({
      management: {
        ...deps().management,
        eligibility: async () => {
          throw new Error('Dev VM’s Switch stack is not running.');
        },
      },
    });
    await migration.migrateEverything();
    expect(adopted()).toEqual([]);
    expect(migration.migrationProblems()).toEqual([]);
  });

  it('sets up each machine once per server, then moves its agents', async () => {
    const ready = world.lookup;
    world.lookup = { ...ready, target: null, blocker: 'Not a machine yet.', canEnable: true };
    world.lookupAfterEnable = ready;
    await service().migrateEverything();
    expect(world.calls.filter((call) => call.startsWith('enable'))).toEqual([
      'enable this computer',
    ]);
    expect(adopted()).toHaveLength(3);
  });

  it('reports the agents of a machine that cannot be set up, and clears them once they move', async () => {
    world.lookup = {
      ...world.lookup,
      target: null,
      blocker: 'Not a machine yet.',
      canEnable: true,
    };
    const ready = { ...world.lookup, target: TARGET, blocker: null, canEnable: false };
    world.enableFails = true;
    const migration = service();
    await migration.migrateEverything();
    expect(migration.migrationProblems()).toEqual([
      {
        agentId: PARENT.id,
        name: 'builder',
        machine: 'this computer',
        message: expect.stringMatching(
          /^this computer could not be set up to run managed agents: ssh/
        ),
      },
      expect.objectContaining({ name: 'trainer', machine: 'gpu-1' }),
      expect.objectContaining({ name: 'other', machine: 'gpu-1' }),
    ]);
    world.enableFails = false;
    world.lookupAfterEnable = ready;
    await migration.migrateEverything();
    expect(migration.migrationProblems()).toEqual([]);
  });

  it('reports a move that fails, and keeps moving the rest', async () => {
    world.failAdoptOn = 'switch-2';
    const migration = service();
    await migration.migrateEverything();
    expect(migration.migrationProblems()).toEqual([
      expect.objectContaining({ name: 'trainer', message: 'controller_offline' }),
    ]);
    expect(adopted()).toEqual(['switch-1', 'switch-2', 'switch-3']);
  });

  it('runs one pass at a time', async () => {
    const migration = service();
    await Promise.all([migration.migrateEverything(), migration.migrateEverything()]);
    expect(adopted()).toEqual(['switch-1', 'switch-2', 'switch-3']);
  });
});
