export const SWITCH_CONSOLE_RELEASES_URL = 'https://github.com/sandbox-quantum/switch/releases';
const SWITCH_CONSOLE_RELEASES_API_URL =
  'https://api.github.com/repos/sandbox-quantum/switch/releases';

/**
 * The desktop app shares its repo with switch-core, so its release tags are
 * namespaced `switch-console-v<version>` — see .github/workflows/switch-console-release.yml,
 * which only triggers on that prefix. A bare `v<version>` tag belongs to nothing.
 */
export function switchConsoleReleaseTag(version: string): string {
  return `switch-console-v${version.replace(/^v/, '')}`;
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
export const SWITCH_CONSOLE_DOCS_URL = 'https://github.com/sandbox-quantum/switch';
export const SWITCH_CONSOLE_ISSUES_URL = 'https://github.com/sandbox-quantum/switch/issues';
export const SWITCH_CONSOLE_ISSUES_NEW_URL =
  'https://github.com/sandbox-quantum/switch/issues/new/choose';
