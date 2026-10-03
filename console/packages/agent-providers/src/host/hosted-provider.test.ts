import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareCodexSessionHome } from '../codex/home';
import {
  fetchHostedProvider,
  hostedRequest,
  materializeHostedProvider,
  type HostedCredential,
} from './hosted-provider';
import type { SharedHostConfig } from './shared-config';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hosted-auth-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

async function hostedConfig(
  endpoint = 'https://switch.invalid/api/agent'
): Promise<SharedHostConfig> {
  const credentialsPath = join(root, 'switch.json');
  await writeFile(
    credentialsPath,
    JSON.stringify({
      env: {
        SWITCH_API_ENDPOINT: endpoint,
        SWITCH_API_TOKEN: 'switch-token-fixture',
        SWITCH_AGENT_ID: 'agent-id',
      },
    })
  );
  return {
    session: { agentId: 'agent-id' },
    start: { provider: 'claude' },
    execution: { credentialsPath },
  } as unknown as SharedHostConfig;
}

it('reads a connected credential and refuses one for another provider', async () => {
  const body = {
    status: 'connected',
    revision: 'revision-one',
    provider: 'claude',
    kind: 'api-key',
    credential: 'fixture-key',
  };
  const request = vi.fn(async () => new Response(JSON.stringify(body)));
  vi.stubGlobal('fetch', request);
  const config = await hostedConfig();
  expect(await fetchHostedProvider(config)).toEqual(body);
  expect(request).toHaveBeenCalledWith(
    'https://switch.invalid/api/agent/hosted/provider-credential',
    expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer switch-token-fixture' },
    })
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ...body, provider: 'codex' })))
  );
  await expect(fetchHostedProvider(config)).rejects.toThrow('do not match this session');
});

it('reports a forbidden credential read as revoked and other failures loudly', async () => {
  const config = await hostedConfig();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 403 }))
  );
  expect(await fetchHostedProvider(config)).toEqual({ status: 'revoked' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 500 }))
  );
  await expect(fetchHostedProvider(config)).rejects.toThrow('HTTP 500');
  await expect(hostedRequest(config, '/provider-status', {})).rejects.toThrow('HTTP 500');
});

it('refuses a non-HTTPS Switch origin', async () => {
  const config = await hostedConfig('http://switch.invalid/api/agent');
  await expect(fetchHostedProvider(config)).rejects.toThrow('HTTPS');
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
  expect((await stat(path)).mode & 0o777).toBe(0o600);
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
  for (const [provider, variable, relative] of [
    ['opencode', 'XDG_DATA_HOME', 'opencode/auth.json'],
    ['antigravity', 'GEMINI_HOME', 'antigravity-acp/acp_token.json'],
  ] as const) {
    const env: Record<string, string> = {};
    await materializeHostedProvider(
      root,
      env,
      { ...credential('{"fixture":true}'), provider },
      'fixture-cli'
    );
    expect(JSON.parse(await readFile(join(env[variable]!, relative), 'utf8'))).toEqual({
      fixture: true,
    });
  }
});

it('keeps the prepared Codex home and refreshes its auth before provider startup', async () => {
  const env: Record<string, string> = {};
  const original = credential('{"fixture":"original"}');
  await materializeHostedProvider(root, env, original, 'fixture-cli');
  const sourceHome = env.CODEX_HOME!;
  const home = await prepareCodexSessionHome({
    root: sourceHome,
    sessionId: 'session',
    sourceHome,
    config: 'model = "fixture-model"',
    auth: 'refresh',
  });
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
