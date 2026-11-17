import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setGitExecutableOverride } from '@main/core/utils/exec';
import { localGitIgnoreCheck, remoteGitIgnoreCheck } from './git-ignore-check';

describe('localGitIgnoreCheck', () => {
  let parent: string;
  let dir: string;
  const isolated = { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  const previous: Record<string, string | undefined> = {};
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        '-c',
        'commit.gpgsign=false',
      ].concat(args),
      { cwd: dir, env: { ...process.env, ...isolated } }
    );

  beforeAll(() => {
    for (const [name, value] of Object.entries(isolated)) {
      previous[name] = process.env[name];
      process.env[name] = value;
    }
  });
  afterAll(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  beforeEach(async () => {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), 'git-ignore-check-'));
    dir = path.join(parent, 'work');
    await fs.mkdir(dir);
    // A temporary directory inside some repository must not make this one part of it.
    process.env.GIT_CEILING_DIRECTORIES = parent;
  });
  afterEach(async () => {
    delete process.env.GIT_CEILING_DIRECTORIES;
    setGitExecutableOverride(null);
    await fs.rm(parent, { recursive: true, force: true });
  });

  it('tells an ignored path from one git would stage', async () => {
    git('init', '-q');
    await fs.writeFile(path.join(dir, '.gitignore'), 'secret.json\n');

    expect(await localGitIgnoreCheck(dir)('secret.json')).toBe('ignored');
    expect(await localGitIgnoreCheck(dir)('other.json')).toBe('not-ignored');
  });

  it('calls a tracked file not ignored, whatever a .gitignore says', async () => {
    git('init', '-q');
    await fs.writeFile(path.join(dir, 'secret.json'), '{}\n');
    git('add', 'secret.json');
    git('commit', '-q', '-m', 'seed');
    await fs.writeFile(path.join(dir, '.gitignore'), 'secret.json\n');

    expect(await localGitIgnoreCheck(dir)('secret.json')).toBe('not-ignored');
  });

  it('has nothing to ask outside a repository, in a directory not made yet, or without git', async () => {
    expect(await localGitIgnoreCheck(dir)('secret.json')).toBe('outside-git');
    expect(await localGitIgnoreCheck(path.join(dir, 'missing'))('secret.json')).toBe('outside-git');
    git('init', '-q');
    setGitExecutableOverride(path.join(parent, 'no-such-git'));
    expect(await localGitIgnoreCheck(dir)('secret.json')).toBe('outside-git');
  });
});

describe('remoteGitIgnoreCheck', () => {
  const failing = (fields: Record<string, unknown>) =>
    Object.assign(new Error('Process exited'), fields);

  it('asks git in the remote working directory about the path', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));

    expect(await remoteGitIgnoreCheck({ exec }, '/srv/repo')('.switch/agents/a.json')).toBe(
      'ignored'
    );
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'check-ignore', '-q', '--', '.switch/agents/a.json'],
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  it('reads the exit status: 1 not ignored, 127 or 128 nothing to ask', async () => {
    const answer = (code: number) =>
      remoteGitIgnoreCheck({ exec: () => Promise.reject(failing({ code })) }, '/srv/repo')('a');

    expect(await answer(1)).toBe('not-ignored');
    expect(await answer(127)).toBe('outside-git');
    expect(await answer(128)).toBe('outside-git');
    await expect(answer(129)).rejects.toThrow('Could not ask git whether a is ignored');
  });

  it('lets a broken connection through as it is', async () => {
    const broken = new Error('SSH transport failure: Not connected');

    await expect(
      remoteGitIgnoreCheck({ exec: () => Promise.reject(broken) }, '/srv/repo')('a')
    ).rejects.toBe(broken);
  });
});
