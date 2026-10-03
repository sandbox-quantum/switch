/**
 * "Run managed agents on this computer": this Console enrolled as an agents
 * controller of kind `console` on a Switch server, running the agents that
 * server's agent management places on this machine.
 */

/** Where the embedded controller process stands, as this Console sees it. */
export type EmbeddedControllerPhase =
  | { kind: 'off' }
  | { kind: 'enrolling' }
  /** The controller process is running. Whether it reaches Switch is the server's to say. */
  | { kind: 'running'; since: string }
  /** It exited on its own and is started again at `retryAt`. */
  | { kind: 'restarting'; attempt: number; retryAt: string; lastExit: string }
  /** Being turned off: revoking it on the server and stopping it. */
  | { kind: 'stopping' }
  /** The server revoked it, from the Machines page or elsewhere. Kept until dismissed or turned on again. */
  | { kind: 'removed'; at: string }
  /** Another copy of this controller connected and took over; this one is not restarted. */
  | { kind: 'taken_over'; at: string }
  | { kind: 'error'; message: string };

export type EmbeddedControllerEnrollment = {
  controllerId: string;
  /** The machine name it enrolled under: this computer's host name. */
  name: string;
  /** The workspace it was enrolled in. A controller belongs to one tenant. */
  workspaceId: string;
  enrolledAt: string;
};

/** One of the managed agents placed on this computer, as the server reports it. */
export type PlacedManagedAgent = {
  agentId: string;
  name: string;
  displayName: string | null;
  provider: string;
  desiredState: 'running' | 'stopped';
  /** The controller's last report for it, or null when it has not reported one. */
  actual: {
    process: string;
    attached: boolean;
    reason: string | null;
    detail: string | null;
  } | null;
};

/** What the server says about this computer's controller and its agents. */
export type EmbeddedControllerRemote =
  | {
      kind: 'ok';
      /** Null when the server no longer lists this controller. */
      controller: { state: 'online' | 'unknown' | 'revoked'; lastSeenAt: string | null } | null;
      agents: PlacedManagedAgent[];
    }
  /** The server does not run agent management (its management routes are not mounted). */
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

export type EmbeddedControllerOverview = {
  serverId: string;
  /** Why this computer cannot run managed agents at all, or null when it can. */
  unsupportedReason: string | null;
  enrollment: EmbeddedControllerEnrollment | null;
  phase: EmbeddedControllerPhase;
  /** The server's side, read for the enrolled workspace, or for the one asked about when not enrolled. Null when there was no workspace to ask in. */
  remote: EmbeddedControllerRemote | null;
  /** The Console agents moved onto this computer's controller for the server, by name. */
  movedAgents: string[];
};

export type EmbeddedControllerStateEvent = {
  serverId: string;
  phase: EmbeddedControllerPhase;
};
