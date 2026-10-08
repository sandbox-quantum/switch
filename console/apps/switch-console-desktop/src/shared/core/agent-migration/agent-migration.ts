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
  /** Telling the rooms where a turn was running that it is cut. */
  | 'telling-rooms'
  | 'adopting'
  | 'stopping-console-watcher'
  | 'releasing'
  | 'waiting-for-controller'
  | 'restoring-console-watcher';

export type MigrationOperation = {
  kind: 'moving' | 'returning';
  stage: MigrationStage;
};

/** What the controller last reported for a moved agent. */
export type ManagedActual = {
  process: string;
  attached: boolean;
  reason: string | null;
  detail: string | null;
};

/**
 * Whether the machine a moved agent was placed on can run it now, from
 * Console's own look at that machine's controller. The controller's last
 * report on the agent counts only while the controller runs.
 */
export type ManagedMachine =
  | { kind: 'running' }
  | { kind: 'stopped'; reason: string }
  | { kind: 'unknown'; reason: string }
  /** Switch removed the controller it was placed on, or Console no longer has it: nothing runs the agent. */
  | { kind: 'removed' };

export type ManagedPlacement = {
  controllerId: string;
  movedAt: string;
  machine: ManagedMachine;
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
  /**
   * What the managed definition does not carry over from the agent's Console
   * configuration. Empty when nothing is lost.
   */
  notCarried: string[];
  managed: ManagedPlacement | null;
};

/** A move that went through. `untold` lists the rooms where a turn was cut that could not be told so, and why. */
export type MoveToManagedResult = { untold: { roomId: string; reason: string }[] };

/** An agent the automatic move to managed could not move, and why. */
export type MigrationProblem = {
  agentId: string;
  name: string;
  /** "this computer", or the SSH host's name. */
  machine: string;
  message: string;
};

/** The controller one machine runs for one server, as the last automatic pass found it. */
export type MigrationControllerState =
  | { kind: 'ready' }
  /** The server cannot take this Console's controller; its agents are left as they are. */
  | { kind: 'incompatible'; reason: string }
  | { kind: 'failed'; reason: string };

/** One machine's agents for one server: how many moved, and what keeps the rest. */
export type MigrationMachine = {
  /** "this computer", or the SSH host's name. */
  machine: string;
  sshHost: string | null;
  serverId: string;
  total: number;
  moved: number;
  /** Null until a pass has looked at the machine. */
  controller: MigrationControllerState | null;
  checkedAt: string | null;
  problems: MigrationProblem[];
};

/** Where the automatic move to managed agents stands. */
export type MigrationOverview = {
  machines: MigrationMachine[];
  /** Agents left as they are: someone else's, or on a server without agent management. */
  leftAlone: number;
  /** Agents whose server could not be asked whether they can move; tried again later. */
  unasked: number;
  running: boolean;
  lastPassAt: string | null;
};

export type AgentMigrationEvent = {
  agentId: string;
  runner: AgentRunner;
  operation: MigrationOperation | null;
};

/**
 * What a move or a return does to work in progress and to conversations, said
 * once so the UI and the errors agree.
 */
export const MOVE_RULE =
  'It moves straight away: a turn still running is cut, and its room is asked to send the request again. Conversations do not move with it: the next message in each room starts a fresh conversation.';

/**
 * A machine cannot be turned off or removed while it runs agents this Console
 * moved onto it: Switch keeps a managed agent on its controller after the
 * controller is gone, where nothing would run it. The message says what to do
 * instead, so it is shown as is.
 */
export class MovedAgentsHereError extends Error {
  readonly agents: string[];

  constructor(message: string, agents: string[]) {
    super(message);
    this.name = 'MovedAgentsHereError';
    this.agents = agents;
  }
}

/**
 * Whether a new agent created on a machine runs as a managed agent there: on
 * a server with agent management, the create form places every agent it makes
 * on this computer or an SSH host through that machine's controller.
 */
export type NewAgentMachine =
  /** The server does not run agent management: the agent is one Console runs. */
  | { management: false }
  | {
      management: true;
      /** The machine, with the name its controller enrolled under; null when there is none. */
      target: MigrationTarget | null;
      /** Why the machine cannot take a managed agent now, or null when it can. */
      blocker: string | null;
      /** The machine does not run managed agents yet, and Console can turn that on. */
      canEnable: boolean;
    };
