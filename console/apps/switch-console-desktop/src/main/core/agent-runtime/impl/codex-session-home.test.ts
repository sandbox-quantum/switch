import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareCodexSessionHome } from './codex-session-home';

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
  await writeFile(join(sourceHome, 'config.toml'), 'unrelated-user-config');
  const input = {
    root: join(root, 'sessions'),
    sessionId: '../session',
    sourceHome,
    config: 'model = "test-model"',
    skill: 'Switch workflow',
  };
  const home = await prepareCodexSessionHome(input);
  expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(input.config);
  expect(await readFile(join(home, 'skills/switch/SKILL.md'), 'utf8')).toBe(input.skill);
  expect(await readdir(home)).toEqual(['auth.json', 'config.toml', 'skills']);
  if (process.platform !== 'win32')
    expect((await stat(join(home, 'auth.json'))).mode & 0o777).toBe(0o600);
  await writeFile(join(home, 'auth.json'), 'refreshed-fixture');
  await mkdir(join(home, 'sessions'));
  expect(await prepareCodexSessionHome(input)).toBe(home);
  expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('refreshed-fixture');
  expect(await readFile(join(sourceHome, 'config.toml'), 'utf8')).toBe('unrelated-user-config');
  const other = await prepareCodexSessionHome({ ...input, sessionId: 'other' });
  expect(other).not.toBe(home);
});

it('fails clearly when there is no login to copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-test-'));
  roots.push(root);
  await expect(
    prepareCodexSessionHome({
      root,
      sessionId: 'session',
      sourceHome: join(root, 'missing'),
      config: '',
      skill: '',
    })
  ).rejects.toThrow('codex login');
});
