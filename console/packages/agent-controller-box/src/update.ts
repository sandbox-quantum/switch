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

/**
 * A controller release version: `x.y.z`, or `x.y.z-<pre>` with dot-separated
 * alphanumeric identifiers, as a dev build of main publishes
 * (`0.31.1-dev.412.gabc1234`). Build metadata (`+…`) is not used.
 */
export const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;

type Version = { core: [number, number, number]; pre: string[] };

function parseVersion(value: string): Version | null {
  const match = RELEASE_VERSION.exec(value);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  };
}

/** Whether `value` is a plain `x.y.z` release, not a prerelease. */
export function isPlainVersion(value: string): boolean {
  const parsed = parseVersion(value);
  return parsed !== null && parsed.pre.length === 0;
}

/** Semver precedence of two prerelease identifiers. */
function compareIdentifier(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) return Number(a) - Number(b);
  if (numericA !== numericB) return numericA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Whether `candidate` is a later release than `current`, by semver precedence:
 * `0.31.0-dev.3` < `0.31.0-dev.12` < `0.31.0`. A version that is neither form
 * never is.
 */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++)
    if (a.core[index] !== b.core[index]) return a.core[index]! > b.core[index]!;
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === 0 && b.pre.length > 0;
  for (let index = 0; index < Math.min(a.pre.length, b.pre.length); index++) {
    const order = compareIdentifier(a.pre[index]!, b.pre[index]!);
    if (order !== 0) return order > 0;
  }
  return a.pre.length > b.pre.length;
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
    if (!isPlainVersion(version)) continue;
    const asset = release.assets.find((candidate) => candidate.name === packageAssetName(version));
    if (!asset) continue;
    if (!best || isNewer(version, best.version))
      best = { version, packageUrl: asset.browser_download_url };
  }
  return best;
}
