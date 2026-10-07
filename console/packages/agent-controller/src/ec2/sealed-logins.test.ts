import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../log';
import { type Ec2Layout, ec2Layout } from '../paths';
import type { Provider } from '../schemas';
import vector from './__fixtures__/sealed-vector.json';
import type { KmsDecrypt } from './kms';
import { canonicalAad, type LoginRevision, SealedLogins } from './sealed-logins';

type Case = keyof typeof vector.cases;
const CONTEXT = {
  'switch:tenant': 'tenant-1',
  'switch:owner_id': 'owner-1',
  'switch:controller_id': 'ctl-1',
};
const GRANT_TOKENS = ['grant-token-placeholder'];

let dir: string;
let layout: Ec2Layout;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-sealed-'));
  layout = ec2Layout({ dataRoot: join(dir, 'data'), runRoot: join(dir, 'run') });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harness(initial: Partial<Record<Provider, unknown>>, context = CONTEXT) {
  const envelopes: Partial<Record<Provider, unknown>> = { ...initial };
  const decrypts: Parameters<KmsDecrypt>[0][] = [];
  const decrypt: KmsDecrypt = async (input) => {
    decrypts.push(input);
    expect(input.keyArn).toBe(vector.keyArn);
    expect(Buffer.from(input.ciphertext).toString('base64')).toBe(vector.encryptedKey);
    return Buffer.from(vector.dataKey, 'base64');
  };
  const changes: LoginRevision[] = [];
  const errors: string[] = [];
  const logins = new SealedLogins({
    fetchEnvelope: async (provider) => envelopes[provider] ?? null,
    decrypt,
    kms: { keyArn: vector.keyArn, grantTokens: GRANT_TOKENS, context },
    layout,
    log: { ...silentLogger, error: (message) => errors.push(message) },
  });
  logins.onRevision((change) => changes.push(change));
  return { envelopes, decrypts, changes, errors, logins };
}

/** Writes `parts` below `agentId`'s root as its unit would, answering the path. */
function agentFile(agentId: string, parts: string): string {
  const path = join(layout.agentRoot(agentId), parts);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'placeholder');
  return path;
}

const SESSION = 'a'.repeat(64);
const revoked = (provider: Provider, revision: number) => ({
  v: 1,
  provider,
  revision,
  status: 'revoked',
});

const envelope = (name: Case) => structuredClone(vector.cases[name].envelope);

describe('canonicalAad', () => {
  it('matches what Core seals with, non-ASCII context values included', () => {
    for (const sealed of Object.values(vector.cases))
      expect(canonicalAad(sealed.envelope.context, sealed.envelope.revision).toString('utf8')).toBe(
        sealed.aad
      );
  });

  it('sorts the context keys whatever order they arrive in', () => {
    const reversed = Object.fromEntries(
      Object.entries(vector.cases.claude.envelope.context).reverse()
    );
    expect(canonicalAad(reversed, 3).toString('utf8')).toBe(vector.cases.claude.aad);
  });
});

describe('SealedLogins', () => {
  it('opens a login with KMS and writes the unit files owner-only', async () => {
    const { decrypts, logins } = harness({ claude: envelope('claude') });
    await logins.materialize('agent-1', 'claude');
    expect(decrypts).toHaveLength(1);
    expect(decrypts[0]!.context).toEqual({ ...CONTEXT, 'switch:provider': 'claude' });
    expect(decrypts[0]!.grantTokens).toEqual(GRANT_TOKENS);
    const provider = layout.providerFile('agent-1');
    expect(JSON.parse(readFileSync(provider, 'utf8'))).toEqual({
      status: 'connected',
      revision: '3',
      provider: 'claude',
      kind: 'api-key',
      credential: 'sk-ant-test-placeholder',
    });
    expect(statSync(provider).mode & 0o777).toBe(0o600);
    expect(readFileSync(layout.envFile('agent-1'), 'utf8')).toBe(
      'ANTHROPIC_API_KEY=sk-ant-test-placeholder\n'
    );
    expect(statSync(layout.envFile('agent-1')).mode & 0o777).toBe(0o600);
    expect(statSync(layout.runDir).mode & 0o777).toBe(0o700);

    await logins.materialize('agent-2', 'claude');
    expect(decrypts).toHaveLength(1);
    expect(await logins.readiness('claude')).toMatchObject({ status: 'authenticated' });
  });

  it('writes no environment file for a login the provider reads from a file', async () => {
    const { logins } = harness({ codex: envelope('codex') });
    await logins.materialize('agent-1', 'codex');
    expect(JSON.parse(readFileSync(layout.providerFile('agent-1'), 'utf8'))).toMatchObject({
      kind: 'auth-json',
      revision: '7',
    });
    expect(() => statSync(layout.envFile('agent-1'))).toThrow();
  });

  it('opens a login sealed under a non-ASCII context', async () => {
    const { logins } = harness(
      { claude: envelope('unicode') },
      { ...CONTEXT, 'switch:tenant': vector.cases.unicode.envelope.context['switch:tenant'] }
    );
    expect(await logins.current('claude')).toMatchObject({ kind: 'setup-token', revision: '12' });
  });

  it('refuses an envelope sealed for another controller, key or with a bad tag', async () => {
    const other = envelope('claude');
    other.context['switch:controller_id'] = 'ctl-2';
    await expect(harness({ claude: other }).logins.current('claude')).rejects.toThrow(
      /another context/
    );
    const key = envelope('claude');
    key.key_arn = `${vector.keyArn}-other`;
    await expect(harness({ claude: key }).logins.current('claude')).rejects.toThrow(/KMS key/);
    const tampered = envelope('claude');
    tampered.tag = Buffer.alloc(16).toString('base64');
    await expect(harness({ claude: tampered }).logins.current('claude')).rejects.toThrow();
    const replayed = { ...envelope('claudeNext'), revision: 3 };
    await expect(harness({ claude: replayed }).logins.current('claude')).rejects.toThrow();
    await expect(
      harness({ claude: envelope('claude') }).logins.current('codex')
    ).resolves.toBeNull();
    await expect(harness({ codex: envelope('claude') }).logins.current('codex')).rejects.toThrow(
      /is for claude/
    );
  });

  it('rewrites and announces the agents a new revision reaches', async () => {
    const { envelopes, changes, decrypts, logins } = harness({ claude: envelope('claude') });
    await logins.materialize('agent-1', 'claude');
    await logins.materialize('agent-2', 'claude');
    envelopes.claude = envelope('claudeNext');
    await logins.current('claude');
    expect(changes).toEqual([
      { provider: 'claude', agentIds: ['agent-1', 'agent-2'], connected: true },
    ]);
    expect(decrypts).toHaveLength(2);
    expect(JSON.parse(readFileSync(layout.providerFile('agent-1'), 'utf8')).revision).toBe('4');
    expect(readFileSync(layout.envFile('agent-2'), 'utf8')).toBe(
      'ANTHROPIC_API_KEY=sk-ant-test-placeholder-2\n'
    );
    await logins.current('claude');
    expect(changes).toHaveLength(1);
  });

  it('withdraws a revoked login from the agents that had it', async () => {
    const { envelopes, changes, logins } = harness({ claude: envelope('claude') });
    await logins.materialize('agent-1', 'claude');
    envelopes.claude = { v: 1, provider: 'claude', revision: 4, status: 'revoked', key_arn: null };
    expect(await logins.readiness('claude')).toMatchObject({ status: 'unauthenticated' });
    expect(changes).toEqual([{ provider: 'claude', agentIds: ['agent-1'], connected: false }]);
    expect(() => statSync(layout.providerFile('agent-1'))).toThrow();
    expect(() => statSync(layout.envFile('agent-1'))).toThrow();
    await expect(logins.materialize('agent-1', 'claude')).rejects.toMatchObject({
      reason: 'provider_login_missing',
    });
    delete envelopes.claude;
    expect(await logins.readiness('claude')).toMatchObject({ status: 'unconfigured' });
  });

  it('removes the native login files a revoked login left in every agent root', async () => {
    const { envelopes, errors, logins } = harness({ codex: envelope('codex') });
    await logins.materialize('agent-1', 'codex');
    const written = [
      agentFile('agent-1', 'provider-home/auth.json'),
      agentFile('agent-1', 'provider-home/auth.json.switch-credential'),
      agentFile('agent-1', `provider-home/${SESSION}/auth.json`),
      agentFile('agent-1', `provider-home/${SESSION}/.switch-auth-source`),
      agentFile('agent-2', 'provider-home/auth.json'),
    ];
    const kept = [
      agentFile('agent-1', 'provider-home/config.toml'),
      agentFile('agent-1', `provider-home/${SESSION}/config.toml`),
      agentFile('agent-1', 'provider-home/antigravity-acp/acp_token.json'),
    ];
    envelopes.codex = revoked('codex', 8);
    await logins.current('codex');
    for (const path of written) expect(existsSync(path), path).toBe(false);
    for (const path of kept) expect(existsSync(path), path).toBe(true);
    expect(errors).toEqual([]);
  });

  it('removes them when the login is deleted outright, once per withdrawal', async () => {
    const { envelopes, logins } = harness({});
    const token = agentFile('agent-1', 'provider-home/antigravity-acp/acp_token.json');
    await logins.current('antigravity');
    expect(existsSync(token)).toBe(false);
    agentFile('agent-1', 'provider-home/antigravity-acp/acp_token.json');
    await logins.current('antigravity');
    expect(existsSync(token)).toBe(true);
    envelopes.antigravity = revoked('antigravity', 2);
    await logins.current('antigravity');
    expect(existsSync(token)).toBe(true);
  });

  it('removes an imported OpenCode console login with the database it lives in', async () => {
    const { logins } = harness({});
    const database = [
      agentFile('agent-1', 'provider-data/opencode/opencode.db'),
      agentFile('agent-1', 'provider-data/opencode/opencode.db-wal'),
      agentFile('agent-1', 'provider-data/opencode/.switch-console-credential'),
      agentFile('agent-1', 'provider-data/opencode/auth.json'),
    ];
    const untouched = agentFile('agent-2', 'provider-data/opencode/opencode.db');
    await logins.current('opencode');
    for (const path of database) expect(existsSync(path), path).toBe(false);
    expect(existsSync(untouched)).toBe(true);
  });

  it('removes every native login of an agent removed from the machine, and only its', async () => {
    const { logins } = harness({ codex: envelope('codex') });
    await logins.materialize('agent-1', 'codex');
    const own = [
      agentFile('agent-1', 'provider-home/auth.json'),
      agentFile('agent-1', 'provider-data/opencode/auth.json'),
      agentFile('agent-1', 'provider-home/antigravity-acp/acp_token.json'),
    ];
    const other = agentFile('agent-2', 'provider-home/auth.json');
    await logins.remove('agent-1');
    for (const path of own) expect(existsSync(path), path).toBe(false);
    expect(existsSync(layout.providerFile('agent-1'))).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('follows no link an agent planted, and says so', async () => {
    const { errors, logins } = harness({});
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'auth.json'), 'placeholder');
    mkdirSync(layout.agentRoot('agent-1'), { recursive: true });
    symlinkSync(outside, join(layout.agentRoot('agent-1'), 'provider-home'));
    await logins.remove('agent-1');
    expect(existsSync(join(outside, 'auth.json'))).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('a login Core sealed', () => {
  const core = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          '../../../../../core/tests/switch_core/management/fixtures/sealed-vector.json',
          import.meta.url
        )
      ),
      'utf8'
    )
  ) as {
    data_key: string;
    aad: string;
    plaintext: string;
    envelope: { key_arn: string; encrypted_key: string; context: Record<string, string> };
  };

  it('opens to the plaintext Core sealed, under the additional data Core sealed it with', async () => {
    const { 'switch:provider': _provider, ...context } = core.envelope.context;
    const logins = new SealedLogins({
      fetchEnvelope: async () => core.envelope,
      decrypt: async (input) => {
        expect(Buffer.from(input.ciphertext).toString('base64')).toBe(core.envelope.encrypted_key);
        expect(input.context).toEqual(core.envelope.context);
        return Buffer.from(core.data_key, 'base64');
      },
      kms: {
        keyArn: core.envelope.key_arn,
        grantTokens: [],
        context: context as typeof CONTEXT,
      },
      layout,
      log: silentLogger,
    });
    expect(canonicalAad(core.envelope.context, 3).toString('utf8')).toBe(core.aad);
    expect(await logins.current('codex')).toEqual(JSON.parse(core.plaintext));
  });
});
