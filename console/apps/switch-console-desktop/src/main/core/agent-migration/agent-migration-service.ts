import type {
  AgentMigrationEvent,
  AgentMigrationState,
  ManagedActual,
  ManagedMachine,
  MigrationOperation,
  MigrationStage,
  MigrationTarget,
  MoveAllMachine,
  MoveAllProgress,
  MoveAllResult,
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
  /** Puts Console's watcher for the agent back as its settings say. */
  startConsoleWatcher(agent: MigrationAgent): Promise<void>;
  handoff(agent: MigrationAgent, request: HandoffRequest): Promise<HandoffResult>;
}

/** The agent's credentials file in its working directory, kept aside while it is managed. */
export interface MigrationCredentialsPort {
  /** Keeps the file's token in the encrypted secrets store and removes the file. False when there was none. */
  stash(agent: MigrationAgent, identity: { slug: string; switchAgentId: string }): Promise<boolean>;
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
  /** How long "Move all" waits for a machine it turned on to take agents. */
  machineReadyWaitMs: number;
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

export type MoveScope =
  | { kind: 'this-computer'; serverId: string }
  | { kind: 'ssh-host'; sshHost: string }
  /** Every agent of a workspace, on this computer and on every SSH host. */
  | { kind: 'workspace'; serverId: string; workspaceId: string };

/** Agents grouped by the machine they run on: this computer first, then each SSH host by name. */
function groupByMachine(agents: MigrationAgent[]): MigrationAgent[][] {
  const groups = new Map<string, MigrationAgent[]>();
  for (const agent of agents) {
    const key = agent.sshHost ?? '';
    groups.set(key, [...(groups.get(key) ?? []), agent]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group);
}

function agentInScope(agent: MigrationAgent, scope: MoveScope): boolean {
  switch (scope.kind) {
    case 'this-computer':
      return agent.sshHost === null && agent.serverId === scope.serverId;
    case 'ssh-host':
      return agent.sshHost === scope.sshHost;
    case 'workspace':
      return agent.serverId === scope.serverId && agent.workspaceId === scope.workspaceId;
  }
}

/** Whether a moved agent is in scope; `agent` is its Console agent, null when that is gone. */
function recordInScope(
  record: ManagedAgentRecord,
  agent: MigrationAgent | null,
  scope: MoveScope
): boolean {
  switch (scope.kind) {
    case 'this-computer':
      return (
        record.placement.kind === 'this-computer' && record.placement.serverId === scope.serverId
      );
    case 'ssh-host':
      return record.placement.kind === 'ssh-host' && record.placement.sshHost === scope.sshHost;
    case 'workspace':
      return agent !== null && agentInScope(agent, scope);
  }
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

  constructor(private readonly deps: AgentMigrationDeps) {}

  async state(agentId: string): Promise<AgentMigrationState> {
    const agent = await this.requireAgent(agentId);
    const record = await this.deps.store.forIdentity(agent.id, agent.switchAgentId);
    const operation = this.operations.get(agent.id) ?? null;
    if (record) return this.managedState(agent, record, operation);
    return this.consoleState(agent, operation);
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

  /**
   * Moves every agent that can move, on this computer for a server, on an SSH
   * host, or across a workspace, one machine at a time. A machine that is not
   * running managed agents yet is turned on first, as its own toggle would,
   * then its agents move once it can take them. Agents that cannot move are
   * skipped with the reason; one that fails does not stop the rest.
   */
  async moveAll(scope: MoveScope): Promise<MoveAllResult> {
    const result: MoveAllResult = { moved: [], skipped: [], failed: [] };
    const agents = (await this.deps.agents.list()).filter((agent) => agentInScope(agent, scope));
    for (const group of groupByMachine(agents)) {
      const setUp = await this.setUpMachine(group);
      for (const agent of group) {
        if (setUp) {
          if (!(await this.isManaged(agent)))
            result.skipped.push({ agentId: agent.id, name: agent.name, reason: setUp });
          continue;
        }
        const state = await this.state(agent.id).catch((error: unknown) => ({
          error: message(error),
        }));
        if ('error' in state) {
          result.failed.push({ agentId: agent.id, name: agent.name, message: state.error });
          continue;
        }
        if (state.runner === 'managed') continue;
        if (state.blocker) {
          result.skipped.push({ agentId: agent.id, name: agent.name, reason: state.blocker });
          continue;
        }
        try {
          await this.moveToManaged(agent.id);
          result.moved.push({ agentId: agent.id, name: agent.name });
        } catch (error) {
          result.failed.push({ agentId: agent.id, name: agent.name, message: message(error) });
        }
      }
    }
    return result;
  }

  private async isManaged(agent: MigrationAgent): Promise<boolean> {
    return (await this.deps.store.forIdentity(agent.id, agent.switchAgentId)) !== null;
  }

  /**
   * Turns on the machine a group of agents runs on when one of them is waiting
   * for exactly that, and waits until it can take agents. Null when there was
   * nothing to do or it is ready; otherwise why the group cannot move.
   */
  private async setUpMachine(group: MigrationAgent[]): Promise<string | null> {
    const waiting = [];
    for (const agent of group) {
      if (await this.isManaged(agent)) continue;
      const state = await this.state(agent.id).catch(() => null);
      if (state?.runner === 'console' && state.canEnableTarget) waiting.push(agent);
    }
    const first = waiting[0];
    if (!first) return null;
    const where = first.sshHost ?? 'this computer';
    this.deps.log.info('Turning a machine on to move its agents', { machine: where });
    try {
      await this.deps.targets.enable(first);
    } catch (error) {
      return `${where} could not be made a machine: ${message(error)}`;
    }
    const deadline = this.deps.now() + this.deps.machineReadyWaitMs;
    for (;;) {
      const lookup = await this.deps.targets.resolve(first).catch((error: unknown) => ({
        target: null,
        blocker: message(error),
      }));
      if (lookup.target) return null;
      if (this.deps.now() >= deadline)
        return `${where} was made a machine, but is not ready for agents yet: ${lookup.blocker ?? 'it has not reached Switch'}. Run Move all again once it shows Running.`;
      await this.deps.sleep(this.deps.pollMs);
    }
  }

  /**
   * Brings back every agent this Console moved onto one machine, one at a
   * time; one that fails does not stop the rest. `moved` lists the ones that
   * came back.
   */
  async stopManagingAll(scope: MoveScope): Promise<MoveAllResult> {
    const result: MoveAllResult = { moved: [], skipped: [], failed: [] };
    for (const record of await this.deps.store.list()) {
      const agent = await this.deps.agents.get(record.agentId);
      if (!recordInScope(record, agent, scope)) continue;
      const name = agent?.name ?? record.agentId;
      try {
        await this.stopManaging(record.agentId);
        result.moved.push({ agentId: record.agentId, name });
      } catch (error) {
        result.failed.push({ agentId: record.agentId, name, message: message(error) });
      }
    }
    return result;
  }

  /** The agents this Console moved onto one machine, by name. */
  async movedOnto(scope: MoveScope): Promise<string[]> {
    const names: string[] = [];
    for (const record of await this.deps.store.list()) {
      const agent = await this.deps.agents.get(record.agentId);
      if (recordInScope(record, agent, scope)) names.push(agent?.name ?? record.agentId);
    }
    return names;
  }

  /**
   * How far moving every agent in scope has got, per machine: how many are
   * managed, how many are moving now, and why the rest cannot move, if
   * anything stops them other than not having been moved yet.
   */
  async moveAllProgress(scope: MoveScope): Promise<MoveAllProgress> {
    const machines: MoveAllMachine[] = [];
    const agents = (await this.deps.agents.list()).filter((agent) => agentInScope(agent, scope));
    for (const group of groupByMachine(agents)) {
      const machine: MoveAllMachine = {
        kind: group[0]!.sshHost === null ? 'this-computer' : 'ssh-host',
        name: group[0]!.sshHost ?? 'This computer',
        total: group.length,
        managed: 0,
        moving: 0,
        blocked: 0,
        reason: null,
        setUpOnMove: false,
      };
      const reasons = new Map<string, number>();
      for (const agent of group) {
        let state: AgentMigrationState;
        try {
          state = await this.state(agent.id);
        } catch (error) {
          const reason = `An agent's state cannot be read: ${message(error)}`;
          reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
          machine.blocked++;
          continue;
        }
        if (state.operation) machine.moving++;
        if (state.runner === 'managed') machine.managed++;
        else if (state.canEnableTarget) machine.setUpOnMove = true;
        else if (state.blocker) {
          machine.blocked++;
          reasons.set(state.blocker, (reasons.get(state.blocker) ?? 0) + 1);
        }
      }
      machine.reason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      machines.push(machine);
    }
    return { machines };
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

    const record: ManagedAgentRecord = {
      agentId: agent.id,
      workspaceId,
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
