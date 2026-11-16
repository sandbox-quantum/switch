import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareCodexSessionHome } from '../codex/home';
import {
  AUTHORIZED_USER_FIXTURE,
  SERVICE_ACCOUNT_KEY_FIXTURE,
  vertexCredentialFixture,
} from '../testing/vertex-fixtures';
import {
  HOSTED_LOGIN_FILES,
  materializeHostedProvider,
  removeHostedLoginFiles,
  type HostedCredential,
} from './hosted-provider';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hosted-auth-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

const credential = (value: string): Extract<HostedCredential, { status: 'connected' }> => ({
  status: 'connected',
  revision: 'revision-one',
  provider: 'codex',
  kind: 'auth-json',
  credential: value,
});

it('preserves a native token refresh until the owner replaces the source credential', async () => {
  const env: Record<string, string> = {};
  await materializeHostedProvider(
    root,
    env,
    credential('{"tokens":{"access_token":"fixture-original"}}'),
    'fixture-cli'
  );
  const path = join(env.CODEX_HOME!, 'auth.json');
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  await writeFile(path, '{"tokens":{"access_token":"fixture-refreshed"}}');
  await materializeHostedProvider(
    root,
    env,
    credential('{"tokens":{"access_token":"fixture-original"}}'),
    'fixture-cli'
  );
  expect(await readFile(path, 'utf8')).toContain('fixture-refreshed');
  await materializeHostedProvider(
    root,
    env,
    credential('{"tokens":{"access_token":"fixture-replaced"}}'),
    'fixture-cli'
  );
  expect(await readFile(path, 'utf8')).toContain('fixture-replaced');
});

it('rejects malformed credentials before creating an authentication file', async () => {
  await expect(
    materializeHostedProvider(root, {}, credential('not-json'), 'fixture-cli')
  ).rejects.toThrow('JSON object');
  await expect(stat(join(root, 'provider-home'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not follow an authentication directory symlink', async () => {
  await symlink(tmpdir(), join(root, 'provider-home'));
  await expect(
    materializeHostedProvider(root, {}, credential('{"fixture":true}'), 'fixture-cli')
  ).rejects.toThrow('symbolic link');
});

it('keeps the different providers in their native authentication locations', async () => {
  for (const [provider, variable, relative, binaryPath] of [
    ['opencode', 'XDG_DATA_HOME', 'opencode/auth.json', 'fixture-cli'],
    [
      'antigravity',
      'GEMINI_HOME',
      'antigravity-acp/acp_token.json',
      '/home/u/.local/bin/antigravity-acp',
    ],
  ] as const) {
    const env: Record<string, string> = {};
    await materializeHostedProvider(
      root,
      env,
      { ...credential('{"fixture":true}'), provider },
      binaryPath
    );
    expect(JSON.parse(await readFile(join(env[variable]!, relative), 'utf8'))).toEqual({
      fixture: true,
    });
  }
});

it('refuses an Antigravity ACP token for agy, which would never read it', async () => {
  const env: Record<string, string> = {};
  for (const binaryPath of ['agy', 'C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe'])
    await expect(
      materializeHostedProvider(
        root,
        env,
        { ...credential('{"fixture":true}'), provider: 'antigravity' },
        binaryPath
      )
    ).rejects.toThrow('agy acp --login');
  expect(env.GEMINI_HOME).toBeUndefined();
  await expect(stat(join(root, 'provider-home'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps the prepared Codex home and refreshes its auth before provider startup', async () => {
  const env: Record<string, string> = {};
  const original = credential('{"fixture":"original"}');
  await materializeHostedProvider(root, env, original, 'fixture-cli');
  const sourceHome = env.CODEX_HOME!;
  const { home, keyringLogin } = await prepareCodexSessionHome({
    root: sourceHome,
    sessionId: 'session',
    sourceHome,
    config: 'model = "fixture-model"',
  });
  expect(keyringLogin).toBe(false);
  env.CODEX_HOME = home;
  await writeFile(join(home, 'auth.json'), '{"fixture":"native-refresh"}');
  await materializeHostedProvider(root, env, original, 'fixture-cli');
  expect(env.CODEX_HOME).toBe(home);
  expect(await readFile(join(home, 'auth.json'), 'utf8')).toContain('native-refresh');
  await materializeHostedProvider(
    root,
    env,
    credential('{"fixture":"replacement"}'),
    'fixture-cli'
  );
  expect(env.CODEX_HOME).toBe(home);
  expect(await readFile(join(home, 'auth.json'), 'utf8')).toContain('replacement');
  expect(await readFile(join(home, 'config.toml'), 'utf8')).toContain('fixture-model');
});

const vertex = (credentials: object): Extract<HostedCredential, { status: 'connected' }> => ({
  ...credential(vertexCredentialFixture(credentials)),
  provider: 'claude',
  kind: 'vertex',
});

it('writes a Vertex AI login’s Google credential under the root, and signs Claude in with it', async () => {
  const env: Record<string, string> = {
    ANTHROPIC_API_KEY: 'sk-ant-inherited',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-inherited',
  };
  await materializeHostedProvider(root, env, vertex(SERVICE_ACCOUNT_KEY_FIXTURE), 'fixture-cli');
  const path = join(root, 'provider-home', 'google-credentials.json');
  expect(env).toEqual({
    CLAUDE_CODE_USE_VERTEX: '1',
    ANTHROPIC_VERTEX_PROJECT_ID: 'acme-ai',
    CLOUD_ML_REGION: 'global',
    GOOGLE_APPLICATION_CREDENTIALS: path,
  });
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  if (process.platform !== 'win32')
    expect((await stat(join(root, 'provider-home'))).mode & 0o777).toBe(0o700);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(SERVICE_ACCOUNT_KEY_FIXTURE);

  await materializeHostedProvider(root, env, vertex(AUTHORIZED_USER_FIXTURE), 'fixture-cli');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(AUTHORIZED_USER_FIXTURE);
  expect((await readdir(join(root, 'provider-home'))).sort()).toEqual([
    'google-credentials.json',
    'google-credentials.json.switch-credential',
  ]);
});

it('clears the Vertex AI variables when Claude is given another login', async () => {
  const env: Record<string, string> = {};
  await materializeHostedProvider(root, env, vertex(SERVICE_ACCOUNT_KEY_FIXTURE), 'fixture-cli');
  await materializeHostedProvider(
    root,
    env,
    { ...credential('sk-ant-oat-given'), provider: 'claude', kind: 'setup-token' },
    'fixture-cli'
  );
  expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-given' });
});

it('refuses a Vertex AI login for another provider than Claude, or one that is not valid', async () => {
  await expect(
    materializeHostedProvider(
      root,
      {},
      { ...vertex(SERVICE_ACCOUNT_KEY_FIXTURE), provider: 'codex' },
      'fixture-cli'
    )
  ).rejects.toThrow(/Only Claude/);
  await expect(
    materializeHostedProvider(
      root,
      {},
      vertex({ ...SERVICE_ACCOUNT_KEY_FIXTURE, type: 'external_account' }),
      'fixture-cli'
    )
  ).rejects.toThrow(/Only a service account key/);
  await expect(stat(join(root, 'provider-home'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('deletes every login file a given login can leave under the root, and nothing else', async () => {
  // A Vertex login written the way an agent host writes it, then each other
  // provider's file and the markers beside it, and a file that is not a login.
  await materializeHostedProvider(
    root,
    {},
    {
      status: 'connected',
      revision: '1',
      provider: 'claude',
      kind: 'vertex',
      credential: vertexCredentialFixture(SERVICE_ACCOUNT_KEY_FIXTURE),
    },
    'claude'
  );
  for (const relative of HOSTED_LOGIN_FILES.slice(1)) {
    const path = join(root, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'secret');
    await writeFile(`${path}.switch-new`, 'secret');
  }
  await writeFile(join(root, 'provider-home', 'settings.json'), '{}');

  const removed = await removeHostedLoginFiles(root);

  expect(removed).toEqual(
    expect.arrayContaining([
      'provider-home/google-credentials.json',
      'provider-home/google-credentials.json.switch-credential',
      'provider-home/auth.json',
      'provider-data/opencode/auth.json.switch-new',
      'provider-home/antigravity-acp/acp_token.json',
    ])
  );
  for (const relative of HOSTED_LOGIN_FILES)
    for (const suffix of ['', '.switch-credential', '.switch-new'])
      await expect(stat(join(root, relative + suffix))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(root, 'provider-home', 'settings.json'), 'utf8')).toBe('{}');
  expect(await removeHostedLoginFiles(root)).toEqual([]);
});
