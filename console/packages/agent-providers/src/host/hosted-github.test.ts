import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureHostedRepository,
  githubLaunchEnvironment,
  githubRedactions,
  gitHubCredentialResponse,
  readGitHubCredential,
  renewGitHubCredential,
  validateGitHubCredential,
} from './hosted-github';
import { redactHostedText } from './hosted-log';

const roots: string[] = [];
const token = 'synthetic-github-credential';
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

it('provides credentials only for the exact GitHub HTTPS host', () => {
  expect(gitHubCredentialResponse('get', 'protocol=https\nhost=github.com\n\n', token)).toBe(
    `username=x-access-token\npassword=${token}\n\n`
  );
  for (const input of [
    'protocol=http\nhost=github.com\n',
    'protocol=https\nhost=github.com.evil.invalid\n',
    'protocol=https\nhost=github.com:443\n',
    'protocol=https\nhost=other.invalid\nhost=github.com\n',
    'protocol=https\nhost=github.com\r\n',
    'url=https://github.com\n',
  ])
    expect(gitHubCredentialResponse('get', input, token)).toBe('');
  expect(gitHubCredentialResponse('get', 'protocol=https\nhost=github.com\n', undefined)).toBe('');
  expect(gitHubCredentialResponse('store', 'protocol=https\nhost=github.com\n', token)).toBe('');
  expect(gitHubCredentialResponse('erase', 'protocol=https\nhost=github.com\n', token)).toBe('');
});

it('renews only the assigned repository credential and hides failed response bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hosted-github-refresh-'));
  roots.push(root);
  const credentials = join(root, 'switch.json');
  await writeFile(
    credentials,
    JSON.stringify({
      env: {
        SWITCH_API_ENDPOINT: 'https://switch.example.com/api/agent',
        SWITCH_API_TOKEN: 'synthetic-switch-credential',
      },
    })
  );
  const request = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          token,
          repository: 'example/project',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        })
      )
  );
  vi.stubGlobal('fetch', request);
  expect(await renewGitHubCredential(credentials, 'example/project')).toBe(token);
  expect(request.mock.calls[0]).toEqual([
    'https://switch.example.com/api/agent/hosted/github-credential',
    expect.objectContaining({ method: 'POST', redirect: 'error' }),
  ]);
  await expect(renewGitHubCredential(credentials, 'example/other')).rejects.toThrow(
    'Could not renew'
  );
  request.mockImplementation(async () => new Response('remote-secret-body', { status: 403 }));
  await expect(renewGitHubCredential(credentials, 'example/project')).rejects.toThrow(
    'Could not renew'
  );
});

it('keeps raw and common transport encodings out of redacted output', () => {
  const secrets = githubRedactions(token);
  for (const value of secrets) expect(redactHostedText(value, secrets)).toBe('[REDACTED]');
  expect(JSON.stringify(githubLaunchEnvironment())).not.toContain(token);
});

it.each([401, 403, 429, 500, 302])(
  'rejects GitHub status %s without exposing response content',
  async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(token, { status })));
    await expect(validateGitHubCredential(token)).rejects.toThrow(/GitHub/);
    try {
      await validateGitHubCredential(token);
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
  }
);

it('uses only GitHub identity validation and refuses redirects', async () => {
  const request = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', request);
  await validateGitHubCredential(token);
  expect(request).toHaveBeenCalledWith(
    'https://api.github.com/user',
    expect.objectContaining({
      redirect: 'error',
      headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
      signal: expect.any(AbortSignal),
    })
  );
});

it('sanitizes transport failures', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(token)));
  await expect(validateGitHubCredential(token)).rejects.toThrow('could not reach GitHub');
});

it('rejects invalid credentials before a request', async () => {
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  for (const invalid of ['', 'two words', 'one\ntwo', 'é', 'x'.repeat(16385)])
    await expect(validateGitHubCredential(invalid)).rejects.toThrow('credential is invalid');
  expect(request).not.toHaveBeenCalled();
});

it('reads a mounted token and reports a missing file without its path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-token-'));
  roots.push(root);
  const path = join(root, 'credential');
  await writeFile(path, token + '\n', { mode: 0o600 });
  expect(await readGitHubCredential(path)).toBe(token);
  await expect(readGitHubCredential(join(root, token))).rejects.toThrow(
    'GitHub credential file is missing or invalid.'
  );
});

it('authenticates real Git credential requests without writing credentials or consulting stored helpers', async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted github's "));
  roots.push(root);
  const script = join(root, "credential helper's.mjs");
  const moduleUrl = new URL('./hosted-github.ts', import.meta.url).href;
  await writeFile(
    script,
    `import { runGitHubCredentialHelper } from ${JSON.stringify(moduleUrl)}; await runGitHubCredentialHelper(process.argv.at(-1));`
  );
  const marker = join(root, 'unexpected-helper');
  const config = join(root, '.gitconfig');
  await writeFile(config, `[credential]\n\thelper = "!touch '${marker}'"\n`);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    ...githubLaunchEnvironment(script),
    GH_TOKEN: token,
  };
  const git = (operation: string, input: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile('git', ['credential', operation], { env }, (error, stdout, stderr) =>
        resolve({ code: error ? 1 : 0, stdout, stderr })
      );
      child.stdin!.end(input);
    });
  const success = await git('fill', 'protocol=https\nhost=github.com\n\n');
  expect(success.code, success.stderr).toBe(0);
  expect(success.stdout).toContain(`password=${token}`);
  const rejected = await git('fill', 'protocol=https\nhost=other.invalid\n\n');
  expect(rejected.code).toBe(1);
  expect(rejected.stdout + rejected.stderr).not.toContain(token);
  await git(
    'approve',
    `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${token}\n\n`
  );
  await git('reject', `protocol=https\nhost=github.com\n\n`);
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(config, 'utf8')).not.toContain(token);
  await expect(readFile(join(root, '.git-credentials'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('validates installation tokens against the selected repository instead of a user identity', async () => {
  const request = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', request);
  await validateGitHubCredential(token, 'example/project');
  expect(request).toHaveBeenCalledWith(
    'https://api.github.com/repos/example/project',
    expect.objectContaining({ redirect: 'error' })
  );
});

it.each([
  '../project',
  'example/..',
  'example/project?token=secret',
  'example/project/extra',
  'https://example.com/project',
])('rejects unsafe repository selection %s', async (repository) => {
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  await expect(validateGitHubCredential(token, repository)).rejects.toThrow('repository');
  expect(request).not.toHaveBeenCalled();
});

it.each([409, 503, 422])('retries a token renewal only for retryable status %s', async (status) => {
  const root = await mkdtemp(join(tmpdir(), 'hosted-github-retry-'));
  roots.push(root);
  const path = join(root, 'switch.json');
  await writeFile(
    path,
    JSON.stringify({
      env: {
        SWITCH_API_ENDPOINT: 'https://switch.example.com/api/agent',
        SWITCH_API_TOKEN: 'synthetic-switch-credential',
      },
    })
  );
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response('unavailable', { status }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token,
          repository: 'example/project',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        })
      )
    );
  vi.stubGlobal('fetch', request);
  if (status === 422) {
    await expect(renewGitHubCredential(path, 'example/project')).rejects.toThrow('Could not renew');
    expect(request).toHaveBeenCalledTimes(1);
  } else {
    expect(await renewGitHubCredential(path, 'example/project')).toBe(token);
    expect(request).toHaveBeenCalledTimes(2);
  }
});

describe('ensureHostedRepository', () => {
  const exec = promisify(execFile);
  const AGENT = '00000000-0000-4000-8000-000000000001';
  const OTHER = '00000000-0000-4000-8000-000000000002';

  /** util-linux `flock <file> <command...>`, which macOS lacks. */
  const FLOCK_SHIM = [
    '#!/usr/bin/env python3',
    'import fcntl, os, sys',
    'fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)',
    'os.set_inheritable(fd, True)',
    'fcntl.flock(fd, fcntl.LOCK_EX)',
    'os.execvp(sys.argv[2], sys.argv[2:])',
    '',
  ].join('\n');

  async function repositories() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-repository-')));
    roots.push(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'flock'), FLOCK_SHIM);
    await chmod(join(bin, 'flock'), 0o755);
    const upstream = join(root, 'upstream');
    const env: NodeJS.ProcessEnv = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${upstream}/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/',
    };
    const git = async (...args: string[]) => (await exec('git', args, { env })).stdout.trim();
    const seed = join(root, 'seed');
    await git('init', '--bare', '-b', 'main', join(upstream, 'example', 'project.git'));
    await git('init', '--bare', '-b', 'main', join(upstream, 'example', 'other.git'));
    await git('init', '-b', 'main', seed);
    const commit = async (message: string) => {
      await writeFile(join(seed, 'README.md'), `${message}\n`);
      await git('-C', seed, 'add', 'README.md');
      await git('-C', seed, 'commit', '-m', message);
      await git('-C', seed, 'push', '-q', 'https://github.com/example/project.git', 'main');
      return git('-C', seed, 'rev-parse', 'HEAD');
    };
    const mirror = join(root, 'repos', 'example', 'project.git');
    const workspace = (agentId: string) => join(root, 'worktrees', agentId, 'example', 'project');
    const ensure = (agentId: string, repository = 'example/project') =>
      ensureHostedRepository({
        workspace: workspace(agentId),
        mirror,
        repository,
        agentId,
        env,
      });
    return { root, env, git, commit, mirror, workspace, ensure };
  }

  it('creates the mirror and a worktree on the agent branch at the default branch', async () => {
    const { git, commit, mirror, workspace, ensure } = await repositories();
    const head = await commit('first');
    await mkdir(workspace(AGENT), { recursive: true });
    await ensure(AGENT);
    expect(await git('--git-dir', mirror, 'rev-parse', '--is-bare-repository')).toBe('true');
    expect(await git('--git-dir', mirror, 'config', 'remote.origin.url')).toBe(
      'https://github.com/example/project.git'
    );
    expect(await git('--git-dir', mirror, 'config', 'remote.origin.fetch')).toBe(
      '+refs/heads/*:refs/remotes/origin/*'
    );
    expect(await git('-C', workspace(AGENT), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      `switch/${AGENT}`
    );
    expect(await git('-C', workspace(AGENT), 'rev-parse', 'HEAD')).toBe(head);
    expect(await readFile(join(workspace(AGENT), 'README.md'), 'utf8')).toBe('first\n');
  });

  it('gives a second agent its own worktree over the same mirror', async () => {
    const { git, commit, mirror, workspace, ensure } = await repositories();
    const head = await commit('first');
    await ensure(AGENT);
    await ensure(OTHER);
    for (const agentId of [AGENT, OTHER]) {
      const common = await git('-C', workspace(agentId), 'rev-parse', '--git-common-dir');
      expect(await realpath(resolve(workspace(agentId), common))).toBe(mirror);
      expect(await git('-C', workspace(agentId), 'rev-parse', 'HEAD')).toBe(head);
    }
    expect(await git('-C', workspace(OTHER), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      `switch/${OTHER}`
    );
    const listed = await git('--git-dir', mirror, 'worktree', 'list', '--porcelain');
    expect(listed).toContain(`worktree ${workspace(AGENT)}`);
    expect(listed).toContain(`worktree ${workspace(OTHER)}`);
  });

  it('accepts its existing worktree on a rerun and still fetches', async () => {
    const { git, commit, mirror, workspace, ensure } = await repositories();
    const first = await commit('first');
    await ensure(AGENT);
    await writeFile(join(workspace(AGENT), 'work.txt'), 'in progress\n');
    const second = await commit('second');
    await ensure(AGENT);
    expect(await git('--git-dir', mirror, 'rev-parse', 'refs/remotes/origin/main')).toBe(second);
    expect(await git('-C', workspace(AGENT), 'rev-parse', 'HEAD')).toBe(first);
    expect(await readFile(join(workspace(AGENT), 'work.txt'), 'utf8')).toBe('in progress\n');
  });

  it('refuses a non-empty workspace that is not a worktree of the mirror', async () => {
    const { commit, mirror, workspace, ensure, git } = await repositories();
    await commit('first');
    await mkdir(workspace(AGENT), { recursive: true });
    await writeFile(join(workspace(AGENT), 'stray.txt'), 'kept\n');
    await expect(ensure(AGENT)).rejects.toThrow(
      'Could not prepare the selected GitHub repository (the workspace holds files that are not its worktree).'
    );
    expect(await readFile(join(workspace(AGENT), 'stray.txt'), 'utf8')).toBe('kept\n');
    expect(await git('--git-dir', mirror, 'worktree', 'list', '--porcelain')).not.toContain(
      workspace(AGENT)
    );
  });

  it('shares the mirror with an agent that names the repository in another case', async () => {
    const { git, commit, mirror, workspace, ensure } = await repositories();
    const head = await commit('first');
    await ensure(AGENT);
    await ensure(OTHER, 'Example/Project');
    const common = await git('-C', workspace(OTHER), 'rev-parse', '--git-common-dir');
    expect(await realpath(resolve(workspace(OTHER), common))).toBe(mirror);
    expect(await git('-C', workspace(OTHER), 'rev-parse', 'HEAD')).toBe(head);
  });

  it('refuses a mirror whose origin is a different repository', async () => {
    const { commit, mirror, workspace, ensure, git } = await repositories();
    await commit('first');
    await git('init', '--bare', mirror);
    await git(
      '--git-dir',
      mirror,
      'remote',
      'add',
      'origin',
      'https://github.com/example/other.git'
    );
    await expect(ensure(AGENT)).rejects.toThrow(
      'Could not prepare the selected GitHub repository (the mirror belongs to a different repository).'
    );
    await expect(readFile(join(workspace(AGENT), 'README.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('waits for the mirror lock before touching the mirror', async () => {
    const { root, commit, mirror, ensure, git } = await repositories();
    await commit('first');
    await ensure(AGENT);
    const second = await commit('second');
    const holder = spawn(
      'python3',
      [
        '-c',
        'import fcntl, os, sys\n' +
          'fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)\n' +
          'fcntl.flock(fd, fcntl.LOCK_EX)\n' +
          'print("locked", flush=True)\n' +
          'sys.stdin.read()\n',
        `${mirror}.lock`,
      ],
      { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] }
    );
    try {
      await new Promise<void>((resolve, reject) => {
        holder.once('error', reject);
        holder.stdout!.once('data', () => resolve());
      });
      let settled = false;
      const pending = ensure(AGENT).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(settled).toBe(false);
      expect(await git('--git-dir', mirror, 'rev-parse', 'refs/remotes/origin/main')).not.toBe(
        second
      );
      holder.stdin!.end();
      await pending;
      expect(await git('--git-dir', mirror, 'rev-parse', 'refs/remotes/origin/main')).toBe(second);
    } finally {
      holder.kill();
    }
  }, 15_000);
});
