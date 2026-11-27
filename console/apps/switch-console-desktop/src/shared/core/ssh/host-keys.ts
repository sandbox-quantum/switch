/**
 * SSH host key verification, as the renderer sees it.
 *
 * Every SSH connection Switch Console makes checks the host's key against the
 * user's own known_hosts files and Console's own record. A key that is not on
 * record, or differs from the one that is, refuses the connection; the user
 * then decides here. The main process keeps the key itself, so trusting is
 * always trusting the key the host actually presented, never one the renderer
 * names.
 */

import { defineEvent } from '@shared/lib/ipc/events';

/**
 * - `unknown`: no key is on record for the host.
 * - `changed`: keys are on record for the host, and the presented one is not
 *   among them. Someone may be intercepting the connection.
 * - `revoked`: the presented key is marked `@revoked` in a known_hosts file.
 */
export type HostKeyProblemKind = 'unknown' | 'changed' | 'revoked';

export type KnownHostKey = {
  /** The key's algorithm name, e.g. `ssh-ed25519`. */
  keyType: string;
  /** OpenSSH-style SHA256 fingerprint, `SHA256:…`. */
  fingerprint: string;
  /** Where it is recorded: a known_hosts path and line number. */
  source: string;
};

export type HostKeyProblem = {
  /** The `~/.ssh/config` Host alias the connection was for. */
  sshHost: string;
  /**
   * The name the key is recorded under: the resolved host name, `[host]:port`
   * for a port other than 22, or the alias's `HostKeyAlias`.
   */
  hostKeyName: string;
  kind: HostKeyProblemKind;
  keyType: string;
  fingerprint: string;
  /** Keys already on record for the host; empty for an unknown host. */
  known: KnownHostKey[];
  /**
   * Why the key cannot be trusted from Switch Console at all, or null when it
   * can. Set for a revoked key, and for an unknown host whose SSH config says
   * `StrictHostKeyChecking yes`.
   */
  trustRefusal: string | null;
};

/** The host keys waiting for a decision, pushed whole on every change. */
export const hostKeyProblemsChannel = defineEvent<HostKeyProblem[]>('ssh:host-key-problems');

/** OpenSSH's short label for a key type: `ED25519`, `ECDSA`, `RSA`. */
export function keyTypeLabel(keyType: string): string {
  if (keyType === 'ssh-ed25519') return 'ED25519';
  if (keyType.startsWith('ecdsa-sha2-')) return 'ECDSA';
  if (keyType === 'ssh-rsa') return 'RSA';
  if (keyType === 'ssh-dss') return 'DSA';
  return keyType;
}
