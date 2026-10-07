import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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

/**
 * Git's configuration for a cloud deployment given a personal token
 * (`GH_TOKEN`) rather than the agent's GitHub grant, and for the bootstrap's
 * own clone: the helper this bundle runs answers with `GH_TOKEN`
 * (`service-github.ts`). It is saved in the deployment's plan, so it stays as
 * it is.
 */
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

class RepositoryStepError extends Error {}

/**
 * Makes `workspace` a worktree on `switch/<agentId>` over the bare mirror every
 * agent on the machine shares for `repository`. Every git command that changes
 * the mirror holds `<mirror>.lock`, so concurrent agents take turns.
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
    if (
      common !== null &&
      (await realpath(resolve(workspace, common)).catch(() => null)) === (await realpath(mirror))
    )
      return;
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
