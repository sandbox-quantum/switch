import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

const MAX_TOKEN_BYTES = 16 * 1024;

function validToken(token: string): boolean {
  return token.length > 0 && token.length <= MAX_TOKEN_BYTES && /^[\x21-\x7e]+$/.test(token);
}

export async function readGitHubCredential(path: string): Promise<string> {
  try {
    const token = (await readFile(path, 'utf8')).trim();
    if (!validToken(token)) throw new Error();
    return token;
  } catch {
    throw new Error('GitHub credential file is missing or invalid.');
  }
}

export async function validateGitHubCredential(token: string, repository?: string): Promise<void> {
  if (!validToken(token)) throw new Error('GitHub credential is invalid.');
  if (
    repository !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/.test(repository)
  )
    throw new Error('GitHub repository must be an owner/repository name.');
  let response: Response;
  try {
    response = await fetch(
      repository ? `https://api.github.com/repos/${repository}` : 'https://api.github.com/user',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      }
    );
  } catch {
    throw new Error('GitHub credential validation could not reach GitHub; retry when connected.');
  }
  // Never include the remote body or a transport exception in diagnostics.
  try {
    await response.body?.cancel();
  } catch {
    throw new Error('GitHub credential validation failed while closing the response.');
  }
  if (response.status === 401)
    throw new Error('GitHub rejected the credential; replace the expired or revoked token.');
  if (response.status === 403)
    throw new Error(
      'GitHub denied the credential check; check token permissions, organization policy or rate limits.'
    );
  if (response.status !== 200)
    throw new Error(
      'GitHub credential validation failed; retry or review the supplied personal token.'
    );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Non-secret command configuration; only GH_TOKEN is supplied separately at launch. */
export function githubLaunchEnvironment(
  entrypoint = fileURLToPath(new URL('./hosted-bootstrap.mjs', import.meta.url))
): Record<string, string> {
  return {
    GH_HOST: 'github.com',
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '3',
    // Clear inherited credential stores before selecting this non-persistent helper.
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: `!${shellQuote(process.execPath)} ${shellQuote(entrypoint)} --git-credential`,
    GIT_CONFIG_KEY_2: 'core.askPass',
    GIT_CONFIG_VALUE_2: '',
  };
}

/**
 * Set on an agent unit's watcher whose workspace is a worktree of a
 * repository (`hostedUnitGitHubEnvironment`), and inherited by the session
 * hosts it starts: where the unit's Switch credentials are, which repository
 * they renew a token for, and the directory holding the `gh` wrapper.
 */
export const HOSTED_GITHUB_CREDENTIALS_ENV = 'SWITCH_HOSTED_GITHUB_REFRESH_CREDENTIALS';
export const HOSTED_GITHUB_REPOSITORY_ENV = 'SWITCH_HOSTED_GITHUB_REPOSITORY';
export const HOSTED_GITHUB_CLI_ENV = 'SWITCH_HOSTED_GITHUB_CLI';

/**
 * What a session's provider is given on top of its own environment so `git`
 * and `gh` renew the repository token through the unit's credentials: empty
 * on a host that sets none of the variables above. It replaces whatever a
 * session saved under an earlier host left in its environment.
 */
export function hostedGitHubEnvironment(
  host: NodeJS.ProcessEnv,
  path: string | undefined
): Record<string, string> {
  const credentials = host[HOSTED_GITHUB_CREDENTIALS_ENV];
  const repository = host[HOSTED_GITHUB_REPOSITORY_ENV];
  const cli = host[HOSTED_GITHUB_CLI_ENV];
  if (!credentials && !repository && !cli) return {};
  if (!credentials || !repository || !cli)
    throw new Error(
      `${HOSTED_GITHUB_CREDENTIALS_ENV}, ${HOSTED_GITHUB_REPOSITORY_ENV} and ${HOSTED_GITHUB_CLI_ENV} are set together.`
    );
  const rest = (path ?? '').split(':').filter((entry) => entry !== '' && entry !== cli);
  return {
    ...githubLaunchEnvironment(),
    [HOSTED_GITHUB_CREDENTIALS_ENV]: credentials,
    [HOSTED_GITHUB_REPOSITORY_ENV]: repository,
    PATH: [cli, ...rest].join(':'),
  };
}

export function githubRedactions(token: string): string[] {
  return [
    token,
    encodeURIComponent(token),
    Buffer.from(`x-access-token:${token}`).toString('base64'),
  ];
}

/** Git credential protocol: no cache/store, no browser, only HTTPS github.com. */
export function gitHubCredentialResponse(operation: string, input: string, token?: string): string {
  if (operation !== 'get') return '';
  if (!token || !validToken(token) || Buffer.byteLength(input) > 64 * 1024) return '';
  const fields = new Map<string, string>();
  for (const line of input.split('\n')) {
    if (line === '') break;
    const at = line.indexOf('=');
    if (at <= 0 || line.includes('\r') || line.includes('\0')) return '';
    const key = line.slice(0, at);
    if (fields.has(key)) return '';
    fields.set(key, line.slice(at + 1));
  }
  if (fields.get('protocol') !== 'https' || fields.get('host') !== 'github.com') return '';
  return `username=x-access-token\npassword=${token}\n\n`;
}

export async function runGitHubCredentialHelper(operation: string | undefined): Promise<void> {
  if (!operation || !['get', 'store', 'erase'].includes(operation))
    throw new Error('Unsupported Git credential operation.');
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 64 * 1024)
      throw new Error('Git credential request is too large.');
  }
  const eligible = gitHubCredentialResponse(operation, input, 'validation-only');
  if (!eligible) return;
  process.stdout.write(gitHubCredentialResponse(operation, input, await currentGitHubToken()));
}

export async function currentGitHubToken(): Promise<string | undefined> {
  const credentialsPath = process.env[HOSTED_GITHUB_CREDENTIALS_ENV];
  if (!credentialsPath) return process.env.GH_TOKEN;
  return renewGitHubCredential(credentialsPath, process.env[HOSTED_GITHUB_REPOSITORY_ENV]);
}

export async function renewGitHubCredential(
  credentialsPath: string,
  repository: string | undefined
): Promise<string> {
  try {
    const { env } = JSON.parse(await readFile(credentialsPath, 'utf8'));
    const endpoint = new URL(env.SWITCH_API_ENDPOINT);
    // Plain HTTP only to an agents controller's relay on this machine.
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname);
    if (
      (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !validToken(env.SWITCH_API_TOKEN)
    )
      throw new Error();
    const request = () =>
      fetch(endpoint.href.replace(/\/$/, '') + '/hosted/github-credential', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.SWITCH_API_TOKEN}` },
        redirect: 'error',
        signal: AbortSignal.timeout(180_000),
      });
    let response = await request();
    if (response.status === 409 || response.status === 503) {
      await response.body?.cancel();
      await delay(1_000);
      response = await request();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    const credential = z
      .object({ token: z.string(), repository: z.string(), expires_at: z.string() })
      .parse(await response.json());
    if (
      !repository ||
      !validToken(credential.token) ||
      credential.repository !== repository ||
      Date.parse(credential.expires_at) < Date.now() + 60_000 ||
      !Number.isFinite(Date.parse(credential.expires_at))
    )
      throw new Error();
    return credential.token;
  } catch {
    throw new Error(
      'Could not renew cloud repository access. Check the owner’s GitHub connection.'
    );
  }
}

export async function prepareGitHubCli(root: string): Promise<string> {
  const directory = join(root, 'bin');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'gh');
  const entrypoint = fileURLToPath(new URL('./hosted-bootstrap.mjs', import.meta.url));
  const source = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(entrypoint)} --github-cli "$@"\n`;
  try {
    const file = await open(path, 'wx', 0o700);
    try {
      await file.writeFile(source);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if ((await readFile(path, 'utf8')) !== source)
      throw new Error('Hosted GitHub CLI wrapper differs from the deployment.');
  }
  return directory;
}

export async function runGitHubCli(args: string[]): Promise<void> {
  const token = await currentGitHubToken();
  if (!token) throw new Error('Cloud repository credential is missing.');
  const child = spawn('/usr/local/bin/gh', args, {
    stdio: 'inherit',
    env: { ...process.env, GH_TOKEN: token },
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error('GitHub CLI could not start.')));
    child.once('exit', (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

class RepositoryStepError extends Error {}

/**
 * Makes `workspace` a worktree on `switch/<agentId>` over the bare mirror of
 * `repository`. Every git command that changes the mirror holds
 * `<mirror>.lock`, so agents sharing one take turns. A workspace that is a
 * worktree of another mirror of the same repository is moved onto this one:
 * its branch is fetched across, its files and index are kept, and the other
 * mirror is only read.
 */
export async function ensureHostedRepository(input: {
  workspace: string;
  mirror: string;
  repository: string;
  agentId: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const { workspace, mirror, env } = input;
  const url = `https://github.com/${input.repository}.git`;
  const lock = `${mirror}.lock`;
  const exec = promisify(execFile);
  const locked = async (step: string, args: string[]) => {
    try {
      await exec('flock', [lock, 'git', ...args], {
        env,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      throw new RepositoryStepError(step);
    }
  };
  const probe = async (args: string[]) => {
    try {
      return (await exec('git', args, { env, timeout: 10_000 })).stdout.trim();
    } catch {
      return null;
    }
  };
  const origin = () => probe(['--git-dir', mirror, 'config', '--get', 'remote.origin.url']);
  try {
    try {
      await mkdir(dirname(mirror), { recursive: true, mode: 0o700 });
    } catch {
      throw new RepositoryStepError('create the mirror directory');
    }
    const bare = await probe(['--git-dir', mirror, 'rev-parse', '--is-bare-repository']);
    if (bare === null) await locked('initialize the mirror', ['init', '--bare', '--', mirror]);
    else if (bare !== 'true') throw new RepositoryStepError('the mirror is not a bare repository');
    if ((await origin()) === null) {
      try {
        await locked('add the mirror origin', ['-C', mirror, 'remote', 'add', 'origin', url]);
      } catch (error) {
        if ((await origin()) === null) throw error;
      }
    }
    if ((await origin())?.toLowerCase() !== url.toLowerCase())
      throw new RepositoryStepError('the mirror belongs to a different repository');
    await locked('fetch the repository', ['-C', mirror, 'fetch', '--prune', 'origin']);
    await locked('resolve the default branch', [
      '-C',
      mirror,
      'remote',
      'set-head',
      'origin',
      '--auto',
    ]);
    const common = await probe(['-C', workspace, 'rev-parse', '--git-common-dir']);
    const commonPath =
      common === null ? null : await realpath(resolve(workspace, common)).catch(() => null);
    if (commonPath !== null && commonPath === (await realpath(mirror))) return;
    if (
      commonPath !== null &&
      (await probe(['-C', workspace, 'rev-parse', '--show-toplevel'])) ===
        (await realpath(workspace)) &&
      (
        await probe(['--git-dir', commonPath, 'config', '--get', 'remote.origin.url'])
      )?.toLowerCase() === url.toLowerCase()
    ) {
      const gitDir = await probe(['-C', workspace, 'rev-parse', '--absolute-git-dir']);
      const admin = gitDir === null ? null : await realpath(gitDir).catch(() => null);
      if (admin === null || dirname(admin) !== join(commonPath, 'worktrees'))
        throw new RepositoryStepError('the workspace is not a linked worktree');
      let head: string;
      try {
        head = (await readFile(join(admin, 'HEAD'), 'utf8')).trim();
      } catch {
        throw new RepositoryStepError('read the workspace branch');
      }
      const branch = /^ref: (refs\/heads\/\S+)$/.exec(head)?.[1];
      if (branch === undefined && !/^[0-9a-f]{40,64}$/.test(head))
        throw new RepositoryStepError('read the workspace branch');
      await locked('move the workspace branch to the mirror', [
        '-C',
        mirror,
        'fetch',
        '--no-tags',
        '--',
        commonPath,
        branch === undefined ? head : `+${branch}:${branch}`,
      ]);
      const moved = join(mirror, 'worktrees', basename(admin));
      try {
        await mkdir(moved, { recursive: true, mode: 0o700 });
        await writeFile(join(moved, 'HEAD'), `${head}\n`);
        await writeFile(join(moved, 'commondir'), '../..\n');
        await writeFile(join(moved, 'gitdir'), `${join(workspace, '.git')}\n`);
        await copyFile(join(admin, 'index'), join(moved, 'index')).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      } catch {
        throw new RepositoryStepError('move the worktree to the mirror');
      }
      let missing: string[];
      try {
        const staged = (
          await exec('git', ['--git-dir', moved, 'ls-files', '-s', '-z'], {
            env,
            timeout: 120_000,
            maxBuffer: 256 * 1024 * 1024,
          })
        ).stdout
          .split('\0')
          .filter((entry) => entry !== '' && !entry.startsWith('160000 '))
          .map((entry) => entry.split(' ')[1]!);
        const check = exec('git', ['--git-dir', mirror, 'cat-file', '--batch-check'], {
          env,
          timeout: 120_000,
          maxBuffer: 256 * 1024 * 1024,
        });
        check.child.stdin!.end([...new Set(staged)].map((sha) => `${sha}\n`).join(''));
        missing = (await check).stdout
          .split('\n')
          .filter((line) => line.endsWith(' missing'))
          .map((line) => line.split(' ')[0]!);
      } catch {
        throw new RepositoryStepError('read the workspace index');
      }
      if (missing.length > 0)
        await locked('move the staged changes to the mirror', [
          '-C',
          mirror,
          'fetch',
          '--no-tags',
          '--',
          commonPath,
          ...missing,
        ]);
      try {
        await writeFile(join(workspace, '.git'), `gitdir: ${moved}\n`);
      } catch {
        throw new RepositoryStepError('move the worktree to the mirror');
      }
      return;
    }
    let entries: string[];
    try {
      entries = await readdir(workspace);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new RepositoryStepError('read the workspace');
      entries = [];
    }
    if (entries.length > 0)
      throw new RepositoryStepError('the workspace holds files that are not its worktree');
    await locked('add the worktree', [
      '-C',
      mirror,
      'worktree',
      'add',
      '-B',
      `switch/${input.agentId}`,
      '--',
      workspace,
      'origin/HEAD',
    ]);
  } catch (error) {
    const step = error instanceof RepositoryStepError ? error.message : 'inspect the repository';
    throw new Error(
      `Could not prepare the selected GitHub repository (${step}). Check repository access and the saved workspace.`
    );
  }
}
