// Builds the ssh2 `hostVerifier` from the host's OpenSSH known_hosts state.
import type { HostVerifier } from 'ssh2';
import {
  checkHostKey,
  defaultKnownHostsDeps,
  formatKnownHostsLine,
  readKeyType,
  readKnownHosts,
  rememberHostKey,
  type KnownHostsDeps,
} from './known-hosts';

/** The StrictHostKeyChecking values OpenSSH accepts, lowercased. */
export type StrictHostKeyChecking = 'yes' | 'no' | 'off' | 'ask' | 'accept-new';

export interface HostKeyPolicy {
  host: string;
  port: number;
  /** known_hosts files to read, in the order OpenSSH would read them. */
  knownHostsFiles: string[];
  /** The file a first-use key is written to. Omit to never write. */
  writeToFile?: string;
  strictHostKeyChecking: StrictHostKeyChecking;
  hashKnownHosts: boolean;
  onDebug?: (message: string) => void;
}

export function normalizeStrictHostKeyChecking(value: string | undefined): StrictHostKeyChecking {
  switch (value?.trim().toLowerCase()) {
    case 'yes':
      return 'yes';
    case 'no':
      return 'no';
    case 'off':
      return 'off';
    case 'accept-new':
      return 'accept-new';
    default:
      // OpenSSH's default is `ask`, and anything unrecognised is treated as it.
      return 'ask';
  }
}

/**
 * Trust an unknown host on first use?
 *
 * `yes` refuses, matching OpenSSH. `no`/`off`/`accept-new` accept and record the
 * key, also matching OpenSSH. `ask` would prompt, which this path cannot do: it
 * runs inside a pooled connection with no window to prompt from, and refusing
 * would make every first connection fail. It records the key instead, so the
 * host is pinned from then on and a later change is refused.
 */
function acceptsUnknownHost(strict: StrictHostKeyChecking): boolean {
  return strict !== 'yes';
}

export function createHostVerifier(
  policy: HostKeyPolicy,
  depsOverride: Partial<KnownHostsDeps> = {}
): HostVerifier {
  const deps: KnownHostsDeps = { ...defaultKnownHostsDeps(), ...depsOverride };
  const debug = policy.onDebug ?? (() => {});
  const where = `${policy.host}:${policy.port}`;

  return (key, verify) => {
    void (async () => {
      let accepted: boolean;
      try {
        const entries = await readKnownHosts(policy.knownHostsFiles, deps);
        const verdict = checkHostKey(entries, policy.host, policy.port, key);

        if (verdict.kind === 'match') {
          debug(`host key for ${where} matches known_hosts`);
          accepted = true;
        } else if (verdict.kind === 'revoked') {
          debug(`host key for ${where} is revoked in known_hosts, refusing`);
          accepted = false;
        } else if (verdict.kind === 'mismatch') {
          // The stored key changed. Either the host was rebuilt or someone is
          // in the middle, and we cannot tell which, so refuse either way.
          debug(`host key for ${where} does NOT match known_hosts, refusing`);
          accepted = false;
        } else if (acceptsUnknownHost(policy.strictHostKeyChecking)) {
          await recordFirstUse(policy, key, deps, debug);
          accepted = true;
        } else {
          debug(`host key for ${where} is unknown and StrictHostKeyChecking=yes, refusing`);
          accepted = false;
        }
      } catch (error) {
        // Fail closed: an unreadable known_hosts must not become blind trust.
        debug(`host key check for ${where} failed: ${String(error)}`);
        accepted = false;
      }
      verify(accepted);
    })();
  };
}

async function recordFirstUse(
  policy: HostKeyPolicy,
  key: Buffer,
  deps: KnownHostsDeps,
  debug: (message: string) => void
): Promise<void> {
  const where = `${policy.host}:${policy.port}`;
  const keyType = readKeyType(key);
  if (!policy.writeToFile || !keyType) {
    debug(`host key for ${where} accepted on first use but not recorded`);
    return;
  }
  const line = formatKnownHostsLine(policy.host, policy.port, keyType, key, {
    hash: policy.hashKnownHosts,
  });
  const written = await rememberHostKey(policy.writeToFile, line, deps);
  debug(
    written
      ? `host key for ${where} accepted on first use and added to ${policy.writeToFile}`
      : `host key for ${where} accepted on first use but ${policy.writeToFile} is not writable`
  );
}
