import type {
  AgentMigrationEvent,
  AgentMigrationState,
  ManagedActual,
  MigrationOperation,
  MigrationStage,
  MigrationTarget,
  MoveAllResult,
} from '@shared/core/agent-migration/agent-migration';
import { IDLE_RULE } from '@shared/core/agent-migration/agent-migration';
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

/** A subagent watched under its parent, with the Switch identity it runs as. */
export type SubagentRef = { name: string; switchAgentId: string };

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

export type MachineSession = { sessionId: string; switchAgentId: string; busy: boolean };

/** The agent's machine: this computer, or its SSH host. */
export interface MigrationMachinePort {
  /** Every session of these identities on the machine, and whether it is mid-turn. */
  sessions(agent: MigrationAgent, switchAgentIds: string[]): Promise<MachineSession[]>;
  /** Stops Console's watchers for the agent and these subagents, and every session they run. */
  stopConsoleWatchers(agent: MigrationAgent, subagents: SubagentRef[]): Promise<void>;
  /** Puts Console's watchers for the agent and these subagents back as their settings say. */
  startConsoleWatchers(agent: MigrationAgent, subagents: SubagentRef[]): Promise<void>;
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
    /** The subagents watched under this agent. */
    subagentsOf(agent: MigrationAgent): Promise<SubagentRef[]>;
    /** The parent a subagent row is watched under, or null for an agent of its own. */
    parentOf(agent: MigrationAgent): Promise<MigrationAgent | null>;
    /** Somebody stopped this agent's watcher by hand. */
    stoppedByHand(agentId: string): Promise<boolean>;
  };
  definitions: {
    build(agent: MigrationAgent, subagent: SubagentRef | null): Promise<BuiltDefinition>;
  };
  targets: { resolve(agent: MigrationAgent): Promise<TargetLookup> };
  management: MigrationManagementPort;
  machine: MigrationMachinePort;
  credentials: MigrationCredentialsPort;
  store: MigrationStorePort;
  emit: (event: AgentMigrationEvent) => void;
  log: MigrationLog;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** How often a waiting move looks at the agent's sessions again. */
  pollMs: number;
  /** How long a move waits for a turn to end before giving up. */
  turnWaitMs: number;
  /** How long a return waits for the controller to stop the agent. */
  controllerStopWaitMs: number;
};

/** A move refused before anything changed, for a reason a person can act on. */
export class MigrationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationBlockedError';
  }
}

/** The move or return was cancelled while it waited for a turn to end. Nothing changed. */
export class MigrationCancelledError extends Error {
  constructor() {
    super('Cancelled while waiting for the current turn to end. Nothing was changed.');
    this.name = 'MigrationCancelledError';
  }
}

type Moving = {
  agent: MigrationAgent;
  target: ResolvedTarget;
  subagents: SubagentRef[];
  identities: MovedIdentity[];
  /** Each identity's definition, by Switch agent id. */
  definitions: Map<string, BuiltDefinition>;
  stoppedByHand: boolean;
};

export type MoveScope =
  | { kind: 'this-computer'; serverId: string }
  | { kind: 'ssh-host'; sshHost: string };

function inScope(record: ManagedAgentRecord, scope: MoveScope): boolean {
  return scope.kind === 'this-computer'
    ? record.placement.kind === 'this-computer' && record.placement.serverId === scope.serverId
    : record.placement.kind === 'ssh-host' && record.placement.sshHost === scope.sshHost;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Moves a Console agent onto an agents controller ("Move to managed") and
 * back ("Stop managing"), one agent at a time, with the subagents watched
 * under it.
 *
 * A move, in order:
 * 1. Checks it can run, and waits until none of the agent's sessions is
 *    mid-turn. Nothing has changed if it stops here.
 * 2. Places the agent on the controller, stopped (`PUT`). Switch now refuses
 *    the agent's own key and closes its connection; the controller has
 *    nothing to start yet. Refused: nothing changed.
 * 3. Records it as managed, so nothing in Console starts its watcher again,
 *    and stops Console's watcher and its sessions. Failing: the placement is
 *    undone and Console's watcher put back.
 * 4. Hands its sessions over (`session-handoff.ts`), keeps its credentials
 *    file aside, and sets it running on the controller. Failing: all of the
 *    above is undone.
 *
 * Placing it stopped first is what lets its sessions move: the controller's
 * watcher reads which session attends which room only as it starts, so the
 * record has to be in place before the controller starts it.
 *
 * A return reverses it: stop managing (`DELETE`), wait for the controller to
 * stop it, hand its sessions back, restore its credentials file, and start
 * Console's watcher. Once Switch has let the agent go there is nothing to
 * undo to, so a return that fails after that keeps the record and can be
 * run again; a `DELETE` that finds it already gone carries on.
 */
export class AgentMigrationService {
  private readonly operations = new Map<string, MigrationOperation>();
  private readonly waits = new Map<string, AbortController>();

  constructor(private readonly deps: AgentMigrationDeps) {}

  async state(agentId: string): Promise<AgentMigrationState> {
    const agent = await this.requireAgent(agentId);
    const record = await this.deps.store.forIdentity(agent.id, agent.switchAgentId);
    const operation = this.operations.get(agent.id) ?? null;
    if (record && record.agentId !== agent.id) {
      const parent = await this.deps.agents.get(record.agentId);
      return {
        agentId,
        runner: 'managed',
        operation,
        target: null,
        blocker: `It moved with ${parent?.name ?? 'its parent'}, and comes back with it.`,
        canEnableTarget: false,
        movesWithParent: parent?.name ?? record.agentId,
        subagents: [],
        notCarried: [],
        managed: null,
      };
    }
    if (record) return this.managedState(agent, record, operation);
    return this.consoleState(agent, operation);
  }

  /** Cancels a move or return that is waiting for a turn to end. */
  cancel(agentId: string): void {
    this.waits.get(agentId)?.abort();
  }

  async moveToManaged(agentId: string): Promise<void> {
    await this.exclusive(agentId, 'moving', async () => {
      const agent = await this.requireAgent(agentId);
      const moving = await this.prepareMove(agent);
      await this.waitForIdle(
        agent,
        moving.identities.map((identity) => identity.switchAgentId)
      );
      await this.move(moving);
    });
  }

  async stopManaging(agentId: string): Promise<void> {
    await this.exclusive(agentId, 'returning', async () => {
      const agent = await this.requireAgent(agentId);
      const record = await this.deps.store.get(agent.id);
      if (!record) {
        const owner = await this.deps.store.forIdentity(agent.id, agent.switchAgentId);
        if (owner)
          throw new MigrationBlockedError(
            `${agent.name} moved with its parent; stop managing the parent to bring both back.`
          );
        throw new MigrationBlockedError(`${agent.name} is not managed; Console runs it.`);
      }
      await this.waitForIdle(
        agent,
        record.identities.map((identity) => identity.switchAgentId)
      );
      await this.giveBack(agent, record);
    });
  }

  /**
   * Moves every agent that can move, on this computer for a server or on an
   * SSH host, one at a time. Agents that cannot move are skipped with the
   * reason; one that fails does not stop the rest.
   */
  async moveAll(scope: MoveScope): Promise<MoveAllResult> {
    const result: MoveAllResult = { moved: [], skipped: [], failed: [] };
    const agents = (await this.deps.agents.list()).filter((agent) =>
      scope.kind === 'this-computer'
        ? agent.sshHost === null && agent.serverId === scope.serverId
        : agent.sshHost === scope.sshHost
    );
    for (const agent of agents) {
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
    return result;
  }

  /**
   * Brings back every agent this Console moved onto one machine, one at a
   * time; one that fails does not stop the rest. `moved` lists the ones that
   * came back.
   */
  async stopManagingAll(scope: MoveScope): Promise<MoveAllResult> {
    const result: MoveAllResult = { moved: [], skipped: [], failed: [] };
    for (const record of await this.deps.store.list()) {
      if (!inScope(record, scope)) continue;
      const agent = await this.deps.agents.get(record.agentId);
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
    for (const record of await this.deps.store.list())
      if (inScope(record, scope))
        names.push((await this.deps.agents.get(record.agentId))?.name ?? record.agentId);
    return names;
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
      movesWithParent: null,
      managed: null,
    };
    const parent = await this.deps.agents.parentOf(agent);
    if (parent)
      return {
        ...base,
        target: null,
        blocker: `It is watched under ${parent.name}, and moves with it.`,
        movesWithParent: parent.name,
        subagents: [],
        notCarried: [],
      };
    const subagents = await this.deps.agents.subagentsOf(agent);
    const unlinked = this.unlinkedReason(agent);
    if (unlinked)
      return {
        ...base,
        target: null,
        blocker: unlinked,
        subagents: subagents.map((subagent) => subagent.name),
        notCarried: [],
      };
    const lookup = await this.deps.targets.resolve(agent);
    let notCarried: string[] = [];
    let blocker = lookup.blocker;
    try {
      notCarried = await this.notCarried(agent, subagents);
    } catch (error) {
      blocker ??= `Its configuration cannot be read: ${message(error)}`;
    }
    if (!blocker) blocker = await this.eligibilityBlocker(agent);
    if (!blocker && lookup.target && lookup.target.workspaceId !== agent.workspaceId)
      blocker =
        'The machine runs managed agents for another workspace on this server; an agent can only be placed on a machine of its own workspace.';
    return {
      ...base,
      target: lookup.display,
      blocker,
      canEnableTarget: lookup.canEnable,
      subagents: subagents.map((subagent) => subagent.name),
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
    const lookup = await this.deps.targets.resolve(agent).catch(() => null);
    return {
      agentId: agent.id,
      runner: 'managed',
      operation,
      target:
        lookup?.display ??
        (record.placement.kind === 'this-computer'
          ? { kind: 'this-computer', serverId: record.placement.serverId, machineName: null }
          : { kind: 'ssh-host', sshHost: record.placement.sshHost, machineName: null }),
      blocker: null,
      canEnableTarget: false,
      movesWithParent: null,
      subagents: record.identities
        .map((identity) => identity.subagent)
        .filter((name): name is string => name !== null),
      notCarried: [],
      managed: {
        controllerId: record.controllerId,
        movedAt: record.movedAt,
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

  private async notCarried(agent: MigrationAgent, subagents: SubagentRef[]): Promise<string[]> {
    const lines = [...(await this.deps.definitions.build(agent, null)).notCarried];
    for (const subagent of subagents)
      for (const line of (await this.deps.definitions.build(agent, subagent)).notCarried)
        lines.push(`${subagent.name}: ${line}`);
    return lines;
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
    const subagents = await this.deps.agents.subagentsOf(agent);
    const definitions = new Map<string, BuiltDefinition>();
    definitions.set(agent.switchAgentId!, await this.deps.definitions.build(agent, null));
    for (const subagent of subagents)
      definitions.set(subagent.switchAgentId, await this.deps.definitions.build(agent, subagent));
    return {
      agent,
      target: lookup.target,
      subagents,
      definitions,
      stoppedByHand: await this.deps.agents.stoppedByHand(agent.id),
      identities: [
        { switchAgentId: agent.switchAgentId!, slug: agent.name, subagent: null },
        ...subagents.map((subagent) => ({
          switchAgentId: subagent.switchAgentId,
          slug: subagent.name,
          subagent: subagent.name,
        })),
      ].map((identity) => ({
        ...identity,
        credentialsStashed: false,
        controllerRoot: lookup.target!.watcherRoot(identity.switchAgentId),
      })),
    };
  }

  private async move(moving: Moving): Promise<void> {
    const { agent, target, subagents, definitions } = moving;
    const workspaceId = agent.workspaceId!;

    this.stage(agent.id, 'adopting');
    const adopted: string[] = [];
    try {
      for (const identity of moving.identities) {
        const built = definitions.get(identity.switchAgentId)!;
        await this.deps.management.adopt(workspaceId, identity.switchAgentId, {
          controller_id: target.controllerId,
          desired_state: 'stopped',
          definition: built.definition,
        });
        adopted.push(identity.switchAgentId);
      }
    } catch (error) {
      await this.releaseQuietly(workspaceId, adopted);
      throw error;
    }

    const record: ManagedAgentRecord = {
      agentId: agent.id,
      workspaceId,
      controllerId: target.controllerId,
      placement:
        target.display.kind === 'this-computer'
          ? { kind: 'this-computer', serverId: target.display.serverId }
          : { kind: 'ssh-host', sshHost: target.display.sshHost },
      identities: moving.identities,
      movedAt: new Date(this.deps.now()).toISOString(),
    };
    this.stage(agent.id, 'stopping-console-watcher');
    try {
      await this.deps.store.set(record);
      await this.deps.machine.stopConsoleWatchers(agent, subagents);
    } catch (error) {
      this.deps.log.error('Could not stop Console’s watcher for an agent being moved; undoing', {
        agentId: agent.id,
        error: message(error),
      });
      await this.releaseQuietly(workspaceId, adopted);
      await this.quietly('forget the managed record', () => this.deps.store.delete(agent.id));
      await this.quietly('start Console’s watcher again', () =>
        this.deps.machine.startConsoleWatchers(agent, subagents)
      );
      throw new Error(
        `Could not stop Console’s watcher for ${agent.name}, so it stays with this Console: ${message(error)}`,
        { cause: error }
      );
    }

    const identities = this.handoffIdentities(moving.identities);
    const stashed: MovedIdentity[] = [];
    let ranOnController = false;
    try {
      this.stage(agent.id, 'preparing-machine');
      const fresh = await this.deps.machine.handoff(agent, { op: 'fresh-start', identities });
      if (fresh.cleared.length)
        this.deps.log.info('Cleared room placements an earlier stay left on the controller', {
          agentId: agent.id,
          cleared: fresh.cleared,
        });
      this.stage(agent.id, 'releasing');
      for (const identity of moving.identities) {
        const had = await this.deps.credentials.stash(agent, identity);
        identity.credentialsStashed = had;
        stashed.push(identity);
        await this.deps.store.set({ ...record, identities: moving.identities });
      }
      ranOnController = !moving.stoppedByHand;
      if (!moving.stoppedByHand)
        for (const identity of moving.identities)
          await this.deps.management.setDesiredState(
            workspaceId,
            identity.switchAgentId,
            'running'
          );
    } catch (error) {
      this.deps.log.error('Could not finish moving an agent to its controller; undoing', {
        agentId: agent.id,
        error: message(error),
      });
      await this.undoMove(agent, target, record, identities, stashed, subagents, ranOnController);
      throw new Error(
        `Could not move ${agent.name}, so it stays with this Console: ${message(error)}`,
        { cause: error }
      );
    }
    this.deps.log.info('Moved an agent onto its controller', {
      agentId: agent.id,
      controllerId: target.controllerId,
      subagents: subagents.length,
    });
  }

  private async undoMove(
    agent: MigrationAgent,
    target: ResolvedTarget,
    record: ManagedAgentRecord,
    identities: HandoffIdentity[],
    stashed: MovedIdentity[],
    subagents: SubagentRef[],
    ranOnController: boolean
  ): Promise<void> {
    await this.releaseQuietly(
      record.workspaceId,
      record.identities.map((identity) => identity.switchAgentId)
    );
    try {
      await this.waitForControllerStop(agent, identities);
      // Only once the controller may have answered something: otherwise Console's
      // watcher goes on from where it stopped, and takes what arrived meanwhile.
      if (ranOnController) await this.deps.machine.handoff(agent, { op: 'come-back', identities });
    } catch (error) {
      this.deps.log.error('The controller did not stop an agent after a failed move', {
        agentId: agent.id,
        controllerId: target.controllerId,
        error: message(error),
      });
    }
    for (const identity of stashed)
      if (identity.credentialsStashed)
        await this.quietly('restore the credentials file', () =>
          this.deps.credentials.restore(agent, identity)
        );
    await this.quietly('forget the managed record', () => this.deps.store.delete(agent.id));
    await this.quietly('start Console’s watcher again', () =>
      this.deps.machine.startConsoleWatchers(agent, subagents)
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
    const resumed = await this.deps.machine.handoff(agent, { op: 'come-back', identities });
    this.deps.log.info('Console’s watcher goes on from where the controller’s stopped', {
      agentId: agent.id,
      resumed: resumed.resumed,
    });
    for (const identity of record.identities) await this.deps.credentials.restore(agent, identity);
    await this.deps.store.delete(agent.id);
    const subagents = record.identities
      .filter((identity) => identity.subagent !== null)
      .map((identity) => ({ name: identity.subagent!, switchAgentId: identity.switchAgentId }));
    await this.deps.machine.startConsoleWatchers(agent, subagents);
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

  /**
   * Waits until none of these identities' sessions is mid-turn, so a move
   * never interrupts one. Rechecked right before the caller acts.
   */
  private async waitForIdle(agent: MigrationAgent, switchAgentIds: string[]): Promise<void> {
    this.stage(agent.id, 'checking');
    const wait = new AbortController();
    this.waits.set(agent.id, wait);
    const deadline = this.deps.now() + this.deps.turnWaitMs;
    try {
      for (;;) {
        const busy = (await this.deps.machine.sessions(agent, switchAgentIds)).filter(
          (session) => session.busy
        );
        if (!busy.length) return;
        if (this.deps.now() >= deadline)
          throw new MigrationBlockedError(
            `${agent.name} is still working (${busy.map((session) => session.sessionId).join(', ')}). ${IDLE_RULE} Try again once it is idle.`
          );
        this.stage(
          agent.id,
          'waiting-for-turn',
          busy.map((session) => session.sessionId)
        );
        try {
          await this.deps.sleep(this.deps.pollMs, wait.signal);
        } catch (error) {
          if (wait.signal.aborted) throw new MigrationCancelledError();
          throw error;
        }
        if (wait.signal.aborted) throw new MigrationCancelledError();
      }
    } finally {
      this.waits.delete(agent.id);
    }
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

  private stage(agentId: string, stage: MigrationStage, busySessions: string[] = []): void {
    const current = this.operations.get(agentId);
    if (!current) return;
    current.stage = stage;
    current.busySessions = busySessions;
    this.deps.emit({
      agentId,
      runner: current.kind === 'moving' ? 'console' : 'managed',
      operation: { ...current, busySessions: [...busySessions] },
    });
  }

  private async exclusive(
    agentId: string,
    kind: MigrationOperation['kind'],
    task: () => Promise<void>
  ): Promise<void> {
    if (this.operations.has(agentId))
      throw new MigrationBlockedError('This agent is already being moved.');
    this.operations.set(agentId, { kind, stage: 'checking', busySessions: [] });
    try {
      await task();
    } finally {
      this.operations.delete(agentId);
      const record = await this.deps.store.get(agentId).catch(() => null);
      this.deps.emit({ agentId, runner: record ? 'managed' : 'console', operation: null });
    }
  }
}
