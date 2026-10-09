/**
 * Modes for the files and directories an agent host writes into its state.
 *
 * Private to the agent's own user by default. An agents controller that runs
 * each agent as a Linux user of its own sets `SWITCH_HOST_SHARED_GROUP=1`: the
 * agent's primary group is then one the controller belongs to and no other
 * user does, so what the agent host writes is group-readable for the
 * controller to observe (health, owner and failure records) and still closed
 * to everyone else. No set-id bit is ever asked for: such an agent runs with
 * `RestrictSUIDSGID=`.
 */
export const SHARED_GROUP_ENV = 'SWITCH_HOST_SHARED_GROUP';

export function sharedGroupEnabled(): boolean {
  return process.env[SHARED_GROUP_ENV] === '1';
}

/** `privateMode`, or with the owner's read given to the group under the shared group (0o600 → 0o640). */
export function fileMode(privateMode: number): number {
  if (!sharedGroupEnabled()) return privateMode;
  return privateMode | ((privateMode & 0o400) >> 3);
}

/**
 * `privateMode`, or with the owner's bits given to the group under the shared
 * group (0o700 → 0o770), so the controller can also clear what it reads.
 */
export function dirMode(privateMode: number): number {
  if (!sharedGroupEnabled()) return privateMode;
  return privateMode | ((privateMode & 0o700) >> 3);
}
