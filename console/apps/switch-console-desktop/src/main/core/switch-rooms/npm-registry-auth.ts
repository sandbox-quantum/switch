import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { GH_EXECUTABLE, getGithubTokenFromGhCli } from '@main/core/updates/github-token';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { quoteShellArg } from '@main/utils/shellEscape';
import {
  GH_AUTH_STATUS_ARGS,
  type GhAuthState,
  isEnvShadowedToken,
  NPMRC_CONTENTS,
  npmRegistryEnv,
  parseGhAuthStatus,
  READ_PACKAGES_FIX,
  READ_PACKAGES_SCOPE,
} from '@shared/core/npm-registry';
import { switchToolsUnavailableEvent } from '@shared/events/switchSetupEvents';

const execFileAsync = promisify(execFile);

/**
 * Registry access for sessions Switch Console starts, local and remote.
 *
 * Both functions here return an empty environment when `gh` has no usable
 * token. The caller should start the session anyway: one with no MCP server is
 * worse than one whose agent cannot reach Switch, and the warnings below name
 * the cause, which a bare npm 404 would not.
 *
 * See `@shared/core/npm-registry` for what the two settings are and why.
 */

const MISSING_SCOPE_DETAIL =
  'gh auth login does not request read:packages, so the registry will refuse ' +
  'with 403 and the session will start without its MCP tools';

/**
 * Report what `gh` will do with its current credentials.
 *
 * A shadowed token is called out separately because the remedy differs: the
 * user has usually just authenticated, and being told to authenticate again
 * would send them round the loop that produced the state.
 */
function warnAboutGhAuth(state: GhAuthState, host: string): void {
  if (isEnvShadowedToken(state)) {
    log.warn('npmRegistryAuth: an environment token is shadowing the gh login', {
      event: 'npm_registry_auth_env_shadowed',
      host,
      tokenSource: state.status === 'unknown' ? 'unknown' : state.tokenSource,
      detail:
        'gh prefers GH_TOKEN/GITHUB_TOKEN over the keyring, so re-running gh auth ' +
        'login will not change which token is used until that variable is unset',
    });
  }
  if (state.status === 'missing-scope') {
    log.warn('npmRegistryAuth: the GitHub token cannot read packages', {
      event: 'npm_registry_auth_missing_scope',
      host,
      account: state.login,
      scopes: state.scopes.join(', '),
      fix: READ_PACKAGES_FIX,
      detail: MISSING_SCOPE_DETAIL,
    });
  } else if (state.status === 'invalid') {
    log.warn('npmRegistryAuth: the active GitHub token is not usable', {
      event: 'npm_registry_auth_invalid_token',
      host,
      tokenSource: state.tokenSource,
      detail: state.detail,
    });
  }
}

/**
 * Tell the user, not just the log, when the session will come up without tools.
 *
 * Only for sessions on this machine: a remote host's state belongs on that
 * host's setup page, where it is already reported, and a toast cannot say which
 * host it meant.
 */
function announceUnusableAuth(state: GhAuthState): void {
  if (state.status === 'missing-scope') {
    events.emit(switchToolsUnavailableEvent, {
      reason: 'missing-scope',
      detail: `The GitHub token is missing the ${READ_PACKAGES_SCOPE} scope.`,
    });
  } else if (state.status === 'invalid') {
    events.emit(switchToolsUnavailableEvent, {
      reason: isEnvShadowedToken(state) ? 'env-shadowed' : 'invalid-token',
      detail: isEnvShadowedToken(state)
        ? `A ${state.tokenSource} environment variable is overriding your gh login, and it is not usable.`
        : state.detail,
    });
  }
}

function localNpmrcPath(): string {
  return join(app.getPath('userData'), 'npm', 'npmrc');
}

/**
 * Registry access for a session on this machine.
 *
 * The npmrc is ours, not the user's: `~/.npmrc` is their configuration and
 * editing it to make our plugin work is a reach, while a file in their project
 * shows up in git status. `npm_config_userconfig` makes npm read ours instead,
 * confining the footprint to Switch Console's own directory.
 */
export async function npmRegistryAuthEnv(): Promise<Record<string, string>> {
  const token = await getGithubTokenFromGhCli();
  if (!token) {
    log.warn('npmRegistryAuth: no GitHub token from `gh` — the agent runtime will not resolve', {
      event: 'npm_registry_auth_missing_token',
      hint: 'run `gh auth login`; a private package reads as 404 without it',
    });
    events.emit(switchToolsUnavailableEvent, {
      reason: 'not-authenticated',
      detail: 'This machine is not authenticated to GitHub.',
    });
    return {};
  }

  try {
    const { stdout } = await execFileAsync(GH_EXECUTABLE, GH_AUTH_STATUS_ARGS, {
      timeout: 10_000,
    });
    const state = parseGhAuthStatus(stdout);
    warnAboutGhAuth(state, 'this machine');
    announceUnusableAuth(state);
  } catch {
    // Never fatal — a diagnostic, not a gate.
  }

  const path = localNpmrcPath();
  try {
    await mkdir(join(app.getPath('userData'), 'npm'), { recursive: true });
    // 0600: it carries no secret today, but it is npm auth configuration and
    // should not be world-readable if that ever changes.
    await writeFile(path, NPMRC_CONTENTS, { mode: 0o600 });
  } catch (error) {
    log.warn('npmRegistryAuth: could not write npmrc', {
      event: 'npm_registry_auth_write_failed',
      path,
      error: String(error),
    });
    return {};
  }

  log.info('npmRegistryAuth: registry access configured for spawned sessions', {
    event: 'npm_registry_auth_ready',
    npmrc: path,
  });
  return npmRegistryEnv(path, token);
}

/**
 * Registry access for a session on a remote host, over that host's execution
 * context.
 *
 * The desktop's own configuration is useless here: its npmrc path does not
 * exist on the VM and its token is the wrong machine's. Both have to be
 * produced there, which is why this exists rather than reusing the above.
 *
 * Writes to the same `<repoDir>/.switchdash/npmrc` the sidecar uses, so a host
 * ends up with one file however its sessions were started.
 */
export async function remoteNpmRegistryAuthEnv(
  ctx: IExecutionContext,
  repoDir: string
): Promise<Record<string, string>> {
  let token = '';
  try {
    const { stdout } = await ctx.exec('gh', ['auth', 'token'], { timeout: 15_000 });
    token = stdout.trim();
  } catch (error) {
    log.warn('npmRegistryAuth: `gh auth token` failed on the remote host', {
      event: 'npm_registry_auth_no_gh',
      error: String(error),
    });
    return {};
  }
  if (!token) {
    log.warn('npmRegistryAuth: no GitHub token on the remote host', {
      event: 'npm_registry_auth_missing_token',
      hint: 'run `gh auth login` there; the package is private and reads as 404 without it',
    });
    return {};
  }

  try {
    const { stdout } = await ctx.exec('gh', GH_AUTH_STATUS_ARGS, { timeout: 15_000 });
    warnAboutGhAuth(parseGhAuthStatus(stdout), 'the remote host');
  } catch {
    // Never fatal — a diagnostic, not a gate.
  }

  const dir = `${repoDir}/.switchdash`;
  const npmrc = `${dir}/npmrc`;
  try {
    await ctx.exec('sh', [
      '-c',
      `mkdir -p ${quoteShellArg(dir)} && printf %s ${quoteShellArg(NPMRC_CONTENTS)} > ${quoteShellArg(npmrc)} && chmod 600 ${quoteShellArg(npmrc)}`,
    ]);
  } catch (error) {
    log.warn('npmRegistryAuth: could not write npmrc on the remote host', {
      event: 'npm_registry_auth_write_failed',
      path: npmrc,
      error: String(error),
    });
    return {};
  }

  log.info('npmRegistryAuth: registry access configured for the remote session', {
    event: 'npm_registry_auth_ready',
    npmrc,
  });
  return npmRegistryEnv(npmrc, token);
}
