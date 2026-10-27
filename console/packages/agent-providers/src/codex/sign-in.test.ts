import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as Protocol from '../transport/stdio-json-rpc';
import { JsonRpcError } from '../transport/stdio-json-rpc';
import {
  checkCodexSignIn,
  codexKeyringApiKeyPinned,
  codexKeyringIgnoresAuthFile,
  codexKeyringLoginUnusable,
} from './sign-in';

/**
 * A Codex app-server per spawn: what `account/read` answers, and where
 * `config/read` says logins are kept, for a plain spawn and for one asked to
 * keep them in memory.
 */
const codex = vi.hoisted(() => ({
  account: null as unknown,
  requiresOpenaiAuth: true,
  store: 'file' as unknown,
  ephemeralStore: 'ephemeral' as unknown,
  configRead: null as Error | null,
  spawned: [] as string[][],
}));
vi.mock('../transport/stdio-json-rpc', async (original) => ({
  ...(await original<typeof Protocol>()),
  StdioJsonRpcClient: class {
    private readonly ephemeral: boolean;
    constructor(options: { args: string[] }) {
      codex.spawned.push(options.args);
      this.ephemeral = options.args.includes('cli_auth_credentials_store="ephemeral"');
    }
    async request(method: string) {
      if (method === 'account/read')
        return { account: codex.account, requiresOpenaiAuth: codex.requiresOpenaiAuth };
      if (method === 'config/read') {
        if (codex.configRead) throw codex.configRead;
        return {
          config: {
            cli_auth_credentials_store: this.ephemeral ? codex.ephemeralStore : codex.store,
          },
        };
      }
      return {};
    }
    notify() {}
    async dispose() {}
  },
}));

let root: string;
let home: string;

beforeEach(async () => {
  Object.assign(codex, {
    account: null,
    requiresOpenaiAuth: true,
    store: 'file',
    ephemeralStore: 'ephemeral',
    configRead: null,
    spawned: [],
  });
  root = await mkdtemp(join(tmpdir(), 'codex-sign-in-'));
  home = join(root, 'codex-home');
  await mkdir(home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const CHATGPT = { type: 'chatgpt', email: null, planType: 'plus' };
const authFile = () => writeFile(join(home, 'auth.json'), '{}');
const check = (env: Record<string, string> = { CODEX_HOME: home }) =>
  checkCodexSignIn({ binaryPath: 'codex', cwd: root, env });

it('reports a ChatGPT login with no auth.json behind it as unusable by sessions', async () => {
  codex.account = CHATGPT;
  expect(await check()).toEqual({
    status: 'unauthenticated',
    message: codexKeyringLoginUnusable(home),
    models: [],
  });
});

it('reports a ChatGPT login kept in auth.json as signed in', async () => {
  await authFile();
  codex.account = CHATGPT;
  expect((await check()).status).toBe('authenticated');
});

it('reports an auth.json that Codex is set to ignore for the keyring as unusable', async () => {
  await authFile();
  codex.account = CHATGPT;
  codex.store = 'keyring';
  expect(await check()).toEqual({
    status: 'unauthenticated',
    message: codexKeyringIgnoresAuthFile(home),
    models: [],
  });
});

it('takes auth.json as used when Codex is too old to say where it keeps logins', async () => {
  await authFile();
  codex.account = CHATGPT;
  codex.configRead = new JsonRpcError(-32601, 'Method not found');
  expect((await check()).status).toBe('authenticated');
});

it('reports an API key in the keyring as signed in when sessions can be handed it', async () => {
  codex.account = { type: 'apiKey' };
  expect((await check()).status).toBe('authenticated');
  expect(codex.spawned.at(-1)).toContain('cli_auth_credentials_store="ephemeral"');
});

it('reports an API key in the keyring as unusable when an administrator pins the store', async () => {
  codex.account = { type: 'apiKey' };
  codex.ephemeralStore = 'keyring';
  expect(await check()).toEqual({
    status: 'unauthenticated',
    message: codexKeyringApiKeyPinned(home),
    models: [],
  });
});

it('reports a Bedrock key Codex keeps in the keyring as unusable', async () => {
  codex.account = { type: 'amazonBedrock', usesCodexManagedCredentials: true };
  codex.requiresOpenaiAuth = false;
  expect((await check()).message).toBe(codexKeyringLoginUnusable(home));
});

it('does not ask for auth.json from Bedrock on AWS credentials', async () => {
  codex.account = { type: 'amazonBedrock', usesCodexManagedCredentials: false };
  codex.requiresOpenaiAuth = false;
  expect((await check()).status).toBe('authenticated');
});

it('says what went wrong when the Codex home cannot be checked', async () => {
  await rm(home, { recursive: true });
  await writeFile(home, 'not a directory');
  codex.account = CHATGPT;
  const result = await check();
  expect(result.status).toBe('unknown');
  expect(result.message).toContain(`Could not check for Codex's auth.json in ${home}`);
});

it('looks for auth.json in ~/.codex when CODEX_HOME is not set, as sessions do', async () => {
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  codex.account = CHATGPT;
  expect((await check({})).status).toBe('unauthenticated');
  await mkdir(join(root, '.codex'));
  await writeFile(join(root, '.codex', 'auth.json'), '{}');
  expect((await check({})).status).toBe('authenticated');
});
