import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { spawnLocalPty } from '@main/core/pty/local-pty';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import { GH_EXECUTABLE } from '@main/core/updates/github-token';
import { log } from '@main/lib/logger';
import {
  GH_AUTH_STATUS_ARGS,
  GH_HOST,
  type GhAuthState,
  isEnvShadowedToken,
  READ_PACKAGES_SCOPE,
} from '@shared/core/npm-registry';
import { parseGhAuthStatus } from '@shared/core/npm-registry';

const execFileAsync = promisify(execFile);

/**
 * Whether this machine can fetch the Switch MCP runtime from GitHub Packages.
 *
 * The remote-hosts page has had this for a while; locally there was nothing, so
 * the same misconfiguration produced a session that looked healthy and silently
 * had no Switch tools.
 */
export type LocalGhAuthStatus = {
  ghInstalled: boolean;
  authenticated: boolean;
  account: string | null;
  canReadPackages: boolean;
  /**
   * An environment token is being used instead of the keyring.
   *
   * Worth its own field rather than folding into the others: it is the one
   * state that re-authenticating does not fix, so the UI has to say something
   * different. `gh` prefers `GH_TOKEN`/`GITHUB_TOKEN`, and switchdash inherits
   * whatever the user's shell exported.
   */
  envShadowed: boolean;
  /** Why the credential is unusable, when it is. */
  detail: string | null;
};

const READY: Pick<LocalGhAuthStatus, 'ghInstalled' | 'authenticated' | 'canReadPackages'> = {
  ghInstalled: true,
  authenticated: true,
  canReadPackages: true,
};

function statusFrom(state: GhAuthState): LocalGhAuthStatus {
  const envShadowed = isEnvShadowedToken(state);
  switch (state.status) {
    case 'ok':
      return { ...READY, account: state.login, envShadowed, detail: null };
    case 'missing-scope':
      return {
        ...READY,
        canReadPackages: false,
        account: state.login,
        envShadowed,
        detail: `The GitHub token is missing the ${READ_PACKAGES_SCOPE} scope.`,
      };
    case 'invalid':
      return {
        ghInstalled: true,
        authenticated: false,
        canReadPackages: false,
        account: null,
        envShadowed,
        detail: state.detail,
      };
    case 'unknown':
      // The check did not apply. Claiming a fault we cannot see would block
      // setup for someone whose install works.
      return { ...READY, account: null, envShadowed: false, detail: null };
  }
}

/** What `gh` on this machine will do, in the shape the setup UI renders. */
export async function probeLocalGhAuth(): Promise<LocalGhAuthStatus> {
  try {
    const { stdout } = await execFileAsync(GH_EXECUTABLE, GH_AUTH_STATUS_ARGS, {
      timeout: 10_000,
    });
    return statusFrom(parseGhAuthStatus(stdout));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return {
        ghInstalled: false,
        authenticated: false,
        canReadPackages: false,
        account: null,
        envShadowed: false,
        detail: 'The GitHub CLI (gh) is not installed.',
      };
    }
    // `gh auth status --json` exits zero even for a rejected token, so a
    // non-zero exit here means no login at all rather than a bad one. Older gh
    // versions that reject `--json` also land here; they are reported the same
    // way, and the authenticate flow that follows is correct for both.
    const stdout = (error as { stdout?: string } | undefined)?.stdout;
    if (stdout) {
      const state = parseGhAuthStatus(stdout);
      if (state.status !== 'unknown') return statusFrom(state);
    }
    return {
      ghInstalled: true,
      authenticated: false,
      canReadPackages: false,
      account: null,
      envShadowed: false,
      detail: 'Not logged in to GitHub.',
    };
  }
}

/**
 * The environment for the interactive login.
 *
 * `GH_TOKEN`/`GITHUB_TOKEN` are removed so the flow acts on the keyring: `gh`
 * prefers them, and `gh auth refresh` against an environment token fails rather
 * than adding the scope. Removing them here only affects this one child — a
 * user who genuinely authenticates by environment variable still has it, and
 * `envShadowed` is how they are told it is what the runtime will use.
 */
function ghAuthEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === 'GH_TOKEN' || key === 'GITHUB_TOKEN') continue;
    env[key] = value;
  }
  return env;
}

/**
 * Start an interactive `gh` device-flow login on this machine, in a PTY the
 * renderer attaches a live terminal to.
 *
 * `read:packages` is requested explicitly because `gh auth login` does not ask
 * for it — its defaults are `gist`, `read:org`, `repo` and `workflow`. Asking
 * during the one interactive login the user already performs is the only point
 * where it costs nothing; every other route ends in `gh auth refresh` on a
 * machine they thought was set up.
 *
 * Refresh when already logged in, login when not: `gh auth login` on an
 * authenticated machine stops to ask whether you meant to re-authenticate,
 * which is a confusing thing to meet when all you needed was a scope. The
 * branch is decided here rather than in a shell so there is no quoting to get
 * wrong and nothing that assumes a POSIX shell exists.
 */
export async function startLocalGhAuth(): Promise<{ sessionId: string }> {
  const status = await probeLocalGhAuth();
  if (!status.ghInstalled) {
    throw new Error(
      'The GitHub CLI (gh) is not installed. Install it from https://cli.github.com and try again.'
    );
  }

  const args = status.authenticated
    ? ['auth', 'refresh', '--hostname', GH_HOST, '--scopes', READ_PACKAGES_SCOPE]
    : [
        'auth',
        'login',
        '--hostname',
        GH_HOST,
        '--git-protocol',
        'https',
        '--web',
        '--scopes',
        READ_PACKAGES_SCOPE,
      ];

  const sessionId = `gh-auth-local:${crypto.randomUUID()}`;
  log.info('startLocalGhAuth: starting interactive gh auth', {
    event: 'local_gh_auth_start',
    mode: status.authenticated ? 'refresh' : 'login',
    sessionId,
  });

  const pty = spawnLocalPty({
    id: sessionId,
    command: GH_EXECUTABLE,
    args,
    cwd: homedir(),
    env: ghAuthEnv(),
    cols: 80,
    rows: 24,
  });

  ptySessionRegistry.register(sessionId, pty, {
    metadata: { title: 'gh auth login', isRemote: false },
  });
  return { sessionId };
}
