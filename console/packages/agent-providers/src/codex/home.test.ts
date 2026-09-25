import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, expect, it, vi } from 'vitest';
import { migrateCodexRollout, prepareCodexSessionHome } from './home';

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
    skill: 'Switch workflow',
  };
  const home = await prepareCodexSessionHome(input);
  expect(parse(await readFile(join(home, 'config.toml'), 'utf8'))).toEqual({
    model: 'test-model',
    model_reasoning_effort: 'high',
  });
  expect(await readFile(join(home, 'skills/switch/SKILL.md'), 'utf8')).toBe(input.skill);
  expect(await readdir(home)).toEqual([
    '.switch-auth-source',
    'auth.json',
    'config.toml',
    'skills',
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
  await rm(join(home, '.switch-auth-source'));
  await prepareCodexSessionHome(input);
  expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('refreshed-fixture');
  expect((await stat(join(home, '.switch-auth-source'))).mode & 0o777).toBe(0o600);
  await writeFile(join(sourceHome, 'auth.json'), 'replacement-fixture');
  await prepareCodexSessionHome(input);
  expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('replacement-fixture');
  const other = await prepareCodexSessionHome({ ...input, sessionId: 'other' });
  expect(other).not.toBe(home);
  await rm(join(home, 'auth.json'));
  await symlink(join(sourceHome, 'auth.json'), join(home, 'auth.json'));
  await expect(prepareCodexSessionHome(input)).rejects.toThrow('must be a regular file');
  expect(await readFile(join(sourceHome, 'auth.json'), 'utf8')).toBe('replacement-fixture');
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
      skill: '',
    })
  ).resolves.toEqual(expect.any(String));
});

it.each(['nested', 'parent', 'missing'] as const)(
  'preserves the saved thread in the %s layout',
  async (layout) => {
    const root = await mkdtemp(join(tmpdir(), 'codex-migration-test-'));
    roots.push(root);
    const sourceHome = join(root, 'provider-home');
    const home = await prepareCodexSessionHome({
      root: sourceHome,
      sessionId: 'session',
      sourceHome,
      config: '',
      skill: '',
    });
    const nativeSessionId = '11111111-1111-4111-8111-111111111111';
    const relative = `sessions/2026/01/01/rollout-2026-01-01T00-00-00-${nativeSessionId}.jsonl`;
    for (const base of [sourceHome, home])
      await mkdir(join(base, 'sessions/2026/01/01'), { recursive: true });
    const unrelated = join(sourceHome, 'sessions/2026/01/01/rollout-other-thread.jsonl');
    await writeFile(unrelated, 'another conversation');
    if (layout !== 'missing')
      await writeFile(
        join(layout === 'nested' ? home : sourceHome, relative),
        'saved conversation'
      );
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await migrateCodexRollout({ home, sourceHome, nativeSessionId, sessionId: 'session' });
      if (layout === 'missing')
        await expect(readFile(join(home, relative))).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(join(home, relative), 'utf8')).toBe('saved conversation');
      expect(await readFile(unrelated, 'utf8')).toBe('another conversation');
      expect(warning).toHaveBeenCalledTimes(layout === 'parent' ? 1 : 0);
      await expect(readFile(join(sourceHome, relative))).rejects.toMatchObject({ code: 'ENOENT' });
      await migrateCodexRollout({ home, sourceHome, nativeSessionId, sessionId: 'session' });
      expect(warning).toHaveBeenCalledTimes(layout === 'parent' ? 1 : 0);
    } finally {
      warning.mockRestore();
    }
  }
);
