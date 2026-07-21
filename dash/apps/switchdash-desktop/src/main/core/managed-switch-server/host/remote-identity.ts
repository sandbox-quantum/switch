/**
 * Deterministic, filesystem- and secret-key-safe slug for an SSH host alias, so
 * a host's persisted metadata and secret bundle live at stable, collision-free
 * paths/keys. (Aliases can contain characters not safe in a path or key.)
 */
export function hostSlug(sshHost: string): string {
  return sshHost.replace(/[^A-Za-z0-9_.-]/g, '_');
}

/** Encrypted-store key holding a remote host's stack secret bundle. */
export function remoteSecretsKey(sshHost: string): string {
  return `remote-switch-server:${hostSlug(sshHost)}:secrets`;
}
