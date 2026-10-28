import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as Protocol from '../transport/stdio-json-rpc';
import { JsonRpcError } from '../transport/stdio-json-rpc';
import { codexHomeNotAbsolute } from './home';
import {
  checkCodexSignIn,
  codexKeyringApiKeyWithheld,
  codexKeyringIgnoresAuthFile,
  codexKeyringLoginUnusable,
  codexKeyringStorePinned,
} from './sign-in';

/** How Codex answers a method it does not have. */
const unknownMethod = (method: string) =>
  new JsonRpcError(-32600, `Invalid request: unknown variant \`${method}\`, expected one of ...`);

/**
 * A Codex app-server per spawn: the home `initialize` reports, what
 * `account/read` and `getAuthStatus` answer, and where `config/read` says
 * logins are kept, for a plain spawn and for one asked to keep them in memory.
 */
const codex = vi.hoisted(() => ({
  codexHome: undefined as string | null | undefined,
  accountDelayMs: 0,
  disposeError: null as Error | null,
  account: null as unknown,
  requiresOpenaiAuth: true,
  authStatus: { authMethod: 'apikey', authToken: null } as unknown,
  authStatusError: null as Error | null,
  store: 'file' as unknown,
  ephemeralStore: 'ephemeral' as unknown,
  configReadError: null as Error | null,
  events: [] as string[],
}));
vi.mock('../transport/stdio-json-rpc', async (original) => ({
  ...(await original<typeof Protocol>()),
  StdioJsonRpcClient: class {
    private readonly name: string;
    constructor(options: { args: string[] }) {
      this.name = options.args.includes('cli_auth_credentials_store="ephemeral"')
        ? 'ephemeral'
        : 'plain';
      codex.events.push(`start ${this.name}`);
    }
    private stopped: (() => void) | null = null;
    async request(method: string) {
      if (method === 'initialize')
        return codex.codexHome === undefined ? {} : { codexHome: codex.codexHome };
      if (method === 'account/read') {
        if (codex.accountDelayMs)
          // Answers late, or fails as an exit if stopped first.
          await new Promise<void>((resolve, reject) => {
            setTimeout(resolve, codex.accountDelayMs);
            this.stopped = () => reject(new Error('provider process exited (signal SIGTERM)'));
          });
        return { account: codex.account, requiresOpenaiAuth: codex.requiresOpenaiAuth };
      }
      if (method === 'getAuthStatus') {
        if (codex.authStatusError) throw codex.authStatusError;
        return codex.authStatus;
      }
      if (method === 'config/read') {
        if (codex.configReadError) throw codex.configReadError;
        const store = this.name === 'ephemeral' ? codex.ephemeralStore : codex.store;
        return { config: { cli_auth_credentials_store: store } };
      }
      throw unknownMethod(method);
    }
    notify() {}
    async dispose() {
      codex.events.push(`stop ${this.name}`);
      this.stopped?.();
      if (codex.disposeError) throw codex.disposeError;
    }
  },
}));

let root: string;
let home: string;

beforeEach(async () => {
  Object.assign(codex, {
    codexHome: undefined,
    accountDelayMs: 0,
    disposeError: null,
    account: null,
    requiresOpenaiAuth: true,
    authStatus: { authMethod: 'apikey', authToken: null },
    authStatusError: null,
    store: 'file',
    ephemeralStore: 'ephemeral',
    configReadError: null,
    events: [],
  });
  root = await mkdtemp(join(tmpdir(), 'codex-sign-in-'));
  home = join(root, 'codex-home');
  await mkdir(home);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const CHATGPT = { type: 'chatgpt', email: null, planType: 'plus' };
const API_KEY = { type: 'apiKey' };
const authFile = (dir = home) => writeFile(join(dir, 'auth.json'), '{}');
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

it('reads a Codex too old for config/read from the config.toml sessions inherit', async () => {
  await authFile();
  codex.account = CHATGPT;
  codex.configReadError = unknownMethod('config/read');
  expect((await check()).status).toBe('authenticated');
  await writeFile(join(home, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
  expect((await check()).message).toBe(codexKeyringIgnoresAuthFile(home));
});

it('does not take a refused parameter for a missing method', async () => {
  codex.account = API_KEY;
  codex.authStatusError = new JsonRpcError(
    -32600,
    'Invalid request: unknown variant `includeSecrets`, expected one of `includeToken`'
  );
  const result = await check();
  expect(result.status).toBe('unknown');
  expect(result.message).toContain('unknown variant `includeSecrets`');
});

it('reports an API key in the keyring as signed in when sessions can be handed it', async () => {
  codex.account = API_KEY;
  expect((await check()).status).toBe('authenticated');
  // The second Codex starts only once the first has stopped.
  expect(codex.events).toEqual(['start plain', 'stop plain', 'start ephemeral', 'stop ephemeral']);
});

it('reports an API key in the keyring as unusable when the session store is pinned', async () => {
  codex.account = API_KEY;
  codex.ephemeralStore = 'keyring';
  expect(await check()).toEqual({
    status: 'unauthenticated',
    message: codexKeyringStorePinned(home, 'keyring'),
    models: [],
    // No sign-in changes what an administrator pinned.
    loginHelps: false,
  });
});

it('refuses a relative CODEX_HOME before starting Codex, as sessions do', async () => {
  expect(await check({ CODEX_HOME: '.codex-work' })).toEqual({
    status: 'unauthenticated',
    message: codexHomeNotAbsolute('.codex-work'),
    models: [],
    loginHelps: false,
  });
  expect(codex.events).toEqual([]);
});

it('leaves signing in on offer where it is the last step of the fix', async () => {
  codex.account = CHATGPT;
  expect(await check()).not.toHaveProperty('loginHelps');
});

it('names a missing store as null rather than guessing at one', async () => {
  codex.account = API_KEY;
  codex.ephemeralStore = undefined;
  expect((await check()).message).toBe(codexKeyringStorePinned(home, undefined));
  expect(codexKeyringStorePinned(home, undefined)).toContain('to null for a session');
});

it('reports an API key in the keyring as unusable when Codex will not hand it over', async () => {
  codex.account = API_KEY;
  codex.authStatusError = unknownMethod('getAuthStatus');
  expect((await check()).message).toBe(codexKeyringApiKeyWithheld(home));
  codex.authStatusError = null;
  codex.authStatus = { authMethod: 'chatgpt', authToken: null };
  expect((await check()).message).toBe(codexKeyringApiKeyWithheld(home));
});

it('gives the cause when the hand-over cannot be checked', async () => {
  codex.account = API_KEY;
  codex.authStatusError = new JsonRpcError(-32603, 'keychain is locked');
  const result = await check();
  expect(result.status).toBe('unknown');
  expect(result.message).toContain('keychain is locked');
});

it('reports a Bedrock key Codex keeps in the keyring as unusable', async () => {
  codex.account = { type: 'amazonBedrock', usesCodexManagedCredentials: true };
  codex.requiresOpenaiAuth = false;
  expect((await check()).message).toBe(codexKeyringLoginUnusable(home));
});

it('says it cannot tell when Codex does not say what a Bedrock login runs on', async () => {
  codex.account = { type: 'amazonBedrock' };
  codex.requiresOpenaiAuth = false;
  const result = await check();
  expect(result.status).toBe('unknown');
  expect(result.message).toContain('runs on AWS credentials or on a key Codex keeps');
  codex.account = { type: 'amazonBedrock', usesCodexManagedCredentials: false };
  expect((await check()).status).toBe('authenticated');
});

// A file where the home should be reads as ENOENT on Windows, not ENOTDIR.
it.skipIf(process.platform === 'win32')(
  'says what went wrong when the Codex home cannot be checked',
  async () => {
    await rm(home, { recursive: true });
    await writeFile(home, 'not a directory');
    codex.account = CHATGPT;
    const result = await check();
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('ENOTDIR');
  }
);

it('looks in the home Codex reports reading the login from', async () => {
  const reported = join(root, 'reported-home');
  await mkdir(reported);
  await authFile(reported);
  codex.codexHome = reported;
  codex.account = CHATGPT;
  expect((await check()).status).toBe('authenticated');
});

it('looks for auth.json in ~/.codex when Codex does not say and CODEX_HOME is not set', async () => {
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  codex.account = CHATGPT;
  expect((await check({})).status).toBe('unauthenticated');
  await mkdir(join(root, '.codex'));
  await authFile(join(root, '.codex'));
  expect((await check({})).status).toBe('authenticated');
});

it('falls back to CODEX_HOME when Codex reports its home as null', async () => {
  await authFile();
  codex.codexHome = null;
  codex.account = CHATGPT;
  expect((await check()).status).toBe('authenticated');
});

it('keeps what it read when a Codex will not stop afterwards', async () => {
  await authFile();
  codex.account = CHATGPT;
  codex.disposeError = new Error('Provider process did not exit after termination.');
  expect((await check()).status).toBe('authenticated');
});

it('says the check ran out of time rather than that Codex crashed', async () => {
  vi.useFakeTimers();
  codex.account = CHATGPT;
  codex.accountDelayMs = 60_000;
  const result = check();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await result).toEqual({
    status: 'unknown',
    message: "Could not check Codex's sign-in: the check ran out of its 20 seconds.",
    models: [],
  });
});

it('does not start a second Codex with too little of the deadline left', async () => {
  vi.useFakeTimers();
  codex.account = API_KEY;
  codex.accountDelayMs = 19_000;
  const result = check();
  await vi.advanceTimersByTimeAsync(19_000);
  expect((await result).message).toContain('ran out of its 20 seconds');
  expect(codex.events).toEqual(['start plain', 'stop plain']);
});
