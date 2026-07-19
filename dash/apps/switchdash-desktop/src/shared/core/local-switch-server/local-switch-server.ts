/**
 * Shared types for local-server mode: switchdash runs a full Switch stack on the
 * user's machine via `docker compose`, using the standalone compose artifact
 * bundled into the app (pinned to COMPATIBLE_SWITCH_VERSION). The main process
 * owns the container lifecycle; the renderer drives it through these types and
 * subscribes to the status event.
 */

/** Lifecycle phase of the managed local stack. */
export type LocalServerPhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

/** Whether Docker is usable on this machine. `daemon-down` means the binary is
 * installed but the daemon is not reachable (Docker Desktop not running). */
export type DockerAvailability =
  | { available: true; version: string }
  | { available: false; reason: 'not-installed' | 'daemon-down'; detail: string };

/** Snapshot of the managed local server, emitted on every transition. */
export type LocalServerStatus = {
  phase: LocalServerPhase;
  /** The registered server's id once the stack is up, else null. */
  serverId: string | null;
  /** The pinned switch-core version this build runs. */
  version: string;
  /** Human-readable current step (e.g. "Pulling images…"), or null. */
  message: string | null;
  /** Populated only when `phase === 'error'`. */
  error: string | null;
};

/** Outcome of a start request. `docker-unavailable` is separated from generic
 * errors so the UI can point the user at installing / starting Docker. */
export type StartLocalServerResult =
  | { kind: 'started'; serverId: string }
  | { kind: 'docker-unavailable'; reason: 'not-installed' | 'daemon-down'; detail: string }
  | { kind: 'error'; message: string };
