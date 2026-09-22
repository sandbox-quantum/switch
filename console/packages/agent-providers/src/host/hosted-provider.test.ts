import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { materializeHostedProvider, type HostedCredential } from './hosted-provider';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hosted-auth-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const credential = (value: string): Extract<HostedCredential, { status: 'connected' }> => ({
  status: 'connected',
  revision: 'revision-one',
  provider: 'codex',
  kind: 'auth-json',
  credential: value,
  sessions: [],
});

it('preserves a native token refresh until the owner replaces the source credential', async () => {
  const env: Record<string, string> = {};
  await materializeHostedProvider(
    root,
    env,
    credential('{"tokens":{"access_token":"fixture-original"}}')
  );
  const path = join(env.CODEX_HOME!, 'auth.json');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await writeFile(path, '{"tokens":{"access_token":"fixture-refreshed"}}');
  await materializeHostedProvider(
    root,
    env,
    credential('{"tokens":{"access_token":"fixture-original"}}')
  );
  expect(await readFile(path, 'utf8')).toContain('fixture-refreshed');
  await materializeHostedProvider(
    root,
    env,
    credential('{"tokens":{"access_token":"fixture-replaced"}}')
  );
  expect(await readFile(path, 'utf8')).toContain('fixture-replaced');
});

it('rejects malformed credentials before creating an authentication file', async () => {
  await expect(materializeHostedProvider(root, {}, credential('not-json'))).rejects.toThrow(
    'JSON object'
  );
  await expect(stat(join(root, 'provider-home'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not follow an authentication directory symlink', async () => {
  await symlink(tmpdir(), join(root, 'provider-home'));
  await expect(materializeHostedProvider(root, {}, credential('{"fixture":true}'))).rejects.toThrow(
    'symbolic link'
  );
});

it('keeps the different providers in their native authentication locations', async () => {
  for (const [provider, variable, relative] of [
    ['opencode', 'XDG_DATA_HOME', 'opencode/auth.json'],
    ['antigravity', 'GEMINI_HOME', 'antigravity-acp/acp_token.json'],
  ] as const) {
    const env: Record<string, string> = {};
    await materializeHostedProvider(root, env, { ...credential('{"fixture":true}'), provider });
    expect(JSON.parse(await readFile(join(env[variable]!, relative), 'utf8'))).toEqual({
      fixture: true,
    });
  }
});
