import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, expect, it } from 'vitest';
import { prepareCodexSessionHome } from './home';

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
  const home = await prepareCodexSessionHome(input);
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
  expect(await prepareCodexSessionHome(input)).toBe(home);
  expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('refreshed-fixture');
  expect(await readFile(join(sourceHome, 'config.toml'), 'utf8')).toBe(
    'model_reasoning_effort = "high"'
  );
  const other = await prepareCodexSessionHome({ ...input, sessionId: 'other' });
  expect(other).not.toBe(home);
});

it('allows native environment or keychain authentication when no login file exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-test-'));
  roots.push(root);
  await expect(
    prepareCodexSessionHome({
      root,
      sessionId: 'session',
      sourceHome: join(root, 'missing'),
      config: '',
    })
  ).resolves.toEqual(expect.any(String));
});

it('removes a Switch skill file an earlier build left in the session home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-test-'));
  roots.push(root);
  const input = { root, sessionId: 'session', sourceHome: join(root, 'missing'), config: '' };
  const home = await prepareCodexSessionHome(input);
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
  const home = await prepareCodexSessionHome({
    root: join(root, 'sessions'),
    sessionId: 'session',
    sourceHome,
    config: '',
  });
  expect(await readFile(join(home, 'skills', '.system', 'SKILL.md'), 'utf8')).toBe('system skill');
});
