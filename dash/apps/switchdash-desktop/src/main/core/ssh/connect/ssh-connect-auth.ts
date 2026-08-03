// Auth assembly: password, key, and agent selection with IdentitiesOnly
// filtering. Ported from switchdash and trimmed for switchdash (CHOO-1059): inputs
// are always transient, so password/passphrase come inline from the connect
// config rather than a credential-service lookup keyed by a persisted row id.
import ssh2, {
  BaseAgent,
  type ConnectConfig,
  type IdentityCallback,
  type ParsedKey,
  type PublicKeyEntry,
  type SignCallback,
  type SigningRequestOptions,
} from 'ssh2';
import type { SshConfig } from '@shared/core/ssh/ssh';
import {
  resolveAgentSocketFromResolved,
  type ResolvedSshConfig,
} from '../config/resolve-ssh-config';
import type { SshConnectDeps, SshConnectInput } from './resolve-ssh-connect-config';

const { utils } = ssh2;

export interface AuthResult {
  config: Partial<ConnectConfig>;
  agentSocketPath?: string;
}

function expandTilde(filePath: string): string {
  if (filePath === '~') return process.env.HOME ?? filePath;
  if (filePath.startsWith('~/')) return `${process.env.HOME ?? ''}${filePath.slice(1)}`;
  return filePath;
}

type AgentPublicKey = ParsedKey | Buffer | string | PublicKeyEntry;

function comparablePublicKey(key: AgentPublicKey): ParsedKey | Buffer | string {
  if (typeof key === 'object' && 'pubKey' in key) {
    const pubKey = key.pubKey;
    if (typeof pubKey === 'object' && 'pubKey' in pubKey) {
      return pubKey.pubKey;
    }
    return pubKey;
  }
  return key;
}

/**
 * Extends ssh2's `BaseAgent` class rather than only implementing its shape:
 * ssh2 gates a custom agent on `instanceof BaseAgent` and silently discards
 * one that fails the check, which then surfaces as "You must set a valid agent
 * path to allow agent forwarding" whenever ForwardAgent is enabled.
 */
class IdentityFilteredAgent extends BaseAgent {
  readonly kind = 'identity-filtered-agent';
  declare getStream?: BaseAgent['getStream'];

  constructor(
    readonly socketPath: string,
    private readonly agent: BaseAgent,
    private readonly allowedKeys: ParsedKey[]
  ) {
    super();
    if (agent.getStream) {
      this.getStream = agent.getStream.bind(agent);
    }
  }

  getIdentities(callback: IdentityCallback): void {
    this.agent.getIdentities((error, keys) => {
      if (error) {
        callback(error);
        return;
      }
      callback(
        undefined,
        keys?.filter((key) =>
          this.allowedKeys.some((allowedKey) => allowedKey.equals(comparablePublicKey(key)))
        ) ?? []
      );
    });
  }

  sign(
    pubKey: string | Buffer | ParsedKey,
    data: Buffer,
    optionsOrCallback?: SigningRequestOptions | SignCallback,
    callback?: SignCallback
  ): void {
    if (typeof optionsOrCallback === 'function') {
      this.agent.sign(pubKey, data, optionsOrCallback);
      return;
    }
    this.agent.sign(pubKey, data, optionsOrCallback ?? {}, callback);
  }
}

async function readIdentityKey(path: string, deps: SshConnectDeps): Promise<ParsedKey | undefined> {
  const data = await deps.readFile(expandTilde(path), 'utf-8').catch(() => undefined);
  if (!data) return undefined;
  const parsed = utils.parseKey(data);
  return parsed instanceof Error ? undefined : parsed;
}

async function readIdentityKeys(paths: string[], deps: SshConnectDeps): Promise<ParsedKey[]> {
  const keys: ParsedKey[] = [];
  for (const path of paths) {
    const publicKey = await readIdentityKey(`${path}.pub`, deps);
    const key = publicKey ?? (await readIdentityKey(path, deps));
    if (key) keys.push(key);
  }
  return keys;
}

/**
 * Read the raw PEM of any IdentityFile whose private key is on disk and
 * unencrypted, so we can authenticate the way OpenSSH does — directly from
 * `~/.ssh/...` — rather than requiring the key be pre-loaded into ssh-agent
 * (e.g. gcloud's `~/.ssh/google_compute_engine`). Public-key files and
 * passphrase-protected keys (which `parseKey` rejects without the passphrase)
 * are skipped; those are left to the agent, which serves decrypted copies.
 */
async function readPrivateIdentityKeys(paths: string[], deps: SshConnectDeps): Promise<string[]> {
  const keys: string[] = [];
  for (const path of paths) {
    const data = await deps.readFile(expandTilde(path), 'utf-8').catch(() => undefined);
    if (!data) continue;
    const parsed = utils.parseKey(data);
    if (parsed instanceof Error || !parsed.isPrivateKey()) continue;
    keys.push(data);
  }
  return keys;
}

export async function buildAuthConfig(
  input: SshConnectInput,
  base: SshConfig,
  resolved: ResolvedSshConfig | undefined,
  deps: SshConnectDeps
): Promise<AuthResult> {
  switch (base.authType) {
    case 'password': {
      const password = input.config.password;
      if (!password) throw new Error(`No password found for SSH connection '${base.name}'`);
      return { config: { password } };
    }

    case 'key': {
      const keyPath = base.privateKeyPath?.trim() || resolved?.identityFile[0];
      if (!keyPath)
        throw new Error(`Private key path is required for SSH connection '${base.name}'`);
      const privateKey = await deps.readFile(expandTilde(keyPath), 'utf-8');
      const passphrase = input.config.passphrase;
      return { config: { privateKey, ...(passphrase ? { passphrase } : {}) } };
    }

    case 'agent': {
      const diskKeys = resolved ? await readPrivateIdentityKeys(resolved.identityFile, deps) : [];
      const privateKey = diskKeys[0];

      const agentSocket = resolved
        ? resolveAgentSocketFromResolved(resolved, deps.env)
        : { kind: 'unset' as const };

      // The agent may be unavailable (disabled by `IdentityAgent none`, or no
      // socket at all). That's only fatal if we also have no on-disk key to
      // fall back to — OpenSSH still authenticates from IdentityFile in that case.
      if (agentSocket.kind === 'disabled') {
        if (privateKey) return { config: { privateKey } };
        throw new Error(`SSH agent is disabled by SSH config for connection '${base.name}'`);
      }
      const agent = agentSocket.kind === 'socket' ? agentSocket.path : deps.env.SSH_AUTH_SOCK;
      if (!agent) {
        if (privateKey) return { config: { privateKey } };
        throw new Error(`SSH agent socket not found for connection '${base.name}'`);
      }

      if (resolved?.identitiesOnly && resolved.identityFile.length > 0) {
        const identityKeys = await readIdentityKeys(resolved.identityFile, deps);
        if (identityKeys.length === 0 && !privateKey) {
          throw new Error(
            `IdentitiesOnly is enabled, but no IdentityFile public keys could be loaded for SSH connection '${base.name}'`
          );
        }
        const config: Partial<ConnectConfig> = {};
        if (privateKey) config.privateKey = privateKey;
        if (identityKeys.length > 0) {
          config.agent = new IdentityFilteredAgent(agent, deps.createAgent(agent), identityKeys);
        }
        return { config, agentSocketPath: agent };
      }

      const config: Partial<ConnectConfig> = { agent };
      if (privateKey) config.privateKey = privateKey;
      return { config, agentSocketPath: agent };
    }
  }
}
