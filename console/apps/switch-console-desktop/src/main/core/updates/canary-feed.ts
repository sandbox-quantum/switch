import { RELEASE_REPO_NAME, RELEASE_REPO_OWNER } from '@shared/app-identity';

const RELEASES_API_URL = `https://api.github.com/repos/${RELEASE_REPO_OWNER}/${RELEASE_REPO_NAME}/releases`;
const RELEASES_DOWNLOAD_URL = `https://github.com/${RELEASE_REPO_OWNER}/${RELEASE_REPO_NAME}/releases/download`;
const PAGE_SIZE = 100;
/**
 * How far back to look. The repo also publishes a prerelease for every agents
 * controller build, several a day, so a canary can sit a few pages down.
 */
const MAX_PAGES = 5;

/** Canary tags as .github/workflows/switch-console-release.yml accepts them. */
const CANARY_TAG = /^v\d+\.\d+\.\d+-canary\.(\d+|rc\.\d+)$/;

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
}

/**
 * The tag of the newest published canary release.
 *
 * electron-updater's own GitHub provider finds a prerelease through the releases
 * Atom feed, which lists only the ten newest releases of the repo. The agents
 * controller's per-build prereleases push every canary out of it within hours,
 * and the provider then reports ERR_UPDATER_NO_PUBLISHED_VERSIONS. The releases
 * API can page further back.
 *
 * GitHub lists releases newest first, so the first canary found is the latest.
 */
export async function findLatestCanaryTag(): Promise<string> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await fetch(`${RELEASES_API_URL}?per_page=${PAGE_SIZE}&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache' },
    });
    if (!response.ok) {
      throw new Error(`Could not list canary releases: GitHub answered HTTP ${response.status}`);
    }
    const releases = (await response.json()) as GitHubRelease[];
    const canary = releases.find((r) => !r.draft && CANARY_TAG.test(r.tag_name));
    if (canary) return canary.tag_name;
    if (releases.length < PAGE_SIZE) break;
  }
  throw new Error(
    `No published canary release among the newest ${MAX_PAGES * PAGE_SIZE} releases of the repo`
  );
}

/**
 * The download URL of the newest published canary release, for electron-updater's
 * generic provider to read `canary*.yml` and the installers from.
 */
export async function resolveCanaryFeedUrl(): Promise<string> {
  return `${RELEASES_DOWNLOAD_URL}/${await findLatestCanaryTag()}`;
}
