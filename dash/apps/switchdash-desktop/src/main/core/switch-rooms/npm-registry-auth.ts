import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { GH_EXECUTABLE, getGithubTokenFromGhCli } from '@main/core/updates/github-token';
import { log } from '@main/lib/logger';
import { quoteShellArg } from '@main/utils/shellEscape';
import {
  lacksReadPackages,
  NPMRC_CONTENTS,
  npmRegistryEnv,
  READ_PACKAGES_FIX,
} from '@shared/core/npm-registry';

const execFileAsync = promisify(execFile);

/**
 * Registry access for sessions switchdash starts, local and remote.
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

function localNpmrcPath(): string {
  return join(app.getPath('userData'), 'npm', 'npmrc');
}

/**
 * Registry access for a session on this machine.
 *
 * The npmrc is ours, not the user's: `~/.npmrc` is their configuration and
 * editing it to make our plugin work is a reach, while a file in their project
 * shows up in git status. `npm_config_userconfig` makes npm read ours instead,
 * confining the footprint to switchdash's own directory.
 */
export async function npmRegistryAuthEnv(): Promise<Record<string, string>> {
  const token = await getGithubTokenFromGhCli();
  if (!token) {
    log.warn('npmRegistryAuth: no GitHub token from `gh` — the agent runtime will not resolve', {
      event: 'npm_registry_auth_missing_token',
      hint: 'run `gh auth login`; a private package reads as 404 without it',
    });
    return {};
  }

  try {
    const { stdout, stderr } = await execFileAsync(GH_EXECUTABLE, ['auth', 'status'], {
      timeout: 10_000,
    });
    if (lacksReadPackages(`${stdout}${stderr}`)) {
      log.warn('npmRegistryAuth: the GitHub token cannot read packages', {
        event: 'npm_registry_auth_missing_scope',
        fix: READ_PACKAGES_FIX,
        detail: MISSING_SCOPE_DETAIL,
      });
    }
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
    const { stdout, stderr } = await ctx.exec('gh', ['auth', 'status'], { timeout: 15_000 });
    if (lacksReadPackages(`${stdout}${stderr}`)) {
      log.warn('npmRegistryAuth: the remote GitHub token cannot read packages', {
        event: 'npm_registry_auth_missing_scope',
        fix: READ_PACKAGES_FIX,
        detail: MISSING_SCOPE_DETAIL,
      });
    }
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
