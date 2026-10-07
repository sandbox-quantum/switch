import { createDecipheriv } from 'node:crypto';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyHostedProvider,
  type HostedCredential,
  hostedCredentialSchema,
  type ProviderReadiness,
} from '@switch-console/agent-providers';
import { z } from 'zod';
import { ReasonedError } from '../errors';
import { errorMessage, type Logger } from '../log';
import { AGENT_ID, type Ec2Layout } from '../paths';
import { readOptional, removeOptional, writeAtomic } from '../runtime';
import { PROVIDERS, type Provider } from '../schemas';
import type { KmsDecrypt } from './kms';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const CONTEXT_PROVIDER = 'switch:provider';
const CONTROLLER_CONTEXT = ['switch:tenant', 'switch:owner_id', 'switch:controller_id'] as const;

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
const context = z.record(z.string(), z.string());
const revision = z.number().int().nonnegative();

/** What `GET …/provider-credentials/{provider}` answers for a sealed login. */
export const sealedEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    v: z.literal(1),
    provider: z.string(),
    revision,
    status: z.literal('connected'),
    key_arn: z.string().min(1),
    encrypted_key: base64,
    iv: base64,
    ciphertext: base64,
    tag: base64,
    context,
  }),
  z.object({ v: z.literal(1), provider: z.string(), revision, status: z.literal('revoked') }),
]);
export type SealedEnvelope = z.infer<typeof sealedEnvelopeSchema>;

/** A context value as Python's `json.dumps` writes it by default: non-ASCII as `\uXXXX`. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/**
 * The additional data a login is sealed with: `{"context": …, "revision": N}`
 * as Core's `json.dumps(…, sort_keys=True, separators=(",", ":"))` writes it.
 */
export function canonicalAad(
  sealedContext: Record<string, string>,
  sealedRevision: number
): Buffer {
  const sorted = Object.fromEntries(
    Object.keys(sealedContext)
      .sort()
      .map((key) => [key, sealedContext[key]])
  );
  return Buffer.from(asciiJson({ context: sorted, revision: sealedRevision }), 'utf8');
}

/** Opens AES-256-GCM `ciphertext` with `key`; a wrong key, AAD or tag throws. */
export function openSealed(input: {
  key: Uint8Array;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
  aad: Buffer;
}): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', input.key, input.iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(input.aad);
  decipher.setAuthTag(input.tag);
  return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]);
}

/** A login some agents were started with changed: rewritten for them, or withdrawn. */
export type LoginRevision = { provider: Provider; agentIds: string[]; connected: boolean };

type Login = { revision: number; credential: HostedCredential };
type Connected = Extract<HostedCredential, { status: 'connected' }>;

const ENV_VALUE = /^[A-Za-z0-9._~+/=:@-]+$/;

/**
 * The provider's native login files an agent unit writes below its agent root
 * from the login it is handed (`materializeHostedProvider`), with the
 * fingerprint and temporary files written beside each.
 */
const NATIVE_LOGINS: Record<Provider, string[][]> = {
  claude: [],
  cursor: [],
  codex: [['provider-home', 'auth.json']],
  opencode: [['provider-data', 'opencode', 'auth.json']],
  antigravity: [['provider-home', 'antigravity-acp', 'acp_token.json']],
};
const NATIVE_SUFFIXES = ['', '.switch-credential', '.switch-new'];
/** A Codex session's own home below `provider-home`, holding its copy of the login. */
const CODEX_SESSION_HOME = /^[0-9a-f]{64}$/;
const CODEX_SESSION_LOGIN = ['auth.json', '.switch-auth-source'];
/** An OpenCode console login is imported into OpenCode's database, marked by this file. */
const OPENCODE_CONSOLE_MARKER = '.switch-console-credential';
const OPENCODE_DATABASE = ['opencode.db', 'opencode.db-wal', 'opencode.db-shm'];

/**
 * The provider logins Switch seals for this machine: each envelope fetched
 * from Core, its data key unwrapped by KMS under the sealed encryption
 * context, and the login opened. Opened logins are kept in memory only, one
 * per provider and revision. On disk a login exists as the files each agent
 * unit loads as credentials, in the controller's runtime directory, and as
 * the provider's native login files the unit writes from them below its agent
 * root. Both are removed when the login is revoked or disconnected, and when
 * the agent is removed from this machine.
 */
export class SealedLogins {
  private readonly logins = new Map<Provider, Login>();
  private readonly loading = new Map<Provider, Promise<Login | null>>();
  /** Providers with no connected login whose native files every agent root has been cleared of. */
  private readonly withdrawn = new Set<Provider>();
  private readonly listeners = new Set<(change: LoginRevision) => void>();

  constructor(
    private readonly deps: {
      fetchEnvelope: (provider: Provider) => Promise<unknown>;
      decrypt: KmsDecrypt;
      kms: {
        keyArn: string;
        grantTokens: string[];
        context: Record<(typeof CONTROLLER_CONTEXT)[number], string>;
      };
      layout: Ec2Layout;
      log: Logger;
    }
  ) {}

  onRevision(listener: (change: LoginRevision) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The provider's login as Core has it now, or null when there is none.
   * Agents started with an older revision have their files brought up to date
   * and are announced to `onRevision`.
   */
  async current(provider: Provider): Promise<HostedCredential | null> {
    let pending = this.loading.get(provider);
    if (!pending) {
      pending = this.load(provider).finally(() => this.loading.delete(provider));
      this.loading.set(provider, pending);
    }
    const login = await pending;
    return login?.credential ?? null;
  }

  async readiness(provider: Provider): Promise<ProviderReadiness> {
    const credential = await this.current(provider);
    if (credential === null)
      return {
        status: 'unconfigured',
        message: 'No login for this provider is connected in Switch.',
        models: [],
      };
    if (credential.status === 'revoked')
      return {
        status: 'unauthenticated',
        message: 'The login for this provider was disconnected in Switch.',
        models: [],
      };
    return { status: 'authenticated', message: 'Signed in through Switch.', models: [] };
  }

  /** Writes the files the agent's unit loads its provider login from. */
  async materialize(agentId: string, provider: Provider): Promise<void> {
    const credential = await this.current(provider);
    if (credential?.status !== 'connected')
      throw new ReasonedError(
        'provider_login_missing',
        credential === null
          ? `No ${provider} login is connected in Switch for this agent.`
          : `The ${provider} login was disconnected in Switch.`
      );
    await this.write(agentId, credential);
  }

  /** Removes an agent's login files: those its unit loads, and the native ones it wrote. */
  async remove(agentId: string): Promise<void> {
    await this.removeUnitFiles(agentId);
    for (const provider of PROVIDERS) await this.removeNative(agentId, provider);
  }

  private async removeUnitFiles(agentId: string): Promise<void> {
    await removeOptional(this.deps.layout.providerFile(agentId));
    await removeOptional(this.deps.layout.envFile(agentId));
  }

  private async load(provider: Provider): Promise<Login | null> {
    const raw = await this.deps.fetchEnvelope(provider);
    if (raw === null) {
      this.logins.delete(provider);
      await this.withdraw(provider);
      await this.reconcile(provider, null);
      return null;
    }
    const parsed = sealedEnvelopeSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error(`The sealed ${provider} login is not a v1 envelope: ${parsed.error.message}`);
    const envelope = parsed.data;
    if (envelope.provider !== provider)
      throw new Error(`The sealed login fetched for ${provider} is for ${envelope.provider}.`);
    let login = this.logins.get(provider);
    if (login?.revision !== envelope.revision) {
      login = {
        revision: envelope.revision,
        credential:
          envelope.status === 'revoked'
            ? { status: 'revoked' }
            : await this.open(provider, envelope),
      };
      this.logins.set(provider, login);
    }
    if (login.credential.status === 'connected') this.withdrawn.delete(provider);
    else await this.withdraw(provider);
    await this.reconcile(provider, login);
    return login;
  }

  /**
   * Clears every agent root of the provider's native login files, once per
   * withdrawal: the units that wrote them may be stopped, or this machine
   * rebooted since, so the runtime directory no longer names them.
   */
  private async withdraw(provider: Provider): Promise<void> {
    if (this.withdrawn.has(provider)) return;
    let names: string[];
    try {
      names = await readdir(this.deps.layout.agentsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      names = [];
    }
    for (const agentId of names)
      if (AGENT_ID.test(agentId)) await this.removeNative(agentId, provider);
    this.withdrawn.add(provider);
  }

  /**
   * Removes the native login files the agent's unit wrote for `provider`. The
   * agent root is the agent's to write, so no directory on the way may be a
   * link. What cannot be removed is logged as an error, and the rest still is.
   */
  async removeNative(agentId: string, provider: Provider): Promise<void> {
    const root = this.deps.layout.agentRoot(agentId);
    const doomed: string[] = [];
    try {
      for (const parts of NATIVE_LOGINS[provider]) {
        const directory = await directoryBelow(root, parts.slice(0, -1));
        if (directory !== null)
          for (const suffix of NATIVE_SUFFIXES)
            doomed.push(join(directory, parts.at(-1)! + suffix));
      }
      if (provider === 'codex') {
        const home = await directoryBelow(root, ['provider-home']);
        const sessions = home === null ? [] : await readdir(home);
        for (const name of sessions.filter((entry) => CODEX_SESSION_HOME.test(entry))) {
          const session = await directoryBelow(root, ['provider-home', name]);
          if (session !== null)
            for (const file of CODEX_SESSION_LOGIN) doomed.push(join(session, file));
        }
      }
      if (provider === 'opencode') {
        const data = await directoryBelow(root, ['provider-data', 'opencode']);
        if (data !== null && (await exists(join(data, OPENCODE_CONSOLE_MARKER))))
          for (const file of [...OPENCODE_DATABASE, OPENCODE_CONSOLE_MARKER])
            doomed.push(join(data, file));
      }
    } catch (error) {
      this.deps.log.error('Could not find an agent’s native provider login files to remove', {
        agentId,
        provider,
        error: errorMessage(error),
      });
    }
    for (const path of doomed)
      try {
        await removeOptional(path);
      } catch (error) {
        this.deps.log.error('Could not remove a native provider login file', {
          agentId,
          provider,
          path,
          error: errorMessage(error),
        });
      }
  }

  private async open(
    provider: Provider,
    envelope: Extract<SealedEnvelope, { status: 'connected' }>
  ): Promise<HostedCredential> {
    if (envelope.key_arn !== this.deps.kms.keyArn)
      throw new Error(`The sealed ${provider} login names another KMS key than this machine's.`);
    const expected: Record<string, string> = {
      ...this.deps.kms.context,
      [CONTEXT_PROVIDER]: provider,
    };
    const keys = Object.keys(envelope.context).sort();
    if (
      keys.join('\n') !== Object.keys(expected).sort().join('\n') ||
      keys.some((key) => envelope.context[key] !== expected[key])
    )
      throw new Error(
        `The sealed ${provider} login was sealed for another context than this machine's.`
      );
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
      throw new Error(`The sealed ${provider} login has a malformed IV or tag.`);
    const key = await this.deps.decrypt({
      keyArn: envelope.key_arn,
      ciphertext: Buffer.from(envelope.encrypted_key, 'base64'),
      context: envelope.context,
      grantTokens: this.deps.kms.grantTokens,
    });
    let plaintext: Buffer;
    try {
      if (key.length !== KEY_BYTES)
        throw new Error(`KMS unwrapped a ${key.length}-byte data key for the ${provider} login.`);
      plaintext = openSealed({
        key,
        iv,
        tag,
        ciphertext: Buffer.from(envelope.ciphertext, 'base64'),
        aad: canonicalAad(envelope.context, envelope.revision),
      });
    } finally {
      key.fill(0);
    }
    let credential: HostedCredential;
    try {
      credential = hostedCredentialSchema.parse(JSON.parse(plaintext.toString('utf8')));
    } catch {
      throw new Error(`The sealed ${provider} login opened to something other than a login.`);
    } finally {
      plaintext.fill(0);
    }
    if (
      credential.status !== 'connected' ||
      credential.provider !== provider ||
      credential.revision !== String(envelope.revision)
    )
      throw new Error(`The sealed ${provider} login does not match its envelope.`);
    return credential;
  }

  /** Brings every agent's files for `provider` in line with `login`, and announces who changed. */
  private async reconcile(provider: Provider, login: Login | null): Promise<void> {
    const stale: string[] = [];
    for (const [agentId, written] of await this.written())
      if (
        written.provider === provider &&
        (login?.credential.status !== 'connected' || written.revision !== String(login.revision))
      )
        stale.push(agentId);
    if (stale.length === 0) return;
    const credential = login?.credential.status === 'connected' ? login.credential : null;
    const connected = credential !== null;
    for (const agentId of stale)
      if (credential) await this.write(agentId, credential);
      else await this.removeUnitFiles(agentId);
    this.deps.log.info('A sealed provider login changed for running agents', {
      provider,
      revision: login?.revision ?? null,
      connected,
      agents: stale.length,
    });
    for (const listener of this.listeners) listener({ provider, agentIds: stale, connected });
  }

  /** The provider and revision of each agent's written login file. */
  private async written(): Promise<Map<string, { provider: string; revision: string }>> {
    const found = new Map<string, { provider: string; revision: string }>();
    let names: string[];
    try {
      names = await readdir(this.deps.layout.runDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return found;
      throw error;
    }
    for (const name of names) {
      const agentId = name.endsWith('.provider.json')
        ? name.slice(0, -'.provider.json'.length)
        : '';
      if (!AGENT_ID.test(agentId)) continue;
      const text = await readOptional(this.deps.layout.providerFile(agentId));
      if (text === null) continue;
      const parsed = hostedCredentialSchema.safeParse(JSON.parse(text));
      if (parsed.success && parsed.data.status === 'connected')
        found.set(agentId, { provider: parsed.data.provider, revision: parsed.data.revision });
    }
    return found;
  }

  private async write(agentId: string, credential: Connected): Promise<void> {
    await mkdir(this.deps.layout.runDir, { recursive: true, mode: 0o700 });
    await writeAtomic(this.deps.layout.providerFile(agentId), JSON.stringify(credential));
    const env: Record<string, string> = {};
    applyHostedProvider(env, credential);
    const entries = Object.entries(env);
    if (entries.length === 0) {
      await removeOptional(this.deps.layout.envFile(agentId));
      return;
    }
    if (entries.some(([, value]) => !ENV_VALUE.test(value)))
      throw new ReasonedError(
        'provider_login_missing',
        `The ${credential.provider} login has characters a unit environment file cannot carry.`
      );
    await writeAtomic(
      this.deps.layout.envFile(agentId),
      entries.map(([name, value]) => `${name}=${value}\n`).join('')
    );
  }
}

/** `root` joined with `parts`, null when a directory on the way is missing; a link or file there throws. */
async function directoryBelow(root: string, parts: string[]): Promise<string | null> {
  let directory = root;
  for (const part of ['.', ...parts]) {
    directory = join(directory, part);
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (info.isSymbolicLink())
      throw new Error(`${directory} is a symbolic link; it is not followed.`);
    if (!info.isDirectory()) throw new Error(`${directory} is not a directory.`);
  }
  return directory;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
