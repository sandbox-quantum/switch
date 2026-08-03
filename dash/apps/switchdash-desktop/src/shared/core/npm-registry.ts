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

/**
 * Whether `gh auth status` output describes a token that cannot read packages.
 *
 * `gh auth login` asks for `gist`, `read:org`, `repo` and `workflow` — not
 * `read:packages`. A perfectly healthy default login therefore yields a token
 * the registry refuses with a 403 about "expected scopes", several layers below
 * anything that mentions `gh`.
 *
 * Returns false when no scope line is present: the output is human-readable and
 * may change, and being wrong about it must never block a session from starting.
 */
export function lacksReadPackages(ghAuthStatusOutput: string): boolean {
  return (
    ghAuthStatusOutput.includes('Token scopes:') && !ghAuthStatusOutput.includes('read:packages')
  );
}

/** The environment that points npm at a written npmrc. */
export function npmRegistryEnv(npmrcPath: string, token: string): Record<string, string> {
  return { npm_config_userconfig: npmrcPath, [NPM_TOKEN_VAR]: token };
}
