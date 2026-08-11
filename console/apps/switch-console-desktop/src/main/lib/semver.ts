import semver from 'semver';

/**
 * Version comparison for the loosely-formatted version strings this app deals
 * in — CLI `--version` output, container image tags, GitHub release names.
 * Both sides are coerced first, so `v1.2.3`, `1.2.3` and `switch-core 1.2.3`
 * all compare as the same release.
 */

/**
 * Three-way compare of two versions: negative when `a` is older, `0` when they
 * are the same release, positive when `a` is newer.
 *
 * Returns `null` when either side cannot be coerced to a semver, so callers can
 * tell "not comparable" apart from "equal" instead of silently treating an
 * unparseable version as a match.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = semver.coerce(a);
  const right = semver.coerce(b);
  if (left === null || right === null) return null;
  return semver.compare(left, right);
}

/** Whether `latest` is a strictly newer release than `installed`. An
 * uncomparable pair counts as "not newer" — the caller keeps what it has. */
export function isNewerVersion(installed: string, latest: string): boolean {
  return compareVersions(installed, latest) === -1;
}
