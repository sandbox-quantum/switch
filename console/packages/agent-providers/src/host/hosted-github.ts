import { execFile, spawn } from 'node:child_process';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
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
  const credentialsPath = process.env.SWITCH_HOSTED_GITHUB_REFRESH_CREDENTIALS;
  if (!credentialsPath) return process.env.GH_TOKEN;
  return renewGitHubCredential(credentialsPath, process.env.SWITCH_HOSTED_GITHUB_REPOSITORY);
}

export async function renewGitHubCredential(
  credentialsPath: string,
  repository: string | undefined
): Promise<string> {
  try {
    const { env } = JSON.parse(await readFile(credentialsPath, 'utf8'));
    const endpoint = new URL(env.SWITCH_API_ENDPOINT);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !validToken(env.SWITCH_API_TOKEN)
    )
      throw new Error();
    const response = await fetch(endpoint.href.replace(/\/$/, '') + '/hosted/github-credential', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SWITCH_API_TOKEN}` },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
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

export async function ensureHostedRepository(
  workspace: string,
  repository: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const url = `https://github.com/${repository}.git`;
  const run = promisify(execFile);
  try {
    if ((await readdir(workspace)).length === 0) {
      await run('git', ['clone', '--', url, workspace], {
        env,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
    } else {
      const { stdout } = await run('git', ['-C', workspace, 'remote', 'get-url', 'origin'], {
        env,
        timeout: 10_000,
      });
      if (stdout.trim() !== url) throw new Error();
    }
  } catch {
    throw new Error(
      'Could not prepare the selected GitHub repository. Check repository access and the saved workspace.'
    );
  }
}
