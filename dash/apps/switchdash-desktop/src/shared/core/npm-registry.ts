/**
 * Registry access for the Switch agent runtime, shared by every spawn path.
 *
 * The Claude Code plugin fetches its MCP server with
 * `npx @sandbox-quantum/switch-agent-runtime`. That package lives on GitHub
 * Packages and is private, so npm needs two things it does not know by
 * default: which registry serves the scope, and a token for it. Absent both,
 * npm asks npmjs.com, which has never heard of the package — so the failure
 * reads as a plain 404 for something that does not exist, rather than anything
 * about registries or credentials.
 *
 * Three places have to arrange this — the desktop for local sessions, the
 * sidecar for sessions it starts on a VM, and the SSH runtime for remote
 * sessions started from the desktop. They differ only in how they run `gh` and
 * write a file. Everything they must agree on lives here, because when it was
 * copied per path instead, one copy was simply missing and the symptom was a
 * 404 that named neither the cause nor the path that lacked it.
 */

export const NPM_REGISTRY_HOST = 'npm.pkg.github.com';
export const NPM_SCOPE = '@sandbox-quantum';

/**
 * The token is referenced, never written.
 *
 * npm expands `${VAR}` in an `.npmrc` as it reads it, so the file holds a
 * pointer to an environment variable rather than a credential. The value is
 * placed in the session's environment at spawn and lives only in that process.
 */
export const NPM_TOKEN_VAR = 'SWITCHDASH_GITHUB_TOKEN';

export const NPMRC_CONTENTS = [
  `${NPM_SCOPE}:registry=https://${NPM_REGISTRY_HOST}`,
  `//${NPM_REGISTRY_HOST}/:_authToken=\${${NPM_TOKEN_VAR}}`,
  '',
].join('\n');

/** How to fix a token that authenticates but cannot read packages. */
export const READ_PACKAGES_FIX = 'gh auth refresh -h github.com -s read:packages';

export const GH_HOST = 'github.com';

/** The scope the registry requires, which `gh auth login` does not request. */
export const READ_PACKAGES_SCOPE = 'read:packages';

/**
 * Ask `gh` which identity it will actually use, in machine-readable form.
 *
 * `--active` narrows the answer to the account that will be used, and `--json`
 * makes the scopes a field rather than a line of prose. Both matter: the human
 * output lists every known account, so a scope search over it answers a
 * question nobody asked — whether *some* account has the scope — and a second
 * account that does have it will vouch for one that does not.
 */
export const GH_AUTH_STATUS_ARGS = ['auth', 'status', '--active', '--json', 'hosts'];

/** What `gh` will do with the credentials it currently has. */
export type GhAuthState =
  | { status: 'ok'; login: string; scopes: string[]; tokenSource: string }
  | { status: 'missing-scope'; login: string; scopes: string[]; tokenSource: string }
  | { status: 'invalid'; tokenSource: string; detail: string }
  | { status: 'unknown' };

type GhAuthHostEntry = {
  state?: string;
  active?: boolean;
  login?: string;
  tokenSource?: string;
  scopes?: string;
  error?: string;
};

/**
 * Interpret `gh auth status --active --json hosts`.
 *
 * `tokenSource` is carried through because it names the origin of the
 * credential — a path for the keyring, or the literal `GH_TOKEN` when an
 * environment variable is shadowing it. When a login appears not to have taken
 * effect, that distinction is the answer, and it is not recoverable later.
 *
 * Unrecognised output yields `unknown` rather than a guess. This gates setup,
 * and being confidently wrong about someone's working install is worse than
 * admitting the check did not apply.
 */
export function parseGhAuthStatus(stdout: string): GhAuthState {
  let entries: GhAuthHostEntry[];
  try {
    const parsed = JSON.parse(stdout) as { hosts?: Record<string, GhAuthHostEntry[]> };
    entries = parsed.hosts?.[GH_HOST] ?? [];
  } catch {
    return { status: 'unknown' };
  }

  const active = entries.find((entry) => entry.active) ?? entries[0];
  if (!active) return { status: 'unknown' };

  const tokenSource = active.tokenSource ?? 'unknown';
  if (active.state !== 'success') {
    return {
      status: 'invalid',
      tokenSource,
      detail: active.error ?? 'gh reported the active token is not usable',
    };
  }

  if (active.scopes === undefined) return { status: 'unknown' };
  const scopes = active.scopes
    .split(',')
    .map((scope) => scope.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);

  return {
    status: scopes.includes(READ_PACKAGES_SCOPE) ? 'ok' : 'missing-scope',
    login: active.login ?? '',
    scopes,
    tokenSource,
  };
}

/** Whether a token is shadowing the keyring, which survives re-authentication. */
export function isEnvShadowedToken(state: GhAuthState): boolean {
  if (state.status === 'unknown') return false;
  return state.tokenSource === 'GH_TOKEN' || state.tokenSource === 'GITHUB_TOKEN';
}

/** The environment that points npm at a written npmrc. */
export function npmRegistryEnv(npmrcPath: string, token: string): Record<string, string> {
  return { npm_config_userconfig: npmrcPath, [NPM_TOKEN_VAR]: token };
}
