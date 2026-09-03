import { defineEvent } from '@shared/lib/ipc/events';

/**
 * The client-vs-host relationship for one agent's remote sidecar. Derived from
 * comparing what this client ships against what the host reports running.
 *
 * - `not-running` — no sidecar is up on the host.
 * - `up-to-date` — the host runs this client's exact build.
 * - `upgrade-available` — a different build is running and can be replaced now.
 *   Live sessions do not hold this back: they survive the restart, losing only
 *   a few seconds of room injection.
 * - `upgrade-pending` — a build one MAJOR ahead is ready but the sidecar has
 *   live sessions, so it is deferred until idle. A major is where the durable
 *   state schema may move, and a sidecar refuses to read state written by a
 *   newer one, so taking it under live sessions risks stranding them.
 * - `newer-on-host` — a newer Switch Console deployed the running sidecar. There is
 *   nothing to offer: replacing it would be a downgrade, and on a shared host
 *   two installs doing that to each other never converges.
 * - `other-install` — another Switch Console install deployed a different build of
 *   the SAME release. Neither build is the upgrade, so this one yields and the
 *   first deployer keeps it; Restart takes it over deliberately.
 * - `incompatible` — the host runs a protocol this client cannot speak; it must
 *   be replaced before this client can use it.
 */
export type SidecarVerdict =
  | 'not-running'
  | 'up-to-date'
  | 'upgrade-available'
  | 'upgrade-pending'
  | 'newer-on-host'
  | 'other-install'
  | 'incompatible';

/** Full per-agent sidecar status for the UI. */
export interface AgentSidecarStatus {
  agentId: string;
  running: boolean;
  verdict: SidecarVerdict;
  /** What this client ships. `version` is the human-readable `x.y`; `hash` is the
   * exact build fingerprint (what actually decides "is an upgrade available"). */
  clientHash: string;
  clientVersion: string;
  /** This install's deployer identity — what `deployedBy` is compared against. */
  clientDeployerId: string;
  /** What the host reports running (null when nothing is up). */
  deployedHash: string | null;
  deployedVersion: string | null;
  /** The install that deployed the running sidecar. Null when nothing is up, or
   * when it was deployed before installs identified themselves — unknown, which
   * is not the same as this one. */
  deployedBy: string | null;
  epoch: number | null;
  pid: number | null;
  liveSessions: number;
  /** Where it lives on the host. */
  repoDir: string;
  sshHost: string;
  credsSlug: string;
}

/** Pushed after any sidecar status change (probe, upgrade, restart, stop) so the
 * per-agent page updates live instead of polling. */
export const sidecarStatusChannel = defineEvent<AgentSidecarStatus>('remote-sidecar:status');
