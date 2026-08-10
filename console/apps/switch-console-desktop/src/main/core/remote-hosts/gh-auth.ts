/**
 * GitHub CLI authentication on a remote host.
 *
 * `gh` being on PATH is not enough to use it — it must also be logged in with a
 * token that can read GitHub Packages, and that login is an interactive device
 * flow. Extracted from the remote-hosts controller so the setup runner
 * (CHOO-1809) can probe auth as its own step rather than as a side effect of a
 * dependency sweep.
 */

import { isTransportFailure } from '@switch-console/core/exec';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import {
  GH_AUTH_STATUS_ARGS,
  type GhAuthState,
  parseGhAuthStatus,
  READ_PACKAGES_SCOPE,
} from '@shared/core/npm-registry';

export type GhAuthStatus = {
  authenticated: boolean;
  account: string | null;
  /**
   * Whether the token can read GitHub Packages.
   *
   * Authenticated is not sufficient: `gh auth login` requests `gist`,
   * `read:org`, `repo` and `workflow`, and not `read:packages`. Sessions on
   * this host fetch their MCP runtime from GitHub Packages, so without it they
   * start with no tools and the registry's `403 … does not match expected
   * scopes` is the only clue — reported nowhere near the host that caused it.
   */
  canReadPackages: boolean;
  /** Why the credential is unusable, when it is. Null when it is fine. */
  detail: string | null;
};

const NOT_LOGGED_IN: GhAuthStatus = {
  authenticated: false,
  account: null,
  canReadPackages: false,
  detail: 'Not logged in to GitHub on this host.',
};

function statusFrom(state: GhAuthState): GhAuthStatus {
  switch (state.status) {
    case 'ok':
      return { authenticated: true, account: state.login, canReadPackages: true, detail: null };
    case 'missing-scope':
      return {
        authenticated: true,
        account: state.login,
        canReadPackages: false,
        detail: `The GitHub token is missing the ${READ_PACKAGES_SCOPE} scope.`,
      };
    case 'invalid':
      return { ...NOT_LOGGED_IN, detail: state.detail };
    case 'unknown':
      // The check did not apply — do not invent a fault the host may not have.
      return { authenticated: true, account: null, canReadPackages: true, detail: null };
  }
}

/**
 * What `gh` on a remote host will do with the credentials it currently has.
 *
 * A non-zero exit (which SshExecutionContext throws on) means `gh` is missing
 * or has no login at all. A transport failure propagates rather than being read
 * as "not logged in" — a dead connection is not evidence about the login state.
 *
 * `--json` exits zero even when the token is rejected, so an unusable
 * credential arrives as a parsed `invalid` rather than as a throw, and is
 * reported as not authenticated: a token the API refuses is no better than
 * none, and saying "authenticated" of it sends the user looking elsewhere.
 */
export async function probeGhAuthStatus(sshHost: string): Promise<GhAuthStatus> {
  const proxy = await ensureSshConnected(sshConnectionIdForHost(sshHost), sshHost);
  const ctx = new SshExecutionContext(proxy);
  try {
    const { stdout } = await ctx.exec('gh', GH_AUTH_STATUS_ARGS);
    return statusFrom(parseGhAuthStatus(stdout));
  } catch (error) {
    if (isTransportFailure(error)) throw error;
    // Older gh versions reject `--json` and exit non-zero with nothing useful
    // to parse; they land here alongside a genuinely logged-out host. The
    // sign-in flow that follows is the right answer for both.
    const stdout = (error as { stdout?: string } | undefined)?.stdout;
    if (stdout) {
      const state = parseGhAuthStatus(stdout);
      if (state.status !== 'unknown') return statusFrom(state);
    }
    return NOT_LOGGED_IN;
  }
}
