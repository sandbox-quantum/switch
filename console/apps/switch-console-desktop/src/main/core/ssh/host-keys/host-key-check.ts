import { keyTypeLabel, type HostKeyProblem } from '@shared/core/ssh/host-keys';
import {
  fingerprintOf,
  hostKeyName,
  keyTypeOf,
  lookupHostKey,
  parseKnownHosts,
  preferredServerHostKeyAlgorithms,
  type KnownHostsLine,
  type ServerHostKeyAlgorithm,
} from './known-hosts';

/** `StrictHostKeyChecking` as `ssh -G` reports it. */
export type StrictHostKeyChecking = 'yes' | 'ask' | 'accept-new' | 'no';

/** What a connection's host key is checked against, resolved from the alias's SSH config. */
export type HostKeyTarget = {
  /** The `~/.ssh/config` alias, for naming the host to the user. */
  sshHost: string;
  hostname: string;
  port: number;
  hostKeyAlias: string | undefined;
  userKnownHostsFiles: string[];
  globalKnownHostsFiles: string[];
  strictHostKeyChecking: StrictHostKeyChecking;
};

function describeKey(keyType: string, fingerprint: string): string {
  return `${keyTypeLabel(keyType)} key ${fingerprint}`;
}

function hostKeyMessage(problem: HostKeyProblem): string {
  const host = `'${problem.sshHost}' (${problem.hostKeyName})`;
  const presented = describeKey(problem.keyType, problem.fingerprint);
  switch (problem.kind) {
    case 'revoked':
      return `The SSH host key ${host} presented, ${presented}, is marked @revoked in ${problem.known
        .map((key) => key.source)
        .join(', ')}. Switch Console will not connect with it.`;
    case 'changed':
      return `The SSH host key for ${host} has changed, so Switch Console refused to connect. The host presented ${presented}; the key on record is ${problem.known
        .map((key) => `${describeKey(key.keyType, key.fingerprint)} (${key.source})`)
        .join(
          ', '
        )}. Someone may be intercepting the connection, or the host may have been reinstalled. Confirm the new key with whoever runs the host before accepting it in Switch Console.`;
    case 'unknown':
      return problem.trustRefusal
        ? `The SSH host key for ${host} is not in your known_hosts. ${problem.trustRefusal}`
        : `The SSH host key for ${host} is not known: it is not in your known_hosts and Switch Console has not trusted it before. The host presented ${presented}. Confirm it in Switch Console to connect.`;
  }
}

/** A connection refused because of the host's key. Never retried on its own. */
export class SshHostKeyError extends Error {
  readonly problem: HostKeyProblem;

  constructor(problem: HostKeyProblem) {
    super(hostKeyMessage(problem));
    this.name = 'SshHostKeyError';
    this.problem = problem;
  }
}

export type PreparedHostKeyCheck = {
  /** ssh2 `algorithms.serverHostKey`: the types on record for the host first. */
  serverHostKeyAlgorithms: ServerHostKeyAlgorithm[];
  /** ssh2 `hostVerifier`: accepts only a key on record for the host. */
  hostVerifier: (key: Buffer) => boolean;
  /** Why the verifier refused the last key it saw, if it did. */
  rejection: () => SshHostKeyError | undefined;
};

export type HostKeyCheckDeps = {
  /** A known_hosts file's text, or null when there is no such file. */
  readKnownHostsFile: (path: string) => Promise<string | null>;
  consoleKnownHosts: { read: () => Promise<KnownHostsLine[]> };
  /** Hand a refused key to whatever asks the user about it. */
  reportProblem: (problem: HostKeyProblem, key: Buffer) => void;
  /** The host's key checked out. */
  reportVerified: (sshHost: string) => void;
};

/**
 * Build the host key check for one connection attempt.
 *
 * The key is checked against the user's known_hosts files — the ones their SSH
 * config names, hashed entries and `[host]:port` included — and the keys the
 * user trusted from Switch Console. Only a key on record connects. Anything
 * else is refused and reported, and nothing is ever added here: a key is
 * trusted only when the user says so (`HostKeyTrustService.trust`). So a
 * background reconnect can only ever use a decision already made.
 *
 * `StrictHostKeyChecking yes` is honoured by not offering to trust an unknown
 * host. `no` and `accept-new` are not: Switch Console never accepts a key the
 * user has not confirmed.
 */
export async function prepareHostKeyCheck(
  target: HostKeyTarget,
  deps: HostKeyCheckDeps
): Promise<PreparedHostKeyCheck> {
  const name = hostKeyName(target.hostname, target.port, target.hostKeyAlias);
  const files = [...target.userKnownHostsFiles, ...target.globalKnownHostsFiles];
  const fromFiles = await Promise.all(
    files.map(async (path) => {
      const text = await deps.readKnownHostsFile(path);
      return text === null ? [] : parseKnownHosts(text, path);
    })
  );
  const lines = [...fromFiles.flat(), ...(await deps.consoleKnownHosts.read())];

  let rejection: SshHostKeyError | undefined;
  return {
    serverHostKeyAlgorithms: preferredServerHostKeyAlgorithms(lines, name),
    hostVerifier: (key) => {
      const lookup = lookupHostKey(lines, name, key);
      if (lookup.status === 'match') {
        rejection = undefined;
        deps.reportVerified(target.sshHost);
        return true;
      }
      const problem: HostKeyProblem = {
        sshHost: target.sshHost,
        hostKeyName: name,
        kind: lookup.status,
        keyType: keyTypeOf(key),
        fingerprint: fingerprintOf(key),
        known: lookup.status === 'unknown' ? [] : lookup.known,
        trustRefusal:
          lookup.status === 'revoked'
            ? 'A revoked key cannot be trusted. Remove the @revoked line only if you are sure the key is safe again.'
            : lookup.status === 'unknown' && target.strictHostKeyChecking === 'yes'
              ? `Your SSH config sets StrictHostKeyChecking yes for '${target.sshHost}', so Switch Console will not offer to trust a new key. Add it to your known_hosts yourself (for example with ssh -o StrictHostKeyChecking=ask ${target.sshHost}, checking the fingerprint), then retry.`
              : null,
      };
      rejection = new SshHostKeyError(problem);
      deps.reportProblem(problem, key);
      return false;
    },
    rejection: () => rejection,
  };
}
