import semver from 'semver';

/**
 * Version comparison for the loosely-formatted version strings this app deals
 * in — CLI `--version` output, container image tags, GitHub release names.
 *
 * A string that is a version already (`1.2.3`, `v1.2.3`, `0.32.0-rc.7`) is
 * compared as one, prerelease tag and all, so `0.32.0-rc.5` is older than
 * `0.32.0-rc.7`, which is older than `0.32.0`. Anything else is coerced, so
 * `switch-core 1.2.3` compares as `1.2.3`.
 */

function parse(version: string): semver.SemVer | null {
  const cleaned = semver.clean(version);
  if (cleaned !== null) return new semver.SemVer(cleaned);
  return semver.coerce(version);
}

/**
 * Three-way compare of two versions: negative when `a` is older, `0` when they
 * are the same release, positive when `a` is newer.
 *
 * Returns `null` when either side cannot be read as a semver, so callers can
 * tell "not comparable" apart from "equal" instead of silently treating an
 * unparseable version as a match.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parse(a);
  const right = parse(b);
  if (left === null || right === null) return null;
  return semver.compare(left, right);
}

/** Whether `latest` is a strictly newer release than `installed`. An
 * uncomparable pair counts as "not newer" — the caller keeps what it has. */
export function isNewerVersion(installed: string, latest: string): boolean {
  return compareVersions(installed, latest) === -1;
}
