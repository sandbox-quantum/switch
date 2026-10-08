import { z } from 'zod';

/** The repository whose releases carry the packaged controller; a fork names its own. */
export const RELEASES_REPOSITORY_ENV = 'SWITCH_CONTROLLER_RELEASES_REPOSITORY';
const DEFAULT_RELEASES_REPOSITORY = 'sandbox-quantum/switch';

/** Release tags are `switch-agent-controller-v<version>`. */
export const RELEASE_TAG_PREFIX = 'switch-agent-controller-v';

export function releasesRepository(env: NodeJS.ProcessEnv): string {
  const named = env[RELEASES_REPOSITORY_ENV]?.trim();
  if (!named) return DEFAULT_RELEASES_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(named))
    throw new Error(`${RELEASES_REPOSITORY_ENV} must be owner/name, not '${named}'.`);
  return named;
}

/**
 * The npm prefix this controller was installed under, from the file it runs
 * (`<prefix>/lib/node_modules/<package>/…`), so an update lands where the
 * installer put it, `~/.local` included, whatever npm's own prefix is. Null
 * when it does not run from an npm global install, a checkout say.
 */
export function installPrefix(cliFile: string): string | null {
  const marker = '/lib/node_modules/';
  const at = cliFile.lastIndexOf(marker);
  return at > 0 ? cliFile.slice(0, at) : null;
}

/** The file a release carries for `npm install -g`. */
export function packageAssetName(version: string): string {
  return `switch-agent-controller-${version}.tgz`;
}

const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
});

export type ControllerRelease = { version: string; packageUrl: string };

type Version = [number, number, number];

function parseVersion(value: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether `candidate` is a later release than `current`; versions not plain x.y.z never are. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}

/**
 * The newest published controller release: the highest version among the
 * repository's releases tagged for the controller, leaving out drafts,
 * prereleases and a release without its package. The repository also
 * releases Switch and Switch Console, so "the latest release" is not it.
 */
export async function latestRelease(
  fetchImpl: typeof fetch,
  repository: string
): Promise<ControllerRelease | null> {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/releases?per_page=100`,
    { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) }
  );
  if (!response.ok)
    throw new Error(`GitHub answered ${response.status} when listing ${repository}'s releases.`);
  const releases = z.array(releaseSchema).parse(await response.json());
  let best: ControllerRelease | null = null;
  for (const release of releases) {
    if (release.draft || release.prerelease || !release.tag_name.startsWith(RELEASE_TAG_PREFIX))
      continue;
    const version = release.tag_name.slice(RELEASE_TAG_PREFIX.length);
    if (!parseVersion(version)) continue;
    const asset = release.assets.find((candidate) => candidate.name === packageAssetName(version));
    if (!asset) continue;
    if (!best || isNewer(version, best.version))
      best = { version, packageUrl: asset.browser_download_url };
  }
  return best;
}
