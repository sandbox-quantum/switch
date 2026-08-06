export const SWITCHDASH_RELEASES_URL = 'https://github.com/sandbox-quantum/switch/releases';
const SWITCHDASH_RELEASES_API_URL = 'https://api.github.com/repos/sandbox-quantum/switch/releases';

/**
 * The desktop app shares its repo with switch-core, so its release tags are
 * namespaced `switchdash-v<version>` — see .github/workflows/switchdash-release.yml,
 * which only triggers on that prefix. A bare `v<version>` tag belongs to nothing.
 */
export function switchdashReleaseTag(version: string): string {
  return `switchdash-v${version.replace(/^v/, '')}`;
}

/**
 * Release page for one specific version. Falls back to the releases index when
 * the version is unknown, so the link is never dead.
 */
export function switchdashReleaseUrl(version: string | undefined): string {
  if (!version) return SWITCHDASH_RELEASES_URL;
  return `${SWITCHDASH_RELEASES_URL}/tag/${switchdashReleaseTag(version)}`;
}

/** GitHub API endpoint for one version's release, for reading its notes. */
export function switchdashReleaseApiUrl(version: string): string {
  return `${SWITCHDASH_RELEASES_API_URL}/tags/${switchdashReleaseTag(version)}`;
}
export const SWITCHDASH_DOCS_URL = 'https://github.com/sandbox-quantum/switch';
export const SWITCHDASH_ISSUES_URL = 'https://github.com/sandbox-quantum/switch/issues';
export const SWITCHDASH_ISSUES_NEW_URL =
  'https://github.com/sandbox-quantum/switch/issues/new/choose';
