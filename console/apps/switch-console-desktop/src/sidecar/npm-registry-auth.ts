import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  GH_AUTH_STATUS_ARGS,
  isEnvShadowedToken,
  NPMRC_CONTENTS,
  npmRegistryEnv,
  parseGhAuthStatus,
  READ_PACKAGES_FIX,
} from '@shared/core/npm-registry';
import type { WatcherLogger } from './notification-watcher';

const execFileAsync = promisify(execFile);

/**
 * Registry access for sessions this sidecar starts on the VM.
 *
 * The Claude Code plugin fetches its MCP server with
 * `npx @sandbox-quantum/switch-agent-runtime`. That package is on GitHub
 * Packages and private, so npm needs to be told which registry serves the
 * scope and how to authenticate. Told neither, it asks npmjs.com, which has
 * never heard of it — the failure reads as a plain 404 for a package that does
 * not exist, rather than anything about registries or credentials.
 *
 * This is the VM-side counterpart of Switch Console's `npmRegistryAuthEnv`. Same
 * two settings, same env-var indirection so no token is written to disk; the
 * only difference is that the token comes from the VM's own `gh`, which is a
 * core host dependency, rather than the desktop's.
 */

async function ghToken(log: WatcherLogger): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 10_000 });
    const token = stdout.trim();
    return token.length > 0 ? token : null;
  } catch (error) {
    log.warn('npmRegistryAuth: `gh auth token` failed on this host', {
      event: 'npm_registry_auth_no_gh',
      error: String(error),
    });
    return null;
  }
}

/**
 * Warn when the credentials `gh` will use cannot fetch the runtime.
 *
 * `gh auth login` asks for `gist`, `read:org`, `repo` and `workflow` — not
 * `read:packages`. So the default, perfectly healthy login produces a token
 * that authenticates fine and is then refused by the registry with a 403 about
 * "expected scopes", several layers below anything that mentions `gh`.
 *
 * Checked here so the cause is stated at spawn, where it is actionable, rather
 * than inferred later from an npx failure. Only a warning: an unrecognised
 * answer must not stop a session starting.
 */
async function warnAboutGhAuth(log: WatcherLogger): Promise<void> {
  try {
    const { stdout } = await execFileAsync('gh', GH_AUTH_STATUS_ARGS, { timeout: 10_000 });
    const state = parseGhAuthStatus(stdout);
    if (isEnvShadowedToken(state)) {
      log.warn('npmRegistryAuth: an environment token is shadowing the gh login', {
        event: 'npm_registry_auth_env_shadowed',
        tokenSource: state.status === 'unknown' ? 'unknown' : state.tokenSource,
        detail:
          'gh prefers GH_TOKEN/GITHUB_TOKEN over the keyring, so authenticating on ' +
          'this host will not change which token is used until that variable is unset',
      });
    }
    if (state.status === 'missing-scope') {
      log.warn('npmRegistryAuth: the GitHub token cannot read packages', {
        event: 'npm_registry_auth_missing_scope',
        account: state.login,
        scopes: state.scopes.join(', '),
        fix: READ_PACKAGES_FIX,
        detail:
          'gh auth login does not request read:packages, so the registry will refuse ' +
          'with 403 and the session will start without its MCP tools',
      });
    } else if (state.status === 'invalid') {
      log.warn('npmRegistryAuth: the active GitHub token is not usable', {
        event: 'npm_registry_auth_invalid_token',
        tokenSource: state.tokenSource,
        detail: state.detail,
      });
    }
  } catch {
    // Never fatal — this is a diagnostic, not a gate.
  }
}

/**
 * Write the npmrc and return the environment that points npm at it.
 *
 * Returns an empty environment when the host has no usable `gh`. The session
 * still starts: it will fail to fetch the runtime and come up without tools,
 * which is bad, but strictly better than not starting at all — and the warning
 * here names the cause, which a bare npm 404 would not.
 */
export async function npmRegistryAuthEnv(
  repoDir: string,
  log: WatcherLogger
): Promise<Record<string, string>> {
  const token = await ghToken(log);
  if (!token) {
    log.warn('npmRegistryAuth: no GitHub token — the agent runtime will not resolve', {
      event: 'npm_registry_auth_missing_token',
      hint: 'run `gh auth login` on this host; the package is private and reads as 404 without it',
    });
    return {};
  }

  await warnAboutGhAuth(log);

  const dir = path.join(repoDir, '.switchdash');
  const npmrc = path.join(dir, 'npmrc');
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(npmrc, NPMRC_CONTENTS, { mode: 0o600 });
  } catch (error) {
    log.warn('npmRegistryAuth: could not write npmrc', {
      event: 'npm_registry_auth_write_failed',
      path: npmrc,
      error: String(error),
    });
    return {};
  }

  log.info('npmRegistryAuth: registry access configured for spawned sessions', {
    event: 'npm_registry_auth_ready',
    npmrc,
  });
  return npmRegistryEnv(npmrc, token);
}
