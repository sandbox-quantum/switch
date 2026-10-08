import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
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
 * `rejected` token. The endpoint is plain HTTP, so it is refused anywhere but
 * loopback.
 */
export async function sessionServiceToken(
  service: string,
  rejected: string | null,
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
      body: JSON.stringify({ rejected }),
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
async function githubToken(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (env.SWITCH_SERVICE_ENDPOINT) return sessionServiceToken('github', null, env);
  return env.GH_TOKEN || undefined;
}

/**
 * Git's credential helper (`git credential-<helper> get|store|erase`).
 * `get` answers with the agent's token; `erase` is Git saying GitHub refused
 * it, which the endpoint is told so the next `get` has another. Nothing is
 * stored. What goes wrong is said on stderr, which Git shows.
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
  if (operation === 'get') {
    const token = await githubToken(io.env);
    if (token && validServiceToken(token)) io.stdout.write(githubCredentialAnswer(token));
    return;
  }
  const rejected = fields.get('password')?.[0];
  if (operation === 'erase' && rejected && io.env.SWITCH_SERVICE_ENDPOINT)
    await sessionServiceToken('github', rejected, io.env);
}

/** What `gh` prints when GitHub refuses its token. */
const GH_UNAUTHORIZED = /HTTP 401|Bad credentials/;

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
  let token: string | undefined;
  try {
    token = await githubToken(env);
  } catch (error) {
    process.stderr.write(`switch: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (!token) {
    process.stderr.write('switch: this session has no GitHub token.\n');
    return 1;
  }
  // The wrapper ran as Node by saying so; what `gh` starts should not.
  const { ELECTRON_RUN_AS_NODE: _asNode, ...ghEnv } = env;
  const child = spawn(gh, args, {
    stdio: ['inherit', 'inherit', 'pipe'],
    env: { ...ghEnv, GH_TOKEN: token },
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
  if (code !== 0 && GH_UNAUTHORIZED.test(tail) && env.SWITCH_SERVICE_ENDPOINT) {
    try {
      await sessionServiceToken('github', token, env);
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
 * What a session's environment gains for GitHub: the credential helper for
 * `https://github.com`, the wrapper's directory first on PATH, and, in the
 * cloud (`isolate`), every other credential helper and prompt turned off.
 * Entries go after any `GIT_CONFIG_*` the environment already has.
 */
export function githubSessionEnvironment(input: {
  env: Readonly<Record<string, string>>;
  execPath: string;
  entrypoint: string;
  wrapperDirectory: string;
  isolate: boolean;
}): Record<string, string> {
  const helper = `!${bundleCommand(input.execPath, input.entrypoint)} --git-credential`;
  const entries: [string, string][] = input.isolate
    ? [
        ['credential.helper', ''],
        ['credential.https://github.com.helper', helper],
        ['core.askPass', ''],
      ]
    : [
        // Empty first: it clears the helpers met so far for github.com only.
        ['credential.https://github.com.helper', ''],
        ['credential.https://github.com.helper', helper],
      ];
  const start = Number.parseInt(input.env.GIT_CONFIG_COUNT ?? '0', 10);
  const first = Number.isInteger(start) && start > 0 ? start : 0;
  const config: Record<string, string> = { GIT_CONFIG_COUNT: String(first + entries.length) };
  entries.forEach(([key, value], index) => {
    config[`GIT_CONFIG_KEY_${first + index}`] = key;
    config[`GIT_CONFIG_VALUE_${first + index}`] = value;
  });
  return {
    ...config,
    ...(input.isolate
      ? { GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }
      : {}),
    PATH: input.env.PATH
      ? `${input.wrapperDirectory}${delimiter}${input.env.PATH}`
      : input.wrapperDirectory,
  };
}
