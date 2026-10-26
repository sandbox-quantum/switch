import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as Protocol from '../transport/stdio-json-rpc';
import { checkCodexSignIn, CODEX_KEYRING_LOGIN_UNUSABLE } from './sign-in';

const mock = vi.hoisted(() => ({ request: vi.fn(), dispose: vi.fn(), notify: vi.fn() }));
vi.mock('../transport/stdio-json-rpc', async (original) => ({
  ...(await original<typeof Protocol>()),
  StdioJsonRpcClient: class {
    request = mock.request;
    dispose = mock.dispose;
    notify = mock.notify;
  },
}));

let root: string;
let home: string;

beforeEach(async () => {
  vi.resetAllMocks();
  mock.dispose.mockResolvedValue(undefined);
  root = await mkdtemp(join(tmpdir(), 'codex-sign-in-'));
  home = join(root, 'codex-home');
  await mkdir(home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function answer(account: unknown, requiresOpenaiAuth = true): void {
  mock.request.mockResolvedValueOnce({}).mockResolvedValueOnce({ account, requiresOpenaiAuth });
}

const check = (env: Record<string, string>) =>
  checkCodexSignIn({ binaryPath: 'codex', cwd: root, env });

it('reports a ChatGPT login with no auth.json behind it as unusable by sessions', async () => {
  answer({ type: 'chatgpt', email: null, planType: 'plus' });
  expect(await check({ CODEX_HOME: home })).toEqual({
    status: 'unauthenticated',
    message: CODEX_KEYRING_LOGIN_UNUSABLE,
    models: [],
  });
});

it('reports a ChatGPT login kept in auth.json as signed in', async () => {
  await writeFile(join(home, 'auth.json'), '{}');
  answer({ type: 'chatgpt', email: null, planType: 'plus' });
  expect((await check({ CODEX_HOME: home })).status).toBe('authenticated');
});

it('reports an API key in the keyring as signed in, since sessions are handed it', async () => {
  answer({ type: 'apiKey' });
  expect((await check({ CODEX_HOME: home })).status).toBe('authenticated');
});

it('does not ask for auth.json when the backend needs no OpenAI login', async () => {
  answer({ type: 'amazonBedrock', usesCodexManagedCredentials: false }, false);
  expect((await check({ CODEX_HOME: home })).status).toBe('authenticated');
});

it('looks for auth.json in ~/.codex when CODEX_HOME is not set, as sessions do', async () => {
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  answer({ type: 'chatgpt', email: null, planType: 'plus' });
  expect((await check({})).status).toBe('unauthenticated');
  await mkdir(join(root, '.codex'));
  await writeFile(join(root, '.codex', 'auth.json'), '{}');
  answer({ type: 'chatgpt', email: null, planType: 'plus' });
  expect((await check({})).status).toBe('authenticated');
});
