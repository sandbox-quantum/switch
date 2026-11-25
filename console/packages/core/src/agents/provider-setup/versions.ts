import { code, rich, runActivity, type RichText } from '@switch-console/shared';
import type { Installation, InstallationState, RunContext, UpdateCheck } from './types';

const LOOKUP_TIMEOUT_MS = 10_000;

/** The JSON at `url`; null where it cannot be fetched or read. */
async function fetchJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** The version `lookUp` finds, as one activity in `s`'s log; null where it could not find out. */
function latestFrom(
  s: { activity: RunContext['activity'] },
  title: string,
  description: RichText,
  lookUp: () => Promise<string | null>
): Promise<string | null> {
  return runActivity(s.activity, title, description, async (update) => {
    const found = await lookUp();
    update(
      found
        ? { outcome: rich`version ${code(found)}` }
        : { status: 'failed', outcome: rich`could not find out` }
    );
    return found;
  });
}

/** The latest version of `pkg` on npm; null where it could not find out. */
export function latestOnNpm(
  s: { activity: RunContext['activity'] },
  pkg: string
): Promise<string | null> {
  return latestFrom(
    s,
    'Looking up the latest version on npm',
    rich`Package ${code(pkg)}`,
    async () => {
      const json = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`);
      const version = (json as { version?: unknown } | null)?.version;
      return typeof version === 'string' ? version : null;
    }
  );
}

/** The latest release of `repo` on GitHub, by its tag; null where it could not find out. */
export function latestOnGitHub(
  s: { activity: RunContext['activity'] },
  repo: `${string}/${string}`
): Promise<string | null> {
  return latestFrom(
    s,
    'Looking up the latest release on GitHub',
    rich`Repository ${code(repo)}`,
    async () => {
      const json = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
      const tag = (json as { tag_name?: unknown } | null)?.tag_name;
      return typeof tag === 'string' ? tag.replace(/^v/, '') : null;
    }
  );
}

/**
 * Checks `installation` for updates with `check`, reporting to `activity`:
 * the latest version, and whether it is behind it.
 */
export async function checkForUpdates(
  installation: Installation,
  check: UpdateCheck,
  activity: RunContext['activity']
): Promise<Pick<InstallationState, 'latestVersion' | 'updateAvailable'>> {
  const latestVersion = await check(activity);
  return {
    latestVersion,
    updateAvailable:
      installation.version && latestVersion ? isBehind(installation.version, latestVersion) : null,
  };
}

/**
 * Compares dotted versions numerically, segment by segment; missing segments
 * count as 0, and anything after the numbers (`-beta.1`) is ignored.
 */
function compareVersions(a: string, b: string): number {
  const segments = (version: string) =>
    (/^\d+(\.\d+)*/.exec(version)?.[0] ?? '').split('.').map(Number);
  const [pa, pb] = [segments(a), segments(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Whether `version` is older than `latest`; false where either is unknown. */
export function isBehind(version: string | null, latest: string | null): boolean {
  return !!version && !!latest && compareVersions(version, latest) < 0;
}
