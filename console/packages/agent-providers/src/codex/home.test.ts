import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareCodexSessionHome, withManagedCodexSandbox } from './home';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('isolates config, preserves rollouts and refreshed auth on resume, and protects credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-test-'));
  roots.push(root);
  const sourceHome = join(root, 'source');
  await mkdir(sourceHome);
  await writeFile(join(sourceHome, 'auth.json'), 'fixture-login');
  await writeFile(join(sourceHome, 'config.toml'), 'model_reasoning_effort = "high"');
  const input = {
    root: join(root, 'sessions'),
    sessionId: '../session',
    sourceHome,
    config: 'model = "test-model"',
  };
  const { home, keyringLogin } = await prepareCodexSessionHome(input);
  expect(keyringLogin).toBe(false);
  expect(parse(await readFile(join(home, 'config.toml'), 'utf8'))).toEqual({
    model: 'test-model',
    model_reasoning_effort: 'high',
  });
  expect((await readdir(home)).filter((name) => name !== 'skills')).toEqual([
    'auth.json',
    'config.toml',
  ]);
  if (process.platform !== 'win32')
    expect((await stat(join(home, 'auth.json'))).mode & 0o777).toBe(0o600);
  await writeFile(join(home, 'auth.json'), 'refreshed-fixture');
  await mkdir(join(home, 'sessions'));
  expect(await prepareCodexSessionHome(input)).toEqual({ home, keyringLogin: false });
  expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('refreshed-fixture');
  expect(await readFile(join(sourceHome, 'config.toml'), 'utf8')).toBe(
    'model_reasoning_effort = "high"'
  );
  const other = await prepareCodexSessionHome({ ...input, sessionId: 'other' });
  expect(other.home).not.toBe(home);
});

it('hands the session a keyring login when the source home has no auth.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-test-'));
  roots.push(root);
  const { home, keyringLogin } = await prepareCodexSessionHome({
    root,
    sessionId: 'session',
    sourceHome: join(root, 'missing'),
    config: '',
  });
  expect(keyringLogin).toBe(true);
  expect(await readdir(home)).not.toContain('auth.json');
});

it('drops a login copied before the machine moved its own to the keyring', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-test-'));
  roots.push(root);
  const sourceHome = join(root, 'source');
  await mkdir(sourceHome);
  await writeFile(join(sourceHome, 'auth.json'), 'fixture-login');
  const input = { root: join(root, 'sessions'), sessionId: 'session', sourceHome, config: '' };
  const { home } = await prepareCodexSessionHome(input);
  await writeFile(join(home, '.switch-auth-source'), 'fixture-fingerprint');
  await rm(join(sourceHome, 'auth.json'));
  expect(await prepareCodexSessionHome(input)).toEqual({ home, keyringLogin: true });
  expect(await readdir(home)).not.toContain('auth.json');
  expect(await readdir(home)).not.toContain('.switch-auth-source');
});

it('removes a Switch skill file an earlier build left in the session home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-test-'));
  roots.push(root);
  const input = {
    root,
    sessionId: 'session',
    sourceHome: join(root, 'missing'),
    config: '',
  };
  const { home } = await prepareCodexSessionHome(input);
  await mkdir(join(home, 'skills/switch'), { recursive: true });
  await writeFile(join(home, 'skills/switch/SKILL.md'), 'old copy');
  await prepareCodexSessionHome(input);
  await expect(stat(join(home, 'skills/switch'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('links the user’s own Codex skills into a session home that has no skills folder yet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-test-'));
  roots.push(root);
  const sourceHome = join(root, 'source');
  await mkdir(join(sourceHome, 'skills', '.system'), { recursive: true });
  await writeFile(join(sourceHome, 'skills', '.system', 'SKILL.md'), 'system skill');
  const { home } = await prepareCodexSessionHome({
    root: join(root, 'sessions'),
    sessionId: 'session',
    sourceHome,
    config: '',
  });
  expect(await readFile(join(home, 'skills', '.system', 'SKILL.md'), 'utf8')).toBe('system skill');
});

describe('withManagedCodexSandbox', () => {
  it('lets a managed agent write in its workspace, or anywhere when it bypasses permissions', () => {
    expect(parse(withManagedCodexSandbox('web_search = true\n', 'approval-required'))).toEqual({
      sandbox_mode: 'workspace-write',
      web_search: true,
    });
    expect(parse(withManagedCodexSandbox('', 'full-access'))).toEqual({
      sandbox_mode: 'danger-full-access',
    });
  });

  it('keeps an agent in auto mode in its workspace sandbox', () => {
    expect(parse(withManagedCodexSandbox('', 'auto'))).toEqual({ sandbox_mode: 'workspace-write' });
  });

  it('keeps a sandbox the configuration already names', () => {
    const config = 'sandbox_mode = "read-only"\n[mcp_servers.x]\ncommand = "x"\n';
    expect(withManagedCodexSandbox(config, 'full-access')).toBe(config);
  });

  it('puts the sandbox before any table, where TOML reads it as top level', () => {
    const merged = withManagedCodexSandbox('[mcp_servers.x]\ncommand = "x"\n', 'approval-required');
    expect(parse(merged)).toMatchObject({ sandbox_mode: 'workspace-write' });
  });
});
