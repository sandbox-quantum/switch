/**
 * Moving an agent Console runs itself onto an agents controller, so that
 * Switch's agent management runs it instead: "Move to managed", and back with
 * "Stop managing".
 *
 * A local agent moves onto this computer's embedded controller; an agent on
 * an SSH host moves onto the controller Console installed on that host.
 */

/** Where an agent's watcher runs, as far as this Console is concerned. */
export type AgentRunner = 'console' | 'managed';

/** The machine an agent moves to, or runs on. */
export type MigrationTarget =
  | { kind: 'this-computer'; serverId: string; machineName: string | null }
  | { kind: 'ssh-host'; sshHost: string; serverId: string; machineName: string | null };

/** The step a move or a return is at, so the UI can say what it is waiting for. */
export type MigrationStage =
  | 'checking'
  /** A session of the agent is mid-turn; the move waits for the turn to end. */
  | 'waiting-for-turn'
  | 'adopting'
  | 'stopping-console-watcher'
  /** Clearing what an earlier stay left on the machine, so its rooms start afresh there. */
  | 'preparing-machine'
  | 'releasing'
  | 'waiting-for-controller'
  | 'restoring-console-watcher';

export type MigrationOperation = {
  kind: 'moving' | 'returning';
  stage: MigrationStage;
  /** The sessions holding the move up while it waits for a turn to end. */
  busySessions: string[];
};

/** What the controller last reported for a moved agent. */
export type ManagedActual = {
  process: string;
  attached: boolean;
  reason: string | null;
  detail: string | null;
};

export type ManagedPlacement = {
  controllerId: string;
  movedAt: string;
  /** Null until Switch could be asked, or when it could not. */
  desiredState: 'running' | 'stopped' | null;
  actual: ManagedActual | null;
  /** Why Switch could not be asked, or null. */
  unreadable: string | null;
};

export type AgentMigrationState = {
  agentId: string;
  runner: AgentRunner;
  operation: MigrationOperation | null;
  /** Where it would move to, or where it runs now. Null when there is no such machine. */
  target: MigrationTarget | null;
  /**
   * Why the action offered now ("Move to managed", or "Stop managing" once
   * moved) cannot run, or null when it can.
   */
  blocker: string | null;
  /**
   * The target machine is not running managed agents yet, and Console can turn
   * it on: this computer's controller for the agent's server, or an SSH host's.
   */
  canEnableTarget: boolean;
  /** Set on a subagent watched under its parent: it moves with the parent, never alone. */
  movesWithParent: string | null;
  /** The subagents watched under this agent, which move with it. */
  subagents: string[];
  /**
   * What the managed definition does not carry over from the agent's Console
   * configuration. Empty when nothing is lost.
   */
  notCarried: string[];
  managed: ManagedPlacement | null;
};

/** One agent of a "Move all" that did not move, and why. */
export type MoveAllResult = {
  moved: { agentId: string; name: string }[];
  skipped: { agentId: string; name: string; reason: string }[];
  failed: { agentId: string; name: string; message: string }[];
};

export type AgentMigrationEvent = {
  agentId: string;
  runner: AgentRunner;
  operation: MigrationOperation | null;
};

/**
 * The rule a move follows about work in progress, said once so the UI and the
 * errors agree.
 */
export const IDLE_RULE =
  'An agent moves only between turns: if one of its sessions is working, the move waits for that turn to end and never interrupts it.';

/**
 * What happens to an agent's conversations when it moves. A session's saved
 * state is bound to the address it reaches Switch at, and a controller's
 * sessions reach it through the controller's local relay, so a session cannot
 * be resumed across the move.
 */
export const SESSIONS_ON_MOVE =
  'Conversations do not move with it: the next message in each room starts a fresh session on the machine. Its sessions here stay in Console to read.';

export const SESSIONS_ON_RETURN =
  'Each room picks up the conversation it had in this Console before the move; what was said while it was managed stays in the sessions the machine ran.';
