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

/**
 * How the switch-core version a stack is actually deployed at relates to the
 * version this build of switchdash pins.
 *
 * - `upgrade` — the stack is behind; restarting re-pulls and migrates forward.
 * - `downgrade` — the stack is AHEAD. Unsafe: its database has already migrated
 *   to a newer schema and switch-core cannot roll one back, so the stack must
 *   not be restarted against the older pin.
 * - `unknown` — one of the two is not a comparable semver. Neither direction can
 *   be proven, so it is surfaced rather than assumed safe.
 */
export type SwitchVersionDriftDirection = 'upgrade' | 'downgrade' | 'unknown';

/** A mismatch between the deployed switch-core version and this build's pin. */
export type SwitchVersionDrift = {
  /** The version the stack is actually deployed at. */
  deployed: string;
  /** The version this build of switchdash pins. */
  expected: string;
  direction: SwitchVersionDriftDirection;
};

/**
 * Why a downgrade is refused, in one message — shared by the main process (as
 * the status `error` when a start is blocked) and the renderer (as the drift
 * banner) so both say the same thing.
 *
 * Kept to two sentences, but both ways out stay in: a user who is not told
 * that updating switchdash fixes this will reach for Reset and lose their data.
 */
export function switchVersionDowngradeMessage(deployed: string, expected: string): string {
  return (
    `Runs switch-core ${deployed}; this app pins ${expected}. Its database has already migrated ` +
    `forward and switch-core can't roll back — update switchdash to a build with switch-core ` +
    `${deployed} or newer, or reset the stack (deletes its data).`
  );
}

/** Snapshot of the managed local server, emitted on every transition. */
export type LocalServerStatus = {
  phase: LocalServerPhase;
  /** The registered server's id once the stack is up, else null. */
  serverId: string | null;
  /** The pinned switch-core version this build runs. */
  version: string;
  /** The version the stack on the host is actually deployed at, once observed.
   * Null when nothing is deployed yet or it could not be read. */
  deployedVersion: string | null;
  /** Set when {@link deployedVersion} differs from {@link version}, else null. */
  drift: SwitchVersionDrift | null;
  /** Human-readable current step (e.g. "Pulling images…"), or null. */
  message: string | null;
  /** Populated only when `phase === 'error'`. */
  error: string | null;
};

/** Outcome of a start request. `docker-unavailable` and `version-downgrade` are
 * separated from generic errors so the UI can point the user at installing /
 * starting Docker, or explain why an older build refuses to take over a stack
 * that has already migrated forward. */
export type StartLocalServerResult =
  | { kind: 'started'; serverId: string }
  | { kind: 'docker-unavailable'; reason: 'not-installed' | 'daemon-down'; detail: string }
  | { kind: 'version-downgrade'; deployed: string; expected: string }
  | { kind: 'error'; message: string };
