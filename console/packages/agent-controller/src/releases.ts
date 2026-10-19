import { lchown, lstat, readdir, readFile, readlink, rename, rm, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { RELEASE_VERSION } from './update';

/**
 * A releases directory: where a controller run by `install-service` keeps the
 * releases it installs for itself (`<data dir>/releases` for a service of
 * the user's, its own directory with `--separate-users`). Each
 * `<releases>/<version>/` is an npm prefix holding one release, and
 * `<releases>/current` links to the prefix the controller's unit and its
 * agents' units run from: one of those, or the one the controller was first
 * installed in (a machine image's, say), which stays outside it.
 */

/** The package name a release installs as (`scripts/package.mjs`). */
export const PACKAGE_NAME = 'switch-agent-controller';
export const CURRENT = 'current';
const CURRENT_NEXT = 'current.new';

/** Where an npm prefix holds the release's files. */
export function packageDir(prefix: string): string {
  return join(prefix, 'lib', 'node_modules', PACKAGE_NAME);
}

/** The command npm links into an npm prefix for the release. */
export function prefixBin(prefix: string): string {
  return join(prefix, 'bin', PACKAGE_NAME);
}

export function currentLink(releasesDir: string): string {
  return join(releasesDir, CURRENT);
}

/** `path`, a file of the release in the npm prefix `prefix`, as reached through `<releases>/current`; a path outside `prefix` as it is. */
export function throughCurrent(releasesDir: string, prefix: string, path: string): string {
  const inside = relative(prefix, path);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return path;
  return join(currentLink(releasesDir), inside);
}

/** What `<releases>/current` is now. */
export type CurrentRelease =
  | { kind: 'missing' }
  | { kind: 'not_a_link' }
  /** `version` is null when the link is dangling or what it names holds no readable release. */
  | { kind: 'link'; target: string; version: string | null };

export async function readCurrent(releasesDir: string): Promise<CurrentRelease> {
  const link = currentLink(releasesDir);
  try {
    if (!(await lstat(link)).isSymbolicLink()) return { kind: 'not_a_link' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  const named = await readlink(link);
  const target = isAbsolute(named) ? named : resolve(releasesDir, named);
  return { kind: 'link', target, version: await installedVersion(target) };
}

/** The version of the release installed in the npm prefix `prefix`; null when none is readable there. */
export async function installedVersion(prefix: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(join(packageDir(prefix), 'package.json'), 'utf8'));
    return typeof manifest?.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * Points `<releases>/current` at `target` in one step: a new link beside it,
 * renamed over it, so a unit starting meanwhile sees the old one or the new.
 */
export async function pointCurrent(
  releasesDir: string,
  target: string,
  owner: { uid: number; gid: number } | null
): Promise<void> {
  const next = join(releasesDir, CURRENT_NEXT);
  await rm(next, { force: true });
  await symlink(target, next);
  if (owner) await lchown(next, owner.uid, owner.gid);
  await rename(next, currentLink(releasesDir));
}

/**
 * Whether the npm prefix `prefix` is one release of a releases directory,
 * `<releases>/<version>` beside a `current` link, which only the controller
 * that owns it installs into.
 */
export async function isManagedRelease(prefix: string): Promise<boolean> {
  if (!RELEASE_VERSION.test(basename(prefix))) return false;
  try {
    return (await lstat(currentLink(dirname(prefix)))).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Removes the releases no longer needed: every version directory but those in
 * `keep` and the most recently installed other one, and what an interrupted
 * install left behind. Only entries of `releasesDir` are ever removed, so a
 * prefix outside it that `current` once named is never touched.
 */
export async function pruneReleases(releasesDir: string, keep: string[]): Promise<string[]> {
  const kept = new Set(keep.map((path) => resolve(path)));
  const current = await readCurrent(releasesDir);
  if (current.kind === 'link') kept.add(resolve(current.target));
  const spare: { path: string; mtimeMs: number }[] = [];
  const leftovers: string[] = [];
  for (const entry of await readdir(releasesDir)) {
    const path = join(releasesDir, entry);
    if (entry === CURRENT || kept.has(path)) continue;
    // Before the version test: `0.31.0-dev.4.partial` reads as a version too.
    if (entry === CURRENT_NEXT || /\.(partial|replaced-[\w-]+)$/.test(entry)) leftovers.push(path);
    else if (RELEASE_VERSION.test(entry))
      spare.push({ path, mtimeMs: (await lstat(path)).mtimeMs });
  }
  spare.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const removed = [...spare.slice(1).map((entry) => entry.path), ...leftovers];
  for (const path of removed) await rm(path, { recursive: true, force: true });
  return removed;
}
