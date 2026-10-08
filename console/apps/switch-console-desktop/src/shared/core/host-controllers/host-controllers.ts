import type { PlacedManagedAgent } from '@shared/core/embedded-controller/embedded-controller';

/**
 * An SSH host as a machine: the headless agents controller Console installs
 * and runs there, enrolled with one Switch server, so that server's agent
 * management can run agents on the host.
 */

/** How the controller is kept running on the host. */
export type HostSupervision = 'systemd' | 'detached';

export type HostControllerEnrollment = {
  controllerId: string;
  /** The machine name it enrolled under: the host's own host name. */
  name: string;
  workspaceId: string;
  supervision: HostSupervision;
  enrolledAt: string;
};

export type HostControllerPhase =
  | { kind: 'off' }
  | { kind: 'installing'; step: string }
  | { kind: 'removing' }
  | { kind: 'error'; message: string };

/** The controller process on the host, as the host reports it. */
export type HostControllerProcess =
  | { kind: 'running' }
  /** Not running: `state` is the supervisor's or systemd's word for it, `log` its last lines. */
  | { kind: 'stopped'; state: string; code: number | null; log: string }
  | { kind: 'unknown'; reason: string };

export type HostControllerRemote =
  | {
      kind: 'ok';
      controller: {
        state: 'online' | 'offline' | 'unknown' | 'revoked';
        lastSeenAt: string | null;
      } | null;
      agents: PlacedManagedAgent[];
    }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

export type HostControllerOverview = {
  sshHost: string;
  serverId: string;
  enrollment: HostControllerEnrollment | null;
  /** What Console is doing about it now; `off` when nothing is in flight. */
  phase: HostControllerPhase;
  /** Null when not enrolled. */
  process: HostControllerProcess | null;
  /** The server's side. Null when there was no workspace to ask in. */
  remote: HostControllerRemote | null;
  /** The Console agents moved onto it, by name. */
  movedAgents: string[];
};

export type HostControllerStateEvent = { sshHost: string; serverId: string };
