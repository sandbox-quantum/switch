/** The source repository. Not documentation — see {@link SWITCH_CONSOLE_DOCS_URL}. */
export const SWITCH_CONSOLE_REPO_URL = 'https://github.com/sandbox-quantum/switch';

export const SWITCH_CONSOLE_RELEASES_URL = `${SWITCH_CONSOLE_REPO_URL}/releases`;
const SWITCH_CONSOLE_RELEASES_API_URL =
  'https://api.github.com/repos/sandbox-quantum/switch/releases';

/**
 * The desktop app shares its repo with switch-core, so its release tags are
 * namespaced `switch-console-v<version>` — see .github/workflows/switch-console-release.yml.
 * Canaries are the exception: they are tagged bare `v<version>`, because
 * electron-updater skips any prerelease tag that is not plain semver.
 */
export function switchConsoleReleaseTag(version: string): string {
  const bare = version.replace(/^v/, '');
  return bare.includes('-canary.') ? `v${bare}` : `switch-console-v${bare}`;
}

/**
 * Release page for one specific version. Falls back to the releases index when
 * the version is unknown, so the link is never dead.
 */
export function switchConsoleReleaseUrl(version: string | undefined): string {
  if (!version) return SWITCH_CONSOLE_RELEASES_URL;
  return `${SWITCH_CONSOLE_RELEASES_URL}/tag/${switchConsoleReleaseTag(version)}`;
}

/** GitHub API endpoint for one version's release, for reading its notes. */
export function switchConsoleReleaseApiUrl(version: string): string {
  return `${SWITCH_CONSOLE_RELEASES_API_URL}/tags/${switchConsoleReleaseTag(version)}`;
}
/**
 * The published documentation site. Deep-link to the page that answers the
 * question at hand; {@link SWITCH_CONSOLE_DOCS_URL} is the entry point for a
 * bare "Docs" affordance that is not about anything in particular.
 */
const SWITCH_DOCS_BASE = 'https://docs.switchagents.ai/switch-rooms';

export const SWITCH_CONSOLE_DOCS_URL = `${SWITCH_DOCS_BASE}/getting-started`;
export const SWITCH_DOCS_REMOTE_HOSTING_URL = `${SWITCH_DOCS_BASE}/deploy/host-remotely`;
export const SWITCH_DOCS_MESSAGING_APPS_URL = `${SWITCH_DOCS_BASE}/deploy/messaging-apps`;
export const SWITCH_DOCS_ROOMS_URL = `${SWITCH_DOCS_BASE}/using/work-in-a-room`;

export const SWITCH_CONSOLE_ISSUES_URL = `${SWITCH_CONSOLE_REPO_URL}/issues`;
export const SWITCH_CONSOLE_ISSUES_NEW_URL = `${SWITCH_CONSOLE_REPO_URL}/issues/new/choose`;
