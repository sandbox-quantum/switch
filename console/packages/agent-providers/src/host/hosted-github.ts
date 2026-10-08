import { execFile, spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
    GIT_CONFIG_COUNT: '4',
    // Clear inherited credential stores before selecting this non-persistent helper.
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: `!${shellQuote(process.execPath)} ${shellQuote(entrypoint)} --git-credential`,
    GIT_CONFIG_KEY_2: 'core.askPass',
    GIT_CONFIG_VALUE_2: '',
    // The helper picks the installation by the repository owner, so git must send the path.
    GIT_CONFIG_KEY_3: 'credential.https://github.com.useHttpPath',
    GIT_CONFIG_VALUE_3: 'true',
  };
}

/**
 * Set on an agent unit's watcher whose agent was granted GitHub
 * (`hostedUnitGitHubEnvironment`), and inherited by the session hosts it
 * starts: where the unit's Switch credentials are, and the directory holding
 * the `gh` wrapper.
 */
export const HOSTED_GITHUB_CREDENTIALS_ENV = 'SWITCH_HOSTED_GITHUB_REFRESH_CREDENTIALS';
export const HOSTED_GITHUB_CLI_ENV = 'SWITCH_HOSTED_GITHUB_CLI';

/**
 * What a session's provider is given on top of its own environment so `git`
 * and `gh` get GitHub installation tokens through the unit's credentials:
 * empty on a host that sets none of the variables above. It replaces
 * whatever a session saved under an earlier host left in its environment.
 */
export function hostedGitHubEnvironment(
  host: NodeJS.ProcessEnv,
  path: string | undefined
): Record<string, string> {
  const credentials = host[HOSTED_GITHUB_CREDENTIALS_ENV];
  const cli = host[HOSTED_GITHUB_CLI_ENV];
  if (!credentials && !cli) return {};
  if (!credentials || !cli)
    throw new Error(
      `${HOSTED_GITHUB_CREDENTIALS_ENV} and ${HOSTED_GITHUB_CLI_ENV} are set together.`
    );
  const rest = (path ?? '').split(':').filter((entry) => entry !== '' && entry !== cli);
  return {
    ...githubLaunchEnvironment(),
    [HOSTED_GITHUB_CREDENTIALS_ENV]: credentials,
    PATH: [cli, ...rest].join(':'),
  };
}

const HOSTED_GIT_HELPER = /hosted-bootstrap\.mjs'? --git-credential$/;
const GITHUB_LAUNCH_KEY =
  /^(GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)|GH_HOST|GH_PROMPT_DISABLED|GIT_TERMINAL_PROMPT)$/;

async function isGitHubCliWrapper(directory: string): Promise<boolean> {
  try {
    const source = await readFile(join(directory, 'gh'), 'utf8');
    return (
      source.startsWith('#!/bin/sh\nexec ') && source.includes("hosted-bootstrap.mjs' --github-cli")
    );
  } catch {
    return false;
  }
}

/**
 * `env` without the GitHub setup an earlier hosted host saved into it (its
 * Git helper configuration, its Switch variables and its `gh` wrapper on
 * PATH), so a session gets only what `hostedGitHubEnvironment` gives it now.
 * An environment that carries none of it is returned as it is.
 */
export async function withoutHostedGitHubEnvironment(
  env: Record<string, string>
): Promise<Record<string, string>> {
  const keys = Object.keys(env);
  const hosted =
    keys.some((key) => key.startsWith('SWITCH_HOSTED_GITHUB_')) ||
    keys.some((key) => /^GIT_CONFIG_VALUE_\d+$/.test(key) && HOSTED_GIT_HELPER.test(env[key]!));
  if (!hosted) return env;
  const next = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !key.startsWith('SWITCH_HOSTED_GITHUB_') && !GITHUB_LAUNCH_KEY.test(key)
    )
  );
  if (next.PATH !== undefined) {
    const entries = next.PATH.split(':');
    const wrappers = await Promise.all(entries.map((entry) => isGitHubCliWrapper(entry)));
    next.PATH = entries.filter((_entry, index) => !wrappers[index]).join(':');
  }
  return next;
}

/**
 * The fields of a Git credential request this helper answers: only `get`,
 * only HTTPS github.com, well formed. Null for anything else.
 */
function credentialRequest(operation: string, input: string): Map<string, string> | null {
  if (operation !== 'get' || Buffer.byteLength(input) > 64 * 1024) return null;
  const fields = new Map<string, string>();
  for (const line of input.split('\n')) {
    if (line === '') break;
    const at = line.indexOf('=');
    if (at <= 0 || line.includes('\r') || line.includes('\0')) return null;
    const key = line.slice(0, at);
    if (fields.has(key)) return null;
    fields.set(key, line.slice(at + 1));
  }
  if (fields.get('protocol') !== 'https' || fields.get('host') !== 'github.com') return null;
  return fields;
}

/** Git credential protocol: no cache/store, no browser, only HTTPS github.com. */
export function gitHubCredentialResponse(operation: string, input: string, token?: string): string {
  if (!token || !validToken(token) || credentialRequest(operation, input) === null) return '';
  return `username=x-access-token\npassword=${token}\n\n`;
}

/** One GitHub App installation granted to the agent, as `GET /hosted/connections` answers it. */
export type GitHubInstallation = {
  installation_id: number;
  account: string;
  repositories: 'all' | string[];
};

/**
 * A granted installation whose grant no longer holds, with Switch's reason;
 * `account` is null when the owner no longer sees the installation.
 */
export type UnavailableGitHubInstallation = {
  installation_id: number;
  account: string | null;
  error: string;
};

export type GrantedGitHubInstallation = GitHubInstallation | UnavailableGitHubInstallation;

const githubInstallationSchema = z.union([
  z.object({
    installation_id: z.number().int().positive(),
    account: z.string().min(1),
    repositories: z.union([z.literal('all'), z.array(z.string().min(1))]),
  }),
  z.object({
    installation_id: z.number().int().positive(),
    account: z.string().min(1).nullable(),
    error: z.string().min(1),
  }),
]);

const hostedConnectionsSchema = z.object({
  connections: z.array(z.object({ slug: z.string(), installations: z.unknown() })),
});

const ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function account(value: string | undefined): string | null {
  return value !== undefined && ACCOUNT.test(value) ? value : null;
}

/** The owner in a credential request's `path` (`owner/repo` or `owner/repo.git`). */
export function ownerFromCredentialPath(path: string | undefined): string | null {
  if (path === undefined) return null;
  return account(path.replace(/^\//, '').split('/')[0]);
}

/**
 * The owner `gh` would act on for a `-R`/`GH_REPO` value: `OWNER/REPO`,
 * `github.com/OWNER/REPO`, or a github.com URL. Null for another host or a
 * value that is not one.
 */
export function ownerFromRepoArgument(value: string | undefined): string | null {
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return ownerFromRemoteUrl(value);
  const parts = value.split('/');
  if (parts.length === 2) return account(parts[0]);
  if (parts.length === 3 && parts[0]!.toLowerCase() === 'github.com') return account(parts[1]);
  return null;
}

/** The owner of a github.com remote URL (HTTPS, `ssh://` or scp-like `git@github.com:`). */
export function ownerFromRemoteUrl(url: string | undefined): string | null {
  if (!url) return null;
  const scp = /^[^@/:]+@github\.com:\/?([^/]+)\/[^/]+$/i.exec(url);
  if (scp) return account(scp[1]);
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return null;
    if (parsed.hostname.toLowerCase() !== 'github.com') return null;
    const parts = parsed.pathname.split('/').filter((part) => part !== '');
    return parts.length >= 2 ? account(parts[0]) : null;
  } catch {
    return null;
  }
}

/** The `-R`/`--repo` value in a `gh` command line, before any `--`. */
export function repoArgument(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') return undefined;
    if (arg === '-R' || arg === '--repo') return args[index + 1];
    if (arg.startsWith('--repo=')) return arg.slice('--repo='.length);
    if (arg.startsWith('-R') && arg.length > 2) return arg.slice(2);
  }
  return undefined;
}

/**
 * The `OWNER/REPO` a `gh repo <command>` names positionally (`gh repo clone
 * OWNER/REPO`), which those commands take instead of `-R`.
 */
export function repoCommandArgument(args: string[]): string | undefined {
  if (args[0] !== 'repo' || args[1] === undefined || args[1].startsWith('-')) return undefined;
  for (const arg of args.slice(2)) {
    if (arg === '--') return undefined;
    if (!arg.startsWith('-') && ownerFromRepoArgument(arg) !== null) return arg;
  }
  return undefined;
}

function label(installation: GrantedGitHubInstallation): string {
  return installation.account ?? `installation ${installation.installation_id}`;
}

function grantedAccounts(installations: GrantedGitHubInstallation[]): string {
  return installations.length === 0
    ? 'none'
    : installations
        .map((installation) =>
          'error' in installation
            ? `${label(installation)} (unavailable: ${installation.error})`
            : installation.account
        )
        .join(', ');
}

/** The granted installation for `owner`, matched as GitHub does, without regard to case. */
export function installationForOwner(
  installations: GrantedGitHubInstallation[],
  owner: string
): GrantedGitHubInstallation | null {
  const wanted = owner.toLowerCase();
  return (
    installations.find((installation) => installation.account?.toLowerCase() === wanted) ?? null
  );
}

/** `installation`, or the error Switch gave for a grant that no longer holds. */
export function usableInstallation(installation: GrantedGitHubInstallation): GitHubInstallation {
  if ('error' in installation)
    throw new Error(
      `GitHub access to ${label(installation)} granted to this agent is unavailable: ${installation.error}`
    );
  return installation;
}

function notGranted(installations: GrantedGitHubInstallation[], owner: string): Error {
  return new Error(
    `GitHub account '${owner}' is not granted to this agent. Granted accounts: ${grantedAccounts(installations)}.`
  );
}

/**
 * The installation a `gh` command runs as: the owner of `-R/--repo` (or of
 * the `OWNER/REPO` a `gh repo` command names), else of `GH_REPO`, else of the current directory's github.com `origin`; with none
 * of those, the only granted installation. Anything else is an error that
 * names the granted accounts.
 */
export async function selectCliInstallation(input: {
  installations: GrantedGitHubInstallation[];
  args: string[];
  ghRepo: string | undefined;
  originUrl: () => Promise<string | null>;
}): Promise<GitHubInstallation> {
  const { installations } = input;
  if (installations.length === 0) throw new Error('No GitHub account is granted to this agent.');
  const owner =
    ownerFromRepoArgument(repoArgument(input.args)) ??
    ownerFromRepoArgument(repoCommandArgument(input.args)) ??
    ownerFromRepoArgument(input.ghRepo) ??
    ownerFromRemoteUrl((await input.originUrl()) ?? undefined);
  if (owner !== null) {
    const installation = installationForOwner(installations, owner);
    if (installation === null) throw notGranted(installations, owner);
    return usableInstallation(installation);
  }
  if (installations.length === 1) return usableInstallation(installations[0]!);
  throw new Error(
    `Several GitHub accounts are granted to this agent (${grantedAccounts(installations)}); pass -R owner/repo to choose one (or set GH_REPO=owner/repo for a command without -R, such as gh api).`
  );
}

type SwitchEndpoint = { base: string; token: string };

async function switchEndpoint(credentialsPath: string): Promise<SwitchEndpoint> {
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
  return { base: endpoint.href.replace(/\/$/, ''), token: env.SWITCH_API_TOKEN };
}

/**
 * A call Switch refused: its status, and the `code` and `detail` Switch
 * gave, which name the reason (an installation not granted, a GitHub
 * connection the owner must reconnect) and never carry a credential.
 */
class SwitchRefusal extends Error {}

const MAX_REFUSAL_DETAIL = 400;

function refusalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  if (text === '') return null;
  return text.length > MAX_REFUSAL_DETAIL ? `${text.slice(0, MAX_REFUSAL_DETAIL)}…` : text;
}

async function refusal(response: Response): Promise<SwitchRefusal> {
  let body: unknown = null;
  try {
    body = JSON.parse(await response.text());
  } catch {
    // Not Switch's JSON error (a proxy page, say): only the status is reported.
  }
  const fields = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const code = refusalText(fields.code);
  const detail = refusalText(fields.detail);
  let message = `Switch answered ${response.status}${code ? ` (${code})` : ''}`;
  if (detail) message += `: ${detail}`;
  if (code === 'github_reconnect_required')
    message += " The agent's owner must reconnect GitHub in Switch.";
  return new SwitchRefusal(message);
}

function failure(summary: string, error: unknown): Error {
  return new Error(
    error instanceof SwitchRefusal
      ? `${summary}: ${error.message}`
      : `${summary}. Check the owner’s GitHub connection.`
  );
}

/** Calls Switch once, and once more after a pause for a retryable 409 or 503. */
async function callSwitch(
  endpoint: SwitchEndpoint,
  path: string,
  init: { method: 'GET' } | { method: 'POST'; body: unknown }
): Promise<unknown> {
  const request = () =>
    fetch(endpoint.base + path, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        ...(init.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.method === 'POST' ? { body: JSON.stringify(init.body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(180_000),
    });
  let response = await request();
  if (response.status === 409 || response.status === 503) {
    await response.body?.cancel();
    await delay(1_000);
    response = await request();
  }
  if (!response.ok) throw await refusal(response);
  return response.json();
}

/** The GitHub installations granted to the agent whose Switch credentials are at `credentialsPath`. */
export async function listGitHubInstallations(
  credentialsPath: string
): Promise<GrantedGitHubInstallation[]> {
  try {
    const listing = hostedConnectionsSchema.parse(
      await callSwitch(await switchEndpoint(credentialsPath), '/hosted/connections', {
        method: 'GET',
      })
    );
    const github = listing.connections.find((connection) => connection.slug === 'github');
    return github === undefined
      ? []
      : z.array(githubInstallationSchema).parse(github.installations);
  } catch (error) {
    throw failure('Could not read the GitHub access granted to this agent', error);
  }
}

/** A fresh installation token for one granted installation; never written anywhere. */
export async function renewGitHubCredential(
  credentialsPath: string,
  installationId: number
): Promise<string> {
  try {
    const credential = z
      .object({ token: z.string(), installation_id: z.number(), expires_at: z.string() })
      .parse(
        await callSwitch(
          await switchEndpoint(credentialsPath),
          '/hosted/connections/github/credential',
          { method: 'POST', body: { installation_id: installationId } }
        )
      );
    if (
      !validToken(credential.token) ||
      credential.installation_id !== installationId ||
      !Number.isFinite(Date.parse(credential.expires_at)) ||
      Date.parse(credential.expires_at) < Date.now() + 60_000
    )
      throw new Error();
    return credential.token;
  } catch (error) {
    throw failure('Could not renew GitHub access', error);
  }
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
  const request = credentialRequest(operation, input);
  if (request === null) return;
  const credentialsPath = process.env[HOSTED_GITHUB_CREDENTIALS_ENV];
  if (!credentialsPath) {
    process.stdout.write(gitHubCredentialResponse(operation, input, process.env.GH_TOKEN));
    return;
  }
  const owner = ownerFromCredentialPath(request.get('path'));
  if (owner === null) {
    console.error(
      'Switch: git named no github.com repository path, so no GitHub account could be chosen (credential.useHttpPath must be true).'
    );
    return;
  }
  const installations = await listGitHubInstallations(credentialsPath);
  const installation = installationForOwner(installations, owner);
  if (installation === null) {
    console.error(`Switch: ${notGranted(installations, owner).message}`);
    return;
  }
  const token = await renewGitHubCredential(
    credentialsPath,
    usableInstallation(installation).installation_id
  );
  process.stdout.write(gitHubCredentialResponse(operation, input, token));
}

/** Prints the GitHub accounts and repositories granted to this agent, one account per line. */
export async function runGitHubList(): Promise<void> {
  const credentialsPath = process.env[HOSTED_GITHUB_CREDENTIALS_ENV];
  if (!credentialsPath) throw new Error('This session has no Switch GitHub access.');
  const installations = await listGitHubInstallations(credentialsPath);
  if (installations.length === 0) {
    console.log('No GitHub account is granted to this agent.');
    return;
  }
  for (const installation of installations)
    console.log(
      `${label(installation)}: ${
        'error' in installation
          ? `unavailable: ${installation.error}`
          : installation.repositories === 'all'
            ? 'all repositories'
            : installation.repositories.join(', ')
      }`
    );
}

/** Writes `name` in `directory` as a script that runs the bootstrap with `mode`, or checks the one there. */
async function writeWrapper(directory: string, name: string, mode: string): Promise<void> {
  const path = join(directory, name);
  const entrypoint = fileURLToPath(new URL('./hosted-bootstrap.mjs', import.meta.url));
  const source = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(entrypoint)} ${mode} "$@"\n`;
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
      throw new Error(`Hosted GitHub wrapper ${name} differs from the deployment.`);
  }
}

/**
 * The directory of the `gh` wrapper and of `switch-github-grants` (which
 * prints the granted GitHub accounts, `--list`), put on a session's PATH only
 * while GitHub is granted.
 */
export async function prepareGitHubCli(root: string): Promise<string> {
  const directory = join(root, 'bin');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeWrapper(directory, 'gh', '--github-cli');
  await writeWrapper(directory, 'switch-github-grants', '--list');
  return directory;
}

async function originUrl(): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)('git', ['remote', 'get-url', 'origin'], {
      timeout: 10_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function cliToken(args: string[]): Promise<string> {
  const credentialsPath = process.env[HOSTED_GITHUB_CREDENTIALS_ENV];
  if (!credentialsPath) {
    if (!process.env.GH_TOKEN) throw new Error('GitHub credential is missing.');
    return process.env.GH_TOKEN;
  }
  const installation = await selectCliInstallation({
    installations: await listGitHubInstallations(credentialsPath),
    args,
    ghRepo: process.env.GH_REPO,
    originUrl,
  });
  return renewGitHubCredential(credentialsPath, installation.installation_id);
}

export async function runGitHubCli(args: string[]): Promise<void> {
  const token = await cliToken(args);
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
