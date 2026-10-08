import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { z } from 'zod';

/**
 * GitHub for a session whose agent has a GitHub grant: Git's credential
 * helper and a `gh` wrapper, both run from this bundle, both getting the
 * agent's token from the session's service endpoint (`service-endpoint.ts`).
 * No token is in the CLI's environment or arguments, or on disk.
 *
 * On laptops and servers only `https://github.com` is touched, for this
 * session: the user's other credential helpers and Git config stay as they
 * are, and SSH remotes still use the user's keys. In the cloud every other
 * credential helper is cleared, as before.
 *
 * It imports only Node and zod, so the helpers run from source under plain
 * Node too, which is how the tests drive them with real `git` and `gh`.
 */

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;

/** A value fit to put in a header or a Git credential: printable ASCII, no spaces. */
export function validServiceToken(token: string): boolean {
  return token.length > 0 && token.length <= MAX_TOKEN_BYTES && /^[\x21-\x7e]+$/.test(token);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * A Git credential request, or null for one this helper does not read. Only
 * the multi-valued keys (`capability[]`, `wwwauth[]`, which newer Git sends
 * more than once) may repeat.
 */
export function parseCredentialRequest(input: string): Map<string, string[]> | null {
  if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) return null;
  const fields = new Map<string, string[]>();
  for (const line of input.split('\n')) {
    if (line === '') break;
    const at = line.indexOf('=');
    if (at <= 0 || line.includes('\r') || line.includes('\0')) return null;
    const key = line.slice(0, at);
    const values = fields.get(key);
    if (values && !key.endsWith('[]')) return null;
    fields.set(key, [...(values ?? []), line.slice(at + 1)]);
  }
  return fields;
}

/** Whether the request is for `https://github.com`, the one place the helper answers. */
export function forGitHub(fields: Map<string, string[]>): boolean {
  return fields.get('protocol')?.[0] === 'https' && fields.get('host')?.[0] === 'github.com';
}

/** The answer to a `get`: GitHub takes an installation token as `x-access-token`'s password. */
export function githubCredentialAnswer(token: string): string {
  return `username=x-access-token\npassword=${token}\n\n`;
}

const endpointAnswerSchema = z.union([
  z.object({ token: z.string(), expires_at: z.string() }),
  z.object({ error: z.string() }),
]);

/**
 * A token for `service` from the session's endpoint, telling it first of a
 * `rejected` token. With `repository` (`owner/name`), only if the agent's
 * grant reaches it. The endpoint is plain HTTP, so it is refused anywhere but
 * loopback.
 */
export async function sessionServiceToken(
  service: string,
  rejected: string | null,
  repository: string | null,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const endpoint = env.SWITCH_SERVICE_ENDPOINT;
  const bearer = env.SWITCH_SERVICE_BEARER;
  if (!endpoint || !bearer) throw new Error('This session has no Switch service endpoint.');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('The Switch service endpoint is not a URL.');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('The Switch service endpoint must be on 127.0.0.1.');
  let response: Response;
  try {
    response = await fetch(`${url.origin}/services/${service}/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rejected, repository }),
      redirect: 'error',
      signal: AbortSignal.timeout(100_000),
    });
  } catch (error) {
    throw new Error(
      `This session's Switch service endpoint could not be reached: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const answer = endpointAnswerSchema.safeParse(await response.json().catch(() => null));
  if (!answer.success)
    throw new Error(
      `The Switch service endpoint answered HTTP ${response.status} without a reason.`
    );
  if ('error' in answer.data) throw new Error(answer.data.error);
  if (!response.ok || !validServiceToken(answer.data.token))
    throw new Error('The Switch service endpoint answered with something that is not a token.');
  return answer.data.token;
}

/**
 * The token for GitHub: the session's, or in a cloud deployment with a
 * mounted personal token, that one (`GH_TOKEN`). Undefined when neither is
 * set up, so Git moves on to its next way of signing in.
 */
async function githubToken(
  env: NodeJS.ProcessEnv,
  repository: string | null
): Promise<string | undefined> {
  if (env.SWITCH_SERVICE_ENDPOINT) return sessionServiceToken('github', null, repository, env);
  return env.GH_TOKEN || undefined;
}

/**
 * Where a session on the owner's own machine falls back to when Switch gives
 * no token for a request: the machine's credential helpers for github.com, and
 * the wrapper's directory, which they must not find `gh` in. Absent in the
 * cloud, which has no machine sign-in to fall back to.
 */
const fallbackSchema = z.object({ helpers: z.array(z.string()), wrapper: z.string() });
type Fallback = z.infer<typeof fallbackSchema>;

function fallbackOf(env: NodeJS.ProcessEnv): Fallback | null {
  const raw = env.SWITCH_GITHUB_FALLBACK;
  if (!raw) return null;
  try {
    return fallbackSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** `owner/name` from a Git credential request's `path` (`owner/name.git/...`), or null. */
export function repositoryOfPath(path: string | undefined): string | null {
  const [owner, name] = (path ?? '').split('/');
  const repository = `${owner ?? ''}/${(name ?? '').replace(/\.git$/, '')}`;
  return REPOSITORY.test(repository) ? repository : null;
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Git's credential helper (`git credential-<helper> get|store|erase`).
 * `get` answers with the agent's token for a repository its grant reaches;
 * `erase` of that token is Git saying GitHub refused it, which the endpoint
 * is told so the next `get` has another. Nothing of Switch's is stored.
 *
 * On the owner's own machine, when Switch gives no token (it could not, the
 * grant does not reach the repository, or it was removed), the machine's own
 * helpers answer instead, as for an agent with no grant, and their `store`
 * and `erase` reach them too. They are asked without the request's path, as
 * Git asks them for any other session. Never silently: what happened is said
 * on stderr, which Git shows, and in the session.
 */
export async function runGitCredentialHelper(
  operation: string | undefined,
  io: { stdin: AsyncIterable<unknown>; stdout: NodeJS.WritableStream; env: NodeJS.ProcessEnv }
): Promise<void> {
  if (!operation || !['get', 'store', 'erase'].includes(operation))
    throw new Error('Unsupported Git credential operation.');
  let input = '';
  for await (const chunk of io.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > MAX_REQUEST_BYTES)
      throw new Error('Git credential request is too large.');
  }
  const fields = parseCredentialRequest(input);
  if (!fields || !forGitHub(fields)) return;
  const fallback = fallbackOf(io.env);
  const repository = repositoryOfPath(fields.get('path')?.[0]);
  if (operation === 'get') {
    try {
      const token = await githubToken(io.env, repository);
      if (token && validServiceToken(token)) {
        io.stdout.write(githubCredentialAnswer(token));
        return;
      }
    } catch (error) {
      process.stderr.write(`switch: ${errorText(error)}${fallback ? ` ${FALLING_BACK}` : ''}\n`);
    }
    if (fallback) io.stdout.write(await askMachineHelpers(fallback, 'get', input, io.env));
    return;
  }
  if (fields.get('username')?.[0] !== 'x-access-token') {
    if (fallback) await askMachineHelpers(fallback, operation, input, io.env);
    return;
  }
  const rejected = fields.get('password')?.[0];
  if (operation === 'erase' && rejected && io.env.SWITCH_SERVICE_ENDPOINT)
    try {
      await sessionServiceToken('github', rejected, repository, io.env);
    } catch (error) {
      process.stderr.write(`switch: ${errorText(error)}\n`);
    }
}

/**
 * Ask the machine's own helpers, in order, as Git would have: for `get`, the
 * first answer with a password; `store` and `erase` reach them all. The
 * request goes without its `path`, and with the wrapper's directory off PATH,
 * so a `!gh auth git-credential` helper reaches the real `gh`'s own login.
 */
async function askMachineHelpers(
  fallback: Fallback,
  operation: string,
  input: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const request = input
    .split('\n')
    .filter((line) => !line.startsWith('path='))
    .join('\n');
  const {
    SWITCH_SERVICE_ENDPOINT: _endpoint,
    SWITCH_SERVICE_BEARER: _bearer,
    SWITCH_GITHUB_FALLBACK: _fallback,
    ...rest
  } = env;
  const helperEnv = {
    ...rest,
    PATH: (env.PATH ?? '')
      .split(delimiter)
      .filter((entry) => entry !== fallback.wrapper)
      .join(delimiter),
  };
  for (const helper of fallback.helpers) {
    const output = await runMachineHelper(helper, operation, request, helperEnv);
    if (operation === 'get' && /^password=/m.test(output)) return output;
  }
  return '';
}

/** One helper as Git runs it: `!command`, an absolute path, or `git credential-<name>`. */
function runMachineHelper(
  helper: string,
  operation: string,
  request: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const command = helper.startsWith('!')
    ? helper.slice(1)
    : isAbsolute(helper)
      ? helper
      : `git credential-${helper}`;
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', `${command} ${operation}`], {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.once('error', () => resolve(''));
    child.once('close', () => resolve(output));
    child.stdin.on('error', () => {});
    child.stdin.end(request);
  });
}

/** What `gh` prints when GitHub refuses its token. */
const GH_UNAUTHORIZED = /HTTP 401|Bad credentials/;

/** What the helper adds when it answers nothing, and Git moves on to the machine's own helpers. */
const FALLING_BACK = "Git uses this machine's own GitHub sign-in instead, if it has one.";
const FALLING_BACK_GH = "gh uses this machine's own GitHub sign-in instead, if it has one.";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Find the real `gh` on PATH, passing over `own`, the wrapper's directory.
 */
export async function findGitHubCli(path: string, own: string): Promise<string | null> {
  const ownReal = await realpath(own).catch(() => own);
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    if ((await realpath(directory).catch(() => directory)) === ownReal) continue;
    const candidate = join(directory, 'gh');
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/**
 * The `gh` wrapper: the real `gh` with the agent's token as `GH_TOKEN`. Its
 * stderr passes through, watched for GitHub refusing the token, which the
 * endpoint is told so the next command has another.
 */
export async function runGitHubCli(
  own: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<number> {
  const gh = await findGitHubCli(env.PATH ?? '', own);
  if (!gh) {
    process.stderr.write('switch: gh is not installed on this machine.\n');
    return 127;
  }
  // On the owner's own machine, the repository the command is for, so that
  // one the grant does not reach goes to `gh`'s own login instead.
  const repository = fallbackOf(env) ? await ghRepository(args, env) : null;
  let token: string | undefined;
  try {
    token = await githubToken(env, repository);
    if (!token) throw new Error('This session has no GitHub token.');
  } catch (error) {
    // `gh` then signs in as the machine's own login, if it has one; the
    // session itself is told too.
    process.stderr.write(`switch: ${errorText(error)} ${FALLING_BACK_GH}\n`);
    token = undefined;
  }
  // The wrapper ran as Node by saying so; what `gh` starts should not.
  const { ELECTRON_RUN_AS_NODE: _asNode, ...ghEnv } = env;
  const child = spawn(gh, args, {
    stdio: ['inherit', 'inherit', 'pipe'],
    env: token ? { ...ghEnv, GH_TOKEN: token } : ghEnv,
  });
  let tail = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    tail = (tail + chunk.toString()).slice(-8192);
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', () => reject(new Error('GitHub CLI could not start.')));
    child.once('close', (exit) => resolve(exit ?? 1));
  });
  if (code !== 0 && token && GH_UNAUTHORIZED.test(tail) && env.SWITCH_SERVICE_ENDPOINT) {
    try {
      await sessionServiceToken('github', token, repository, env);
      process.stderr.write(
        "switch: GitHub refused this agent's token; the next git or gh command has a new one.\n"
      );
    } catch (error) {
      process.stderr.write(`switch: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return code;
}

/**
 * The github.com repository a `gh` command is for, as `gh` itself picks it:
 * `-R`/`--repo`, then `GH_REPO`, then the `origin` remote of the current
 * folder. Null when none names one (`gh api`, `gh repo list`), and the
 * command then has the token.
 */
export async function ghRepository(args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const [index, arg] of args.entries()) {
    if (arg === '-R' || arg === '--repo') return repositoryOfName(args[index + 1]);
    if (arg.startsWith('--repo=')) return repositoryOfName(arg.slice('--repo='.length));
  }
  if (env.GH_REPO) return repositoryOfName(env.GH_REPO);
  const origin = await new Promise<string>((resolve) => {
    const child = spawn('git', ['remote', 'get-url', 'origin'], {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.once('error', () => resolve(''));
    child.once('close', (code) => resolve(code === 0 ? output.trim() : ''));
  });
  const remote =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(.+)$/.exec(origin);
  return remote ? repositoryOfName(remote[1]) : null;
}

/** `owner/name` from `owner/name`, `github.com/owner/name` or a github.com URL. */
function repositoryOfName(name: string | undefined): string | null {
  const parts = (name ?? '')
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/^github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .split('/');
  const repository = parts.length === 2 ? parts.join('/') : '';
  return REPOSITORY.test(repository) ? repository : null;
}

/**
 * Whether `repository` is one the agent's token reaches: GitHub answers 404
 * for a repository outside the token's grant. Null when GitHub could not say,
 * and the token is then handed out as it was.
 */
export async function githubRepositoryVisible(
  token: string,
  repository: string
): Promise<boolean | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return true;
    // A 403 can be a rate limit rather than the grant; only 404 says it.
    if (response.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * The command that runs this bundle as Node. Console runs its hosts on
 * Electron's binary and strips `ELECTRON_*` from what a session's CLI gets, so
 * the helpers say it themselves; Node ignores it.
 */
function bundleCommand(execPath: string, entrypoint: string): string {
  return `ELECTRON_RUN_AS_NODE=1 ${shellQuote(execPath)} ${shellQuote(entrypoint)}`;
}

/** Write the session's `gh` wrapper into `directory`, replacing one an earlier start wrote. */
export async function writeGitHubWrapper(input: {
  directory: string;
  execPath: string;
  entrypoint: string;
}): Promise<void> {
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const path = join(input.directory, 'gh');
  const staging = `${path}.${process.pid}.tmp`;
  const source = `#!/bin/sh\nexec env ${bundleCommand(input.execPath, input.entrypoint)} --github-cli ${shellQuote(input.directory)} "$@"\n`;
  try {
    const file = await open(staging, 'w', 0o700);
    try {
      await file.writeFile(source);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}

/**
 * The credential helpers Git would ask for `https://github.com` in `cwd`, in
 * the order the machine's config gives them: `credential.helper` and each
 * `credential.<url>.helper` whose URL is github.com over https, an empty value
 * clearing those met before it, as Git reads them. Empty without git or any.
 */
export async function machineGitHubHelpers(
  env: Readonly<Record<string, string>>,
  cwd: string
): Promise<string[]> {
  const output = await new Promise<string>((resolve) => {
    const child = spawn('git', ['config', '--null', '--get-regexp', '^credential\\..*helper$'], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString()));
    child.once('error', () => resolve(''));
    child.once('close', () => resolve(text));
  });
  const helpers: string[] = [];
  for (const entry of output.split('\0')) {
    const newline = entry.indexOf('\n');
    if (newline < 0 || !helperForGitHub(entry.slice(0, newline))) continue;
    const value = entry.slice(newline + 1);
    if (value === '') helpers.length = 0;
    else helpers.push(value);
  }
  return helpers;
}

function helperForGitHub(key: string): boolean {
  if (key.toLowerCase() === 'credential.helper') return true;
  const url = key.slice('credential.'.length, -'.helper'.length);
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parsed.pathname === '/'
    );
  } catch {
    return false;
  }
}

/**
 * What a session's environment gains for GitHub: the credential helper for
 * `https://github.com`, the wrapper's directory first on PATH, and, in the
 * cloud (`isolate`), every other credential helper and prompt turned off.
 *
 * The settings go in `GIT_CONFIG_PARAMETERS`, as `git -c` passes them, after
 * any the environment already has, in the `'key=value'` form every Git since
 * 1.7.2 reads. Not `GIT_CONFIG_KEY_*`: an agent CLI that strips variables
 * named like secrets (Codex's environment policy, `*KEY*`) would leave Git a
 * count with no keys, and every git command failing.
 *
 * Elsewhere Git tells Switch's helper the repository (`useHttpPath`), and the
 * helper asks `machineHelpers`, the helpers the machine already had for
 * github.com, itself when Switch gives no token for it: the grant does not
 * reach the repository, or Switch could not, or would not, give one. They are
 * named in `SWITCH_GITHUB_FALLBACK` rather than after Switch's in Git's
 * config, where they would be asked with the path, which a keychain does not
 * store its sign-in under.
 */
export function githubSessionEnvironment(input: {
  env: Readonly<Record<string, string>>;
  execPath: string;
  entrypoint: string;
  wrapperDirectory: string;
  isolate: boolean;
  machineHelpers: readonly string[];
}): Record<string, string> {
  const helper = `!${bundleCommand(input.execPath, input.entrypoint)} --git-credential`;
  const entries: [string, string][] = input.isolate
    ? [
        ['credential.helper', ''],
        ['credential.https://github.com.helper', helper],
        ['core.askPass', ''],
      ]
    : [
        // Empty first: it clears the helpers met so far for github.com, which
        // Switch's then asks itself when it gives no token.
        ['credential.https://github.com.helper', ''],
        ['credential.https://github.com.helper', helper],
        ['credential.https://github.com.useHttpPath', 'true'],
      ];
  const parameters = entries.map(([key, value]) => shellQuote(`${key}=${value}`)).join(' ');
  const existing = input.env.GIT_CONFIG_PARAMETERS;
  return {
    GIT_CONFIG_PARAMETERS: existing ? `${existing} ${parameters}` : parameters,
    ...(input.isolate
      ? { GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }
      : {
          SWITCH_GITHUB_FALLBACK: JSON.stringify({
            helpers: input.machineHelpers,
            wrapper: input.wrapperDirectory,
          }),
        }),
    PATH: input.env.PATH
      ? `${input.wrapperDirectory}${delimiter}${input.env.PATH}`
      : input.wrapperDirectory,
  };
}
