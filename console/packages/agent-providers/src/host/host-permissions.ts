import { chmod, lstat } from 'node:fs/promises';

/**
 * Modes for the files and directories an agent host writes into its state.
 *
 * Private to the agent's own user by default. A host run as a systemd unit by
 * an agents controller that is a different user sets
 * `SWITCH_HOST_SHARED_GROUP=1`: its state root is owned by the controller and
 * group-owned by the agents' group with the setgid bit, so what the agent
 * writes there is group-readable for the controller to observe — health,
 * control port, owner and failure records — and still closed to everyone else.
 */
export const SHARED_GROUP_ENV = 'SWITCH_HOST_SHARED_GROUP';

export function sharedGroupEnabled(): boolean {
  return process.env[SHARED_GROUP_ENV] === '1';
}

/** `privateMode` as is, or with the owner's read and execute given to the group under the shared group (0o600 → 0o640). */
export function fileMode(privateMode = 0o600): number {
  if (!sharedGroupEnabled()) return privateMode;
  return privateMode | ((privateMode & 0o500) >> 3);
}

/**
 * `privateMode` as is, or setgid with group read/traverse added under the
 * shared group (0o700 → 0o2750), so what is created inside keeps the group.
 */
export function dirMode(privateMode = 0o700): number {
  if (!sharedGroupEnabled()) return privateMode;
  return 0o2000 | privateMode | ((privateMode & 0o500) >> 3);
}

/**
 * Under the shared group, gives the group write on a directory that holds a
 * provider login the agent host wrote, so the controller can remove the login
 * when it is withdrawn or the agent is removed. Never through a link.
 */
export async function shareLoginDirectory(path: string): Promise<void> {
  if (!sharedGroupEnabled()) return;
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error('Provider authentication directory must be a directory, not a link.');
  if ((info.mode & 0o070) !== 0o070) await chmod(path, (info.mode & 0o7777) | 0o070);
}
