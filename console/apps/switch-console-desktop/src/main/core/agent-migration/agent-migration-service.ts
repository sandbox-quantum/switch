import type {
  AgentMigrationEvent,
  AgentMigrationState,
  AgentRunner,
  ManagedActual,
  ManagedMachine,
  MigrationControllerState,
  MigrationMachine,
  MigrationOverview,
  MigrationProblem,
  MigrationOperation,
  MigrationStage,
  MigrationTarget,
  MoveToManagedResult,
} from '@shared/core/agent-migration/agent-migration';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { ManagedAgentRecord, MovedIdentity } from './managed-agents-store';
import type { BuiltDefinition, ManagedDefinition } from './managed-definition';
import type { HandoffIdentity, HandoffRequest, HandoffResult } from './session-handoff';

/** A Console agent, as far as moving it is concerned. */
export type MigrationAgent = {
  id: string;
  name: string;
  providerId: AgentProviderId;
  switchAgentId: string | null;
  workspaceId: string | null;
  serverId: string | null;
  /** The working directory, absolute on the agent's machine. */
  dir: string;
  /** The SSH host it runs on, or null for this computer. */
  sshHost: string | null;
};

/** The controller an agent moves onto, resolved for it. */
export type ResolvedTarget = {
  display: MigrationTarget;
  controllerId: string;
  /** The workspace the controller belongs to; an agent of another cannot be placed on it. */
  workspaceId: string;
  /** Where the controller keeps an agent's watcher state, on the agent's machine. */
  watcherRoot: (switchAgentId: string) => string;
};

export type TargetLookup = {
  display: MigrationTarget | null;
  /** Null when the machine cannot take agents now; `blocker` says why. */
  target: ResolvedTarget | null;
  blocker: string | null;
  /** The machine is not running managed agents, and Console can turn it on. */
  canEnable: boolean;
  /** The controller enrolled on the machine now, as Console last probed it; null when none is. */
  controller: { controllerId: string; state: 'running' | 'stopped' | 'unknown' | 'removed' } | null;
};

export type ManagedView = {
  controllerId: string | null;
  desiredState: 'running' | 'stopped';
  actual: ManagedActual | null;
};

/** What repairing a machine's controller found, or did. */
export type MachineHealth =
  | { kind: 'not-set-up' }
  /** It runs a usable controller, as it did. */
  | { kind: 'unchanged' }
  /** It was enrolled again or restarted: the controller takes a moment to reach Switch. */
  | { kind: 'changed' }
  | { kind: 'incompatible'; reason: string };

/** Switch's agent management, through the signed-in session of the agent's workspace. */
export interface MigrationManagementPort {
  /** Whether the server runs agent management, and whether the signed-in user owns the agent. */
  eligibility(
    workspaceId: string,
    switchAgentId: string
  ): Promise<{ management: boolean; owner: string | null; ownedByMe: boolean }>;
  /** `PUT /gateway/management/agents/{id}`: places the agent on the controller. */
  adopt(
    workspaceId: string,
    switchAgentId: string,
    body: {
      controller_id: string;
      desired_state: 'running' | 'stopped';
      definition: ManagedDefinition;
    }
  ): Promise<void>;
  /** `PATCH …/agents/{id}` with only `desired_state`. */
  setDesiredState(
    workspaceId: string,
    switchAgentId: string,
    desiredState: 'running' | 'stopped'
  ): Promise<void>;
  /** `PATCH …/agents/{id}` with only `controller_id`: places the agent on another controller. */
  place(workspaceId: string, switchAgentId: string, controllerId: string): Promise<void>;
  /** `DELETE …/agents/{id}`: stops managing it. `already_gone` when it was not managed. */
  release(workspaceId: string, switchAgentId: string): Promise<'released' | 'already_gone'>;
  /** The managed agent as the server reports it, or null when it is not managed. */
  read(workspaceId: string, switchAgentId: string): Promise<ManagedView | null>;
}

/** The agent's machine: this computer, or its SSH host. */
export interface MigrationMachinePort {
  /** The rooms where one of the agent's sessions is mid-turn now. */
  roomsMidTurn(agent: MigrationAgent): Promise<string[]>;
  /**
   * Says in each room, as the agent, that the move cut its turn off. Resolves
   * with the rooms it could not tell, and why; a move goes on regardless.
   */
  tellTurnsCut(
    agent: MigrationAgent,
    roomIds: string[]
  ): Promise<{ roomId: string; reason: string }[]>;
  /** Stops Console's watcher for the agent, and every session it runs. */
  stopConsoleWatcher(agent: MigrationAgent): Promise<void>;
  /**
   * Stops Console's watchers for several agents on one machine at once. Per
   * agent, null once its watcher is down, or why it is not.
   */
  stopConsoleWatchers(agents: MigrationAgent[]): Promise<Map<string, string | null>>;
  /** Puts Console's watcher for the agent back as its settings say. */
  startConsoleWatcher(agent: MigrationAgent): Promise<void>;
  handoff(agent: MigrationAgent, request: HandoffRequest): Promise<HandoffResult>;
}

/** The agent's credentials file in its working directory, kept aside while it is managed. */
export interface MigrationCredentialsPort {
  /** Keeps the file's token in the encrypted secrets store and removes the file. False when there was none. */
  stash(agent: MigrationAgent, identity: { slug: string; switchAgentId: string }): Promise<boolean>;
  /** `stash` for several agents on one machine at once: per agent, the outcome or the error. */
  stashMany(
    items: { agent: MigrationAgent; identity: { slug: string; switchAgentId: string } }[]
  ): Promise<Map<string, boolean | Error>>;
  /** Writes the file back, from the kept token or, failing that, from Switch; then forgets the kept one. */
  restore(agent: MigrationAgent, identity: { slug: string; switchAgentId: string }): Promise<void>;
}

export interface MigrationStorePort {
  list(): Promise<ManagedAgentRecord[]>;
  get(agentId: string): Promise<ManagedAgentRecord | null>;
  forIdentity(agentId: string, switchAgentId: string | null): Promise<ManagedAgentRecord | null>;
  set(record: ManagedAgentRecord): Promise<void>;
  delete(agentId: string): Promise<void>;
}

export type MigrationLog = {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
};

export type AgentMigrationDeps = {
  agents: {
    get(agentId: string): Promise<MigrationAgent | null>;
    list(): Promise<MigrationAgent[]>;
    /** Somebody stopped this agent's watcher by hand. */
    stoppedByHand(agentId: string): Promise<boolean>;
  };
  definitions: {
    build(agent: MigrationAgent): Promise<BuiltDefinition>;
  };
  targets: {
    resolve(agent: MigrationAgent): Promise<TargetLookup>;
    /**
     * Turns the agent's machine on to run managed agents (this computer's
     * controller, or an SSH host's), as its own toggle does.
     */
    enable(agent: MigrationAgent): Promise<void>;
    /**
     * Repairs the controller the agent's machine runs for its server: enrolls
     * the machine again when Switch revoked or forgot it, and restarts it when
     * it is stopped or runs an older build than this Console. `not-set-up`
     * when the machine runs none; `incompatible` when the server cannot take
     * this Console's controller at all.
     */
    heal(agent: MigrationAgent): Promise<MachineHealth>;
  };
  management: MigrationManagementPort;
  machine: MigrationMachinePort;
  credentials: MigrationCredentialsPort;
  store: MigrationStorePort;
  emit: (event: AgentMigrationEvent) => void;
  log: MigrationLog;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** How often a return looks at the agent's watchers again. */
  pollMs: number;
  /** How long a return waits for the controller to stop the agent. */
  controllerStopWaitMs: number;
  /** How long a pass waits for a machine it set up to take agents. */
  machineReadyWaitMs: number;
  /** How long an agent found someone else's, or on a server without agent management, is not asked about again. */
  unmanageableRecheckMs: number;
  /** The first delay before a failed agent or machine is tried again; it doubles from there. */
  minRetryMs: number;
  /** The longest delay before a failed agent or machine is tried again. */
  maxRetryMs: number;
  /** How often a machine whose agents have all moved is checked for a controller to repair. */
  healIntervalMs: number;
};

/** A move refused before anything changed, for a reason a person can act on. */
export class MigrationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationBlockedError';
  }
}

type Moving = {
  agent: MigrationAgent;
  target: ResolvedTarget;
  identity: MovedIdentity;
  definition: BuiltDefinition;
  stoppedByHand: boolean;
};

/** The machine and server an agent moves onto a controller of. */
function groupKey(agent: MigrationAgent): string {
  return JSON.stringify([agent.sshHost ?? '', agent.serverId ?? '']);
}

/**
 * Agents grouped by the controller they move onto: one per machine and server,
 * this computer first, then each SSH host by name.
 */
function groupByController(agents: MigrationAgent[]): MigrationAgent[][] {
  const groups = new Map<string, MigrationAgent[]>();
  for (const agent of agents) {
    const key = groupKey(agent);
    groups.set(key, [...(groups.get(key) ?? []), agent]);
  }
  const order = (agent: MigrationAgent) => [agent.sshHost ?? '', agent.serverId ?? ''] as const;
  return [...groups.values()].sort((a, b) => {
    const [hostA, serverA] = order(a[0]!);
    const [hostB, serverB] = order(b[0]!);
    return hostA === hostB ? serverA.localeCompare(serverB) : hostA.localeCompare(hostB);
  });
}

/**
 * Whether the machine can run a moved agent now, as the lookup found its
 * controller. A machine with no controller, or with another one than the
 * agent was placed on, lost the agent's controller to a removal.
 */
function machineOf(lookup: TargetLookup, record: ManagedAgentRecord): ManagedMachine {
  const controller = lookup.controller;
  if (!controller || controller.controllerId !== record.controllerId) return { kind: 'removed' };
  const reason = lookup.blocker ?? 'The machine’s controller is not running.';
  switch (controller.state) {
    case 'running':
      return { kind: 'running' };
    case 'removed':
      return { kind: 'removed' };
    case 'unknown':
      return { kind: 'unknown', reason };
    case 'stopped':
      return { kind: 'stopped', reason };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Moves a Console agent onto an agents controller ("Move to managed") and
 * back ("Stop managing"), one agent at a time.
 *
 * A move goes straight ahead, in order:
 * 1. Checks it can run. Nothing has changed if it stops here.
 * 2. Tells each room where one of its sessions is mid-turn that the turn is
 *    cut, while the agent's own key still works.
 * 3. Places the agent on the controller, stopped (`PUT`). Switch now refuses
 *    the agent's own key and closes its connection. Refused: nothing changed.
 * 4. Records it as managed, so nothing in Console starts its watcher again,
 *    and stops Console's watcher and its sessions, cutting any turn. Failing:
 *    the placement is undone and Console's watcher put back.
 * 5. Keeps its credentials file aside, clears what an earlier stay left on
 *    the controller, and sets it running there. Failing: all of the above is
 *    undone.
 *
 * Conversations do not move: the controller starts each room afresh on its
 * next message.
 *
 * A return reverses it: stop managing (`DELETE`), wait for the controller to
 * stop it, start Console's watcher afresh at the stream's head (so it is not
 * sent again what the controller answered), restore its credentials file, and
 * start Console's watcher. Once Switch has let the agent go there is nothing
 * to undo to, so a return that fails after that keeps the record and can be
 * run again; a `DELETE` that finds it already gone carries on.
 */
export class AgentMigrationService {
  private readonly operations = new Map<string, MigrationOperation>();
  private readonly problems = new Map<string, MigrationProblem>();
  /** Agents found someone else's, or on a server without agent management, until when. */
  private readonly unmanageableUntil = new Map<string, number>();
  private migrating: Promise<void> | null = null;
  /** The agents of each machine and server, as the last pass grouped them. */
  private groups: MigrationAgent[][] = [];
  private readonly controllers = new Map<
    string,
    { state: MigrationControllerState; checkedAt: string }
  >();
  private readonly leftAlone = new Set<string>();
  private readonly unasked = new Set<string>();
  private lastPassAt: string | null = null;
  /** When an agent, or a machine and server, is tried again, and the delay that set it. */
  private readonly retryAt = new Map<string, { at: number; delay: number }>();

  constructor(private readonly deps: AgentMigrationDeps) {}

  async state(agentId: string): Promise<AgentMigrationState> {
    const agent = await this.requireAgent(agentId);
    const record = await this.deps.store.forIdentity(agent.id, agent.switchAgentId);
    const operation = this.operations.get(agent.id) ?? null;
    if (record) return this.managedState(agent, record, operation);
    return this.consoleState(agent, operation);
  }

  /** Who runs the agent: this Console, or a controller it was moved onto. */
  async runner(agentId: string): Promise<AgentRunner> {
    const agent = await this.requireAgent(agentId);
    return (await this.isManaged(agent)) ? 'managed' : 'console';
  }

  async moveToManaged(agentId: string): Promise<MoveToManagedResult> {
    let untold: MoveToManagedResult['untold'] = [];
    await this.exclusive(agentId, 'moving', async () => {
      const agent = await this.requireAgent(agentId);
      const moving = await this.prepareMove(agent);
      untold = await this.tellTurnsCut(agent);
      await this.move(moving);
    });
    return { untold };
  }

  async stopManaging(agentId: string): Promise<void> {
    await this.exclusive(agentId, 'returning', async () => {
      const agent = await this.requireAgent(agentId);
      const record = await this.deps.store.get(agent.id);
      if (!record)
        throw new MigrationBlockedError(`${agent.name} is not managed; Console runs it.`);
      await this.giveBack(agent, record);
    });
  }

  /** Why each agent the last automatic passes could not move did not, by agent. */
  migrationProblems(): MigrationProblem[] {
    return [...this.problems.values()];
  }

  /**
   * Moves every agent this Console runs that can be managed: linked to a
   * server with agent management, and owned by the signed-in user. A machine
   * that is not running managed agents yet is set up first. Turns running are
   * cut. A machine whose controller Switch revoked or forgot is enrolled
   * again, and the agents moved onto the old one are placed on the new one.
   * Agents someone else owns, or on a server without agent management, are
   * left as they are; any other reason an agent did not move is kept as a
   * problem, and tried again after a delay that doubles up to `maxRetryMs`.
   * One pass runs at a time; a call during one waits for it.
   */
  migrateEverything(): Promise<void> {
    this.migrating ??= this.migrateOnce().finally(() => {
      this.migrating = null;
    });
    return this.migrating;
  }

  /** Where the automatic move stands, from what the passes so far found; reads nothing remote. */
  async overview(): Promise<MigrationOverview> {
    const machines: MigrationMachine[] = [];
    for (const group of this.groups) {
      const first = group[0]!;
      const key = groupKey(first);
      let moved = 0;
      for (const agent of group) if (await this.isManaged(agent)) moved++;
      const controller = this.controllers.get(key) ?? null;
      machines.push({
        machine: first.sshHost ?? 'this computer',
        sshHost: first.sshHost,
        serverId: first.serverId!,
        total: group.length,
        moved,
        controller: controller?.state ?? null,
        checkedAt: controller?.checkedAt ?? null,
        problems: group.flatMap((agent) => {
          const problem = this.problems.get(agent.id);
          return problem ? [problem] : [];
        }),
      });
    }
    return {
      machines,
      leftAlone: this.leftAlone.size,
      unasked: this.unasked.size,
      running: this.migrating !== null,
      lastPassAt: this.lastPassAt,
    };
  }

  /**
   * Forgets every agent that could not be managed, so the next pass asks Switch
   * about each again: a server that has just turned agent management on.
   */
  recheckAll(): void {
    for (const agentId of this.unmanageableUntil.keys()) this.recheck(agentId);
  }

  /** Forgets that an agent could not be managed, so the next pass asks Switch again. */
  recheck(agentId: string): void {
    this.unmanageableUntil.delete(agentId);
    this.retryAt.delete(agentId);
    this.retryAt.delete(`ask:${agentId}`);
  }

  private async migrateOnce(): Promise<void> {
    const now = this.deps.now();
    const agents = await this.deps.agents.list();
    const present = new Set(agents.map((agent) => agent.id));
    for (const agentId of this.problems.keys())
      if (!present.has(agentId)) this.problems.delete(agentId);
    const candidates: MigrationAgent[] = [];
    for (const agent of agents) {
      if (!agent.switchAgentId || !agent.workspaceId || !agent.serverId) {
        this.problems.delete(agent.id);
        this.leftAlone.delete(agent.id);
        this.unasked.delete(agent.id);
        continue;
      }
      if (await this.isManaged(agent)) {
        this.leftAlone.delete(agent.id);
        this.unasked.delete(agent.id);
        candidates.push(agent);
        continue;
      }
      if ((this.unmanageableUntil.get(agent.id) ?? 0) > now) continue;
      if (!this.due(`ask:${agent.id}`, now)) continue;
      let eligibility: Awaited<ReturnType<MigrationManagementPort['eligibility']>>;
      try {
        eligibility = await this.deps.management.eligibility(
          agent.workspaceId,
          agent.switchAgentId
        );
      } catch (error) {
        this.deps.log.warn('Switch could not be asked whether an agent can be managed', {
          agentId: agent.id,
          error: message(error),
        });
        this.backOff(`ask:${agent.id}`, now);
        this.unasked.add(agent.id);
        continue;
      }
      this.unasked.delete(agent.id);
      this.retryAt.delete(`ask:${agent.id}`);
      if (!eligibility.management || !eligibility.ownedByMe) {
        this.unmanageableUntil.set(agent.id, now + this.deps.unmanageableRecheckMs);
        this.problems.delete(agent.id);
        this.leftAlone.add(agent.id);
        continue;
      }
      this.leftAlone.delete(agent.id);
      candidates.push(agent);
    }
    for (const agentId of [...this.leftAlone, ...this.unasked])
      if (!present.has(agentId)) {
        this.leftAlone.delete(agentId);
        this.unasked.delete(agentId);
      }
    this.groups = groupByController(candidates);
    for (const group of this.groups) await this.migrateGroup(group, now);
    this.lastPassAt = new Date(this.deps.now()).toISOString();
  }

  private controllerState(key: string, state: MigrationControllerState): void {
    this.controllers.set(key, { state, checkedAt: new Date(this.deps.now()).toISOString() });
  }

  /**
   * One controller's agents: makes sure the machine runs a controller this
   * Console can place agents on (setting it up, enrolling it again after a
   * revocation, or restarting it on this build), places the moved agents
   * whose controller is gone on the new one, and moves the rest.
   */
  private async migrateGroup(group: MigrationAgent[], now: number): Promise<void> {
    const first = group[0]!;
    const where = first.sshHost ?? 'this computer';
    const key = groupKey(first);
    const managed = new Map<string, ManagedAgentRecord>();
    for (const agent of group) {
      const record = await this.deps.store.forIdentity(agent.id, agent.switchAgentId);
      if (record) managed.set(agent.id, record);
    }
    if (!this.due(key, now)) return;
    const waiting = group.filter((agent) => !managed.has(agent.id));
    let controllerId: string;
    try {
      const prepared = await this.prepareMachine(first, where);
      if (prepared.kind === 'incompatible') {
        this.deps.log.warn('Not moving agents: the server cannot take this Console’s controller', {
          machine: where,
          serverId: first.serverId,
          reason: prepared.reason,
        });
        this.backOff(key, now, this.deps.unmanageableRecheckMs);
        this.controllerState(key, prepared);
        for (const agent of group) this.problems.delete(agent.id);
        return;
      }
      controllerId = prepared.controllerId;
      this.retryAt.delete(key);
      this.controllerState(key, { kind: 'ready' });
    } catch (error) {
      this.backOff(key, now);
      this.controllerState(key, { kind: 'failed', reason: message(error) });
      for (const agent of group) this.problem(agent, message(error));
      return;
    }
    if (waiting.length === 0) this.backOff(key, now, this.deps.healIntervalMs);
    for (const [agentId, record] of managed) {
      const agent = group.find((candidate) => candidate.id === agentId)!;
      try {
        if (record.controllerId !== controllerId) await this.replace(agent, record, controllerId);
        this.problems.delete(agent.id);
        this.retryAt.delete(agent.id);
      } catch (error) {
        this.backOff(agent.id, now);
        this.problem(agent, message(error));
      }
    }
    const due = waiting.filter((agent) => this.due(agent.id, now));
    if (!due.length) return;
    const failures = await this.moveBatch(due);
    for (const agent of due) {
      const failure = failures.get(agent.id);
      if (failure === undefined) {
        this.problems.delete(agent.id);
        this.retryAt.delete(agent.id);
      } else {
        this.backOff(agent.id, now);
        this.problem(agent, message(failure));
      }
    }
  }

  /**
   * Moves several agents on one machine onto its controller together: what
   * happens on the machine (turning Console's watchers off, keeping their
   * credentials aside, starting them on the controller) is one command for all
   * of them rather than one per agent. Each agent still goes through the
   * steps of `move`, and one that fails at any step is undone on its own,
   * leaving the rest to carry on. Returns why each agent that did not move
   * did not.
   */
  private async moveBatch(agents: MigrationAgent[]): Promise<Map<string, unknown>> {
    const failures = new Map<string, unknown>();
    const claimed: MigrationAgent[] = [];
    for (const agent of agents) {
      if (this.operations.has(agent.id)) {
        failures.set(agent.id, new MigrationBlockedError('This agent is already being moved.'));
        continue;
      }
      this.operations.set(agent.id, { kind: 'moving', stage: 'checking' });
      claimed.push(agent);
    }
    try {
      await this.moveClaimed(claimed, failures);
    } finally {
      for (const agent of claimed) {
        this.operations.delete(agent.id);
        const record = await this.deps.store.get(agent.id).catch(() => null);
        this.deps.emit({
          agentId: agent.id,
          runner: record ? 'managed' : 'console',
          operation: null,
        });
      }
    }
    return failures;
  }

  private async moveClaimed(
    agents: MigrationAgent[],
    failures: Map<string, unknown>
  ): Promise<void> {
    const first = agents[0];
    if (!first) return;
    const lookup = await this.deps.targets.resolve(first);
    const target = lookup.target;
    if (!target) {
      const blocked = new MigrationBlockedError(
        lookup.blocker ?? 'There is no machine to move it to.'
      );
      for (const agent of agents) failures.set(agent.id, blocked);
      return;
    }
    const fail = (moving: Moving, error: unknown) => failures.set(moving.agent.id, error);

    let batch: Moving[] = [];
    for (const agent of agents) {
      try {
        if (target.workspaceId !== agent.workspaceId)
          throw new MigrationBlockedError(
            'The machine runs managed agents for another workspace on this server; an agent can only be placed on a machine of its own workspace.'
          );
        batch.push({
          agent,
          target,
          definition: await this.deps.definitions.build(agent),
          stoppedByHand: await this.deps.agents.stoppedByHand(agent.id),
          identity: {
            switchAgentId: agent.switchAgentId!,
            slug: agent.name,
            subagent: null,
            credentialsStashed: false,
            controllerRoot: target.watcherRoot(agent.switchAgentId!),
          },
        });
      } catch (error) {
        failures.set(agent.id, error);
      }
    }

    await Promise.all(batch.map((moving) => this.tellTurnsCut(moving.agent)));

    const adopted: Moving[] = [];
    for (const moving of batch) {
      this.stage(moving.agent.id, 'adopting');
      try {
        await this.deps.management.adopt(moving.agent.workspaceId!, moving.identity.switchAgentId, {
          controller_id: target.controllerId,
          desired_state: 'stopped',
          definition: moving.definition.definition,
        });
        adopted.push(moving);
      } catch (error) {
        fail(moving, error);
      }
    }
    batch = adopted;

    const records = new Map<string, ManagedAgentRecord>();
    for (const moving of batch) {
      this.stage(moving.agent.id, 'stopping-console-watcher');
      records.set(moving.agent.id, this.recordOf(moving));
    }
    const stopped = new Map<string, string | null>();
    try {
      for (const record of records.values()) await this.deps.store.set(record);
      for (const [agentId, outcome] of await this.deps.machine.stopConsoleWatchers(
        batch.map((moving) => moving.agent)
      ))
        stopped.set(agentId, outcome);
    } catch (error) {
      for (const moving of batch) stopped.set(moving.agent.id, message(error));
    }
    batch = await this.keep(batch, async (moving) => {
      const why = stopped.has(moving.agent.id)
        ? stopped.get(moving.agent.id)
        : 'The machine did not report on its watcher.';
      if (why === null) return;
      this.deps.log.error('Could not stop Console’s watcher for an agent being moved; undoing', {
        agentId: moving.agent.id,
        error: why,
      });
      await this.releaseQuietly(moving.agent.workspaceId!, [moving.identity.switchAgentId]);
      await this.quietly('forget the managed record', () =>
        this.deps.store.delete(moving.agent.id)
      );
      await this.quietly('start Console’s watcher again', () =>
        this.deps.machine.startConsoleWatcher(moving.agent)
      );
      fail(
        moving,
        new Error(
          `Could not stop Console’s watcher for ${moving.agent.name}, so it stays with this Console: ${why}`
        )
      );
      return 'undone';
    });

    for (const moving of batch) this.stage(moving.agent.id, 'releasing');
    let stashed: Map<string, boolean | Error>;
    try {
      stashed = await this.deps.credentials.stashMany(
        batch.map((moving) => ({ agent: moving.agent, identity: moving.identity }))
      );
    } catch (error) {
      stashed = new Map(
        batch.map((moving) => [
          moving.agent.id,
          error instanceof Error ? error : new Error(message(error)),
        ])
      );
    }
    batch = await this.keep(batch, async (moving) => {
      const outcome =
        stashed.get(moving.agent.id) ??
        new Error('The machine did not report on its credentials file.');
      if (outcome instanceof Error) {
        await this.undoInBatch(moving, records.get(moving.agent.id)!, false, outcome, fail);
        return 'undone';
      }
      moving.identity.credentialsStashed = outcome;
      await this.deps.store.set({
        ...records.get(moving.agent.id)!,
        identities: [moving.identity],
      });
    });

    if (batch.length) {
      try {
        await this.deps.machine.handoff(batch[0]!.agent, {
          op: 'start-fresh',
          side: 'controller',
          identities: this.handoffIdentities(batch.map((moving) => moving.identity)),
        });
      } catch (error) {
        for (const moving of batch)
          await this.undoInBatch(moving, records.get(moving.agent.id)!, false, error, fail);
        batch = [];
      }
    }

    for (const moving of batch) {
      if (moving.stoppedByHand) continue;
      try {
        await this.deps.management.setDesiredState(
          moving.agent.workspaceId!,
          moving.identity.switchAgentId,
          'running'
        );
      } catch (error) {
        await this.undoInBatch(moving, records.get(moving.agent.id)!, false, error, fail);
        continue;
      }
      this.deps.log.info('Moved an agent onto its controller', {
        agentId: moving.agent.id,
        controllerId: target.controllerId,
      });
    }
    for (const moving of batch)
      if (moving.stoppedByHand)
        this.deps.log.info('Moved an agent onto its controller, stopped as it was', {
          agentId: moving.agent.id,
          controllerId: target.controllerId,
        });
  }

  /** The moves for which `step` did not undo anything. */
  private async keep(
    batch: Moving[],
    step: (moving: Moving) => Promise<'undone' | undefined>
  ): Promise<Moving[]> {
    const kept: Moving[] = [];
    for (const moving of batch) if ((await step(moving)) !== 'undone') kept.push(moving);
    return kept;
  }

  private async undoInBatch(
    moving: Moving,
    record: ManagedAgentRecord,
    ranOnController: boolean,
    error: unknown,
    fail: (moving: Moving, error: unknown) => void
  ): Promise<void> {
    this.deps.log.error('Could not finish moving an agent to its controller; undoing', {
      agentId: moving.agent.id,
      error: message(error),
    });
    await this.undoMove(
      moving.agent,
      moving.target,
      record,
      this.handoffIdentities([moving.identity]),
      moving.identity,
      ranOnController
    );
    fail(
      moving,
      new Error(
        `Could not move ${moving.agent.name}, so it stays with this Console: ${message(error)}`,
        {
          cause: error,
        }
      )
    );
  }

  private recordOf(moving: Moving): ManagedAgentRecord {
    const { agent, target, identity } = moving;
    return {
      agentId: agent.id,
      workspaceId: agent.workspaceId!,
      controllerId: target.controllerId,
      placement:
        target.display.kind === 'this-computer'
          ? { kind: 'this-computer', serverId: target.display.serverId }
          : {
              kind: 'ssh-host',
              sshHost: target.display.sshHost,
              serverId: target.display.serverId,
            },
      identities: [identity],
      movedAt: new Date(this.deps.now()).toISOString(),
    };
  }

  /**
   * The controller a group of agents is placed on, once the machine runs one
   * this Console can use. Anything changed on the way (a machine set up,
   * enrolled again, or restarted) is waited for until Switch lists the
   * controller online.
   */
  private async prepareMachine(
    agent: MigrationAgent,
    where: string
  ): Promise<{ kind: 'ready'; controllerId: string } | { kind: 'incompatible'; reason: string }> {
    const healed = await this.deps.targets.heal(agent);
    if (healed.kind === 'incompatible') return healed;
    if (healed.kind === 'not-set-up') {
      this.deps.log.info('Setting a machine up to move its agents', { machine: where });
      try {
        await this.deps.targets.enable(agent);
      } catch (error) {
        throw new Error(`${where} could not be set up to run managed agents: ${message(error)}`, {
          cause: error,
        });
      }
    }
    const deadline = this.deps.now() + this.deps.machineReadyWaitMs;
    for (;;) {
      const lookup = await this.deps.targets.resolve(agent).catch((error: unknown) => ({
        target: null,
        blocker: message(error),
      }));
      if (lookup.target) return { kind: 'ready', controllerId: lookup.target.controllerId };
      if (healed.kind === 'unchanged')
        throw new Error(lookup.blocker ?? `${where} cannot take agents.`);
      if (this.deps.now() >= deadline)
        throw new Error(
          `${where} was set up to run managed agents, but is not ready for them yet: ${lookup.blocker ?? 'it has not reached Switch'}.`
        );
      await this.deps.sleep(this.deps.pollMs);
    }
  }

  /** Places a moved agent whose controller is gone on the machine's controller now. */
  private async replace(
    agent: MigrationAgent,
    record: ManagedAgentRecord,
    controllerId: string
  ): Promise<void> {
    await this.deps.management.place(agent.workspaceId!, agent.switchAgentId!, controllerId);
    await this.deps.store.set({ ...record, controllerId });
    this.deps.log.info('Placed a moved agent on its machine’s new controller', {
      agentId: agent.id,
      from: record.controllerId,
      to: controllerId,
    });
  }

  /** Whether an agent or a machine is due another try. */
  private due(key: string, now: number): boolean {
    return (this.retryAt.get(key)?.at ?? 0) <= now;
  }

  /**
   * Puts off the next try: by `fixedMs` when given, otherwise twice as long as
   * the last time, from one pass up to `maxRetryMs`.
   */
  private backOff(key: string, now: number, fixedMs?: number): void {
    const last = this.retryAt.get(key)?.delay ?? 0;
    const delay =
      fixedMs ?? Math.min(Math.max(last * 2, this.deps.minRetryMs), this.deps.maxRetryMs);
    this.retryAt.set(key, { at: now + delay, delay });
  }

  private problem(agent: MigrationAgent, why: string): void {
    this.deps.log.warn('An agent could not be moved to managed', {
      agentId: agent.id,
      error: why,
    });
    this.problems.set(agent.id, {
      agentId: agent.id,
      name: agent.name,
      machine: agent.sshHost ?? 'this computer',
      message: why,
    });
  }

  private async isManaged(agent: MigrationAgent): Promise<boolean> {
    return (await this.deps.store.forIdentity(agent.id, agent.switchAgentId)) !== null;
  }

  // ── State ──────────────────────────────────────────────────────────────────

  private async consoleState(
    agent: MigrationAgent,
    operation: MigrationOperation | null
  ): Promise<AgentMigrationState> {
    const base = {
      agentId: agent.id,
      runner: 'console' as const,
      operation,
      canEnableTarget: false,
      managed: null,
    };
    const unlinked = this.unlinkedReason(agent);
    if (unlinked) return { ...base, target: null, blocker: unlinked, notCarried: [] };
    const lookup = await this.deps.targets.resolve(agent);
    let blocker = lookup.blocker ?? (await this.eligibilityBlocker(agent));
    if (!blocker && lookup.target && lookup.target.workspaceId !== agent.workspaceId)
      blocker =
        'The machine runs managed agents for another workspace on this server; an agent can only be placed on a machine of its own workspace.';
    // Read only for an agent that can move: it is what the move's confirmation lists.
    let notCarried: string[] = [];
    if (!blocker)
      try {
        notCarried = (await this.deps.definitions.build(agent)).notCarried;
      } catch (error) {
        blocker = `Its configuration cannot be read: ${message(error)}`;
      }
    return {
      ...base,
      target: lookup.display,
      blocker,
      canEnableTarget: lookup.canEnable,
      notCarried,
    };
  }

  private async managedState(
    agent: MigrationAgent,
    record: ManagedAgentRecord,
    operation: MigrationOperation | null
  ): Promise<AgentMigrationState> {
    let view: ManagedView | null = null;
    let unreadable: string | null = null;
    try {
      view = await this.deps.management.read(
        record.workspaceId,
        record.identities[0]!.switchAgentId
      );
    } catch (error) {
      unreadable = message(error);
    }
    let lookup: TargetLookup | null = null;
    let lookupFailure: string | null = null;
    try {
      lookup = await this.deps.targets.resolve(agent);
    } catch (error) {
      lookupFailure = message(error);
    }
    return {
      agentId: agent.id,
      runner: 'managed',
      operation,
      target:
        lookup?.display ??
        (record.placement.kind === 'this-computer'
          ? { kind: 'this-computer', serverId: record.placement.serverId, machineName: null }
          : {
              kind: 'ssh-host',
              sshHost: record.placement.sshHost,
              serverId: record.placement.serverId,
              machineName: null,
            }),
      blocker: null,
      canEnableTarget: false,
      notCarried: [],
      managed: {
        controllerId: record.controllerId,
        movedAt: record.movedAt,
        machine: lookup
          ? machineOf(lookup, record)
          : { kind: 'unknown', reason: `Console could not look at the machine: ${lookupFailure}` },
        desiredState: view?.desiredState ?? null,
        actual: view?.actual ?? null,
        unreadable:
          unreadable ??
          (view === null
            ? 'Switch no longer manages this agent. Stop managing brings it back to this Console.'
            : view.controllerId !== record.controllerId
              ? 'Switch has placed this agent on another machine since it moved.'
              : null),
      },
    };
  }

  private unlinkedReason(agent: MigrationAgent): string | null {
    if (!agent.switchAgentId || !agent.workspaceId || !agent.serverId)
      return 'Link the agent to a Switch workspace first.';
    return null;
  }

  private async eligibilityBlocker(agent: MigrationAgent): Promise<string | null> {
    try {
      const eligibility = await this.deps.management.eligibility(
        agent.workspaceId!,
        agent.switchAgentId!
      );
      if (!eligibility.management)
        return 'This server does not have agent management turned on, so it cannot run agents on machines.';
      if (!eligibility.ownedByMe)
        return `Only its owner${eligibility.owner ? ` (${eligibility.owner})` : ''} can move it to a managed machine.`;
      return null;
    } catch (error) {
      return `Switch could not be asked whether this agent can move: ${message(error)}`;
    }
  }

  // ── Moving ─────────────────────────────────────────────────────────────────

  private async prepareMove(agent: MigrationAgent): Promise<Moving> {
    const state = await this.state(agent.id);
    if (state.runner === 'managed')
      throw new MigrationBlockedError(`${agent.name} is already managed.`);
    if (state.blocker) throw new MigrationBlockedError(state.blocker);
    const lookup = await this.deps.targets.resolve(agent);
    if (!lookup.target)
      throw new MigrationBlockedError(lookup.blocker ?? 'There is no machine to move it to.');
    return {
      agent,
      target: lookup.target,
      definition: await this.deps.definitions.build(agent),
      stoppedByHand: await this.deps.agents.stoppedByHand(agent.id),
      identity: {
        switchAgentId: agent.switchAgentId!,
        slug: agent.name,
        subagent: null,
        credentialsStashed: false,
        controllerRoot: lookup.target.watcherRoot(agent.switchAgentId!),
      },
    };
  }

  /**
   * Tells each room where the agent is mid-turn that the move cuts the turn
   * off. Best effort: a room it could not tell is logged and returned, and the
   * move goes on.
   */
  private async tellTurnsCut(agent: MigrationAgent): Promise<{ roomId: string; reason: string }[]> {
    this.stage(agent.id, 'telling-rooms');
    let rooms: string[];
    try {
      rooms = await this.deps.machine.roomsMidTurn(agent);
    } catch (error) {
      this.deps.log.warn('Could not tell which rooms an agent being moved is working in', {
        agentId: agent.id,
        error: message(error),
      });
      return [];
    }
    if (!rooms.length) return [];
    const untold = await this.deps.machine.tellTurnsCut(agent, rooms);
    for (const { roomId, reason } of untold)
      this.deps.log.warn('Could not tell a room that a move cut the agent’s turn off', {
        agentId: agent.id,
        roomId,
        reason,
      });
    return untold;
  }

  private async move(moving: Moving): Promise<void> {
    const { agent, target, identity, definition } = moving;
    const workspaceId = agent.workspaceId!;

    this.stage(agent.id, 'adopting');
    await this.deps.management.adopt(workspaceId, identity.switchAgentId, {
      controller_id: target.controllerId,
      desired_state: 'stopped',
      definition: definition.definition,
    });

    const record = this.recordOf(moving);
    this.stage(agent.id, 'stopping-console-watcher');
    try {
      await this.deps.store.set(record);
      await this.deps.machine.stopConsoleWatcher(agent);
    } catch (error) {
      this.deps.log.error('Could not stop Console’s watcher for an agent being moved; undoing', {
        agentId: agent.id,
        error: message(error),
      });
      await this.releaseQuietly(workspaceId, [identity.switchAgentId]);
      await this.quietly('forget the managed record', () => this.deps.store.delete(agent.id));
      await this.quietly('start Console’s watcher again', () =>
        this.deps.machine.startConsoleWatcher(agent)
      );
      throw new Error(
        `Could not stop Console’s watcher for ${agent.name}, so it stays with this Console: ${message(error)}`,
        { cause: error }
      );
    }

    const identities = this.handoffIdentities([identity]);
    let ranOnController = false;
    try {
      this.stage(agent.id, 'releasing');
      identity.credentialsStashed = await this.deps.credentials.stash(agent, identity);
      await this.deps.store.set({ ...record, identities: [identity] });
      await this.deps.machine.handoff(agent, { op: 'start-fresh', side: 'controller', identities });
      ranOnController = !moving.stoppedByHand;
      if (!moving.stoppedByHand)
        await this.deps.management.setDesiredState(workspaceId, identity.switchAgentId, 'running');
    } catch (error) {
      this.deps.log.error('Could not finish moving an agent to its controller; undoing', {
        agentId: agent.id,
        error: message(error),
      });
      await this.undoMove(agent, target, record, identities, identity, ranOnController);
      throw new Error(
        `Could not move ${agent.name}, so it stays with this Console: ${message(error)}`,
        { cause: error }
      );
    }
    this.deps.log.info('Moved an agent onto its controller', {
      agentId: agent.id,
      controllerId: target.controllerId,
    });
  }

  private async undoMove(
    agent: MigrationAgent,
    target: ResolvedTarget,
    record: ManagedAgentRecord,
    identities: HandoffIdentity[],
    identity: MovedIdentity,
    ranOnController: boolean
  ): Promise<void> {
    await this.releaseQuietly(record.workspaceId, [identity.switchAgentId]);
    try {
      await this.waitForControllerStop(agent, identities);
      // Only once the controller may have answered something: otherwise Console's
      // watcher goes on from where it stopped, and takes what arrived meanwhile.
      if (ranOnController)
        await this.deps.machine.handoff(agent, { op: 'start-fresh', side: 'console', identities });
    } catch (error) {
      this.deps.log.error('The controller did not stop an agent after a failed move', {
        agentId: agent.id,
        controllerId: target.controllerId,
        error: message(error),
      });
    }
    if (identity.credentialsStashed)
      await this.quietly('restore the credentials file', () =>
        this.deps.credentials.restore(agent, identity)
      );
    await this.quietly('forget the managed record', () => this.deps.store.delete(agent.id));
    await this.quietly('start Console’s watcher again', () =>
      this.deps.machine.startConsoleWatcher(agent)
    );
  }

  // ── Returning ──────────────────────────────────────────────────────────────

  private async giveBack(agent: MigrationAgent, record: ManagedAgentRecord): Promise<void> {
    this.stage(agent.id, 'releasing');
    for (const identity of record.identities) {
      const outcome = await this.deps.management.release(
        record.workspaceId,
        identity.switchAgentId
      );
      if (outcome === 'already_gone')
        this.deps.log.warn('Switch no longer managed an agent being brought back', {
          agentId: agent.id,
          switchAgentId: identity.switchAgentId,
        });
    }
    const identities = this.handoffIdentities(record.identities);
    this.stage(agent.id, 'waiting-for-controller');
    await this.waitForControllerStop(agent, identities);
    this.stage(agent.id, 'restoring-console-watcher');
    await this.deps.machine.handoff(agent, { op: 'start-fresh', side: 'console', identities });
    for (const identity of record.identities) await this.deps.credentials.restore(agent, identity);
    await this.deps.store.delete(agent.id);
    await this.deps.machine.startConsoleWatcher(agent);
    this.deps.log.info('Brought a managed agent back to Console', {
      agentId: agent.id,
      controllerId: record.controllerId,
    });
  }

  /**
   * Waits for the controller to stop the agent's watchers, as it does once
   * Switch no longer assigns them. Past the grace, the watchers are turned off
   * here, as the controller would: one that is not running (Console's own is
   * off, or the host's is down) would otherwise leave them running for good.
   */
  private async waitForControllerStop(
    agent: MigrationAgent,
    identities: HandoffIdentity[]
  ): Promise<void> {
    const start = this.deps.now();
    const deadline = start + this.deps.controllerStopWaitMs;
    let turnedOff = false;
    for (;;) {
      const status = await this.deps.machine.handoff(agent, { op: 'status', identities });
      const running = status.watchers.filter((watcher) => watcher.controller);
      if (!running.length) return;
      if (!turnedOff && this.deps.now() >= start + this.deps.controllerStopWaitMs / 4) {
        this.deps.log.warn(
          'The controller has not stopped an agent it no longer runs; turning its watcher off',
          {
            agentId: agent.id,
            watchers: running.map((watcher) => watcher.switchAgentId),
          }
        );
        await this.deps.machine.handoff(agent, {
          op: 'turn-off',
          identities: identities.filter((identity) =>
            running.some((watcher) => watcher.switchAgentId === identity.switchAgentId)
          ),
        });
        turnedOff = true;
      }
      if (this.deps.now() >= deadline)
        throw new Error(
          'The agent’s watcher on its managed machine has not stopped, so Console cannot take it back yet. Try Stop managing again in a moment.'
        );
      await this.deps.sleep(this.deps.pollMs);
    }
  }

  // ── Shared ─────────────────────────────────────────────────────────────────

  private handoffIdentities(identities: MovedIdentity[]): HandoffIdentity[] {
    return identities.map((identity) => ({
      switchAgentId: identity.switchAgentId,
      controllerRoot: identity.controllerRoot,
    }));
  }

  private async releaseQuietly(workspaceId: string, switchAgentIds: string[]): Promise<void> {
    for (const switchAgentId of switchAgentIds)
      await this.quietly(`release agent ${switchAgentId} from management`, async () => {
        await this.deps.management.release(workspaceId, switchAgentId);
      });
  }

  private async quietly(what: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.deps.log.error(`While undoing a move, could not ${what}`, { error: message(error) });
    }
  }

  private async requireAgent(agentId: string): Promise<MigrationAgent> {
    const agent = await this.deps.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} does not exist.`);
    return agent;
  }

  private stage(agentId: string, stage: MigrationStage): void {
    const current = this.operations.get(agentId);
    if (!current) return;
    current.stage = stage;
    this.deps.emit({
      agentId,
      runner: current.kind === 'moving' ? 'console' : 'managed',
      operation: { ...current },
    });
  }

  private async exclusive(
    agentId: string,
    kind: MigrationOperation['kind'],
    task: () => Promise<void>
  ): Promise<void> {
    if (this.operations.has(agentId))
      throw new MigrationBlockedError('This agent is already being moved.');
    this.operations.set(agentId, { kind, stage: 'checking' });
    try {
      await task();
    } finally {
      this.operations.delete(agentId);
      const record = await this.deps.store.get(agentId).catch(() => null);
      this.deps.emit({ agentId, runner: record ? 'managed' : 'console', operation: null });
    }
  }
}
