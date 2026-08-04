export const SWITCHDASH_RELEASES_URL = 'https://github.com/sandbox-quantum/switch/releases';

/**
 * Release page for one specific version. Falls back to the releases index when
 * the version is unknown, so the link is never dead.
 */
export function switchdashReleaseUrl(version: string | undefined): string {
  if (!version) return SWITCHDASH_RELEASES_URL;
  const tag = version.startsWith('v') ? version : `v${version}`;
  return `${SWITCHDASH_RELEASES_URL}/tag/${tag}`;
}
export const SWITCHDASH_DOCS_URL = 'https://github.com/sandbox-quantum/switch';
export const SWITCHDASH_ISSUES_URL = 'https://github.com/sandbox-quantum/switch/issues';
export const SWITCHDASH_ISSUES_NEW_URL =
  'https://github.com/sandbox-quantum/switch/issues/new/choose';
