import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Where a path a tool names lies, for an adapter that decides file access
 * itself rather than leaving it to its vendor (Pi).
 *
 * - `workspace`: inside the session's working directory.
 * - `protected`: inside the working directory, but somewhere a change runs
 *   code or widens what the agent may do: a git directory (its hooks and
 *   config run commands), an entry of the home directory whose name starts
 *   with a dot (shell start-up files, keys, and Switch's own state, the
 *   watcher configuration that carries an agent's runtime mode among it), or
 *   Switch's application data. A working directory inside one of those makes
 *   it the workspace again: the agent was put there to work on it.
 * - `outside`: anywhere else, and anything that cannot be resolved.
 *
 * Symbolic links are followed through the deepest part of the path that
 * exists, so a link inside the workspace to a file outside it is outside.
 * `cwd` must already be a real path.
 */
export type PathScope = 'workspace' | 'protected' | 'outside';

export function pathScope(
  path: string,
  scope: { cwd: string; env: Record<string, string> }
): { scope: PathScope; real: string } {
  const { cwd, env } = scope;
  const home = homeOf(env);
  const real = realTarget(resolve(cwd, expandHome(path, home)), 0);
  if (real === null) return { scope: 'outside', real: resolve(cwd, path) };
  if (!isWithin(cwd, real)) return { scope: 'outside', real };
  if (relative(cwd, real).split(sep).includes('.git')) return { scope: 'protected', real };
  for (const root of protectedRoots(real, home, env))
    if (isWithin(root, real) && !isWithin(root, cwd)) return { scope: 'protected', real };
  return { scope: 'workspace', real };
}

/** Whether `target` is `root` or inside it. */
export function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function homeOf(env: Record<string, string>): string | null {
  const home = env.HOME || env.USERPROFILE;
  if (!home) return null;
  return realTarget(home, 0) ?? home;
}

function expandHome(path: string, home: string | null): string {
  if (home === null) return path;
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith(`~${sep}`)) return join(home, path.slice(2));
  return path;
}

/** The home directory's dot entry `real` is in, and Switch's application data folders. */
function protectedRoots(real: string, home: string | null, env: Record<string, string>): string[] {
  const roots: string[] = [];
  if (home !== null && isWithin(home, real) && real !== home) {
    const first = relative(home, real).split(sep)[0]!;
    if (first.startsWith('.')) roots.push(join(home, first));
    const support = join(home, 'Library', 'Application Support');
    roots.push(join(support, 'Switch'), join(support, 'Switchdash'));
  }
  if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'Switch'));
  if (env.APPDATA) roots.push(join(env.APPDATA, 'Switchdash'));
  return roots;
}

/** Links followed through a dangling one before giving up, as the system does at 40. */
const MAX_LINKS = 40;

/**
 * `path` with every symbolic link in its existing part followed, a dangling
 * one included, since writing through it creates its target; null if that
 * fails.
 */
function realTarget(path: string, links: number): string | null {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      const link = danglingLink(current);
      if (link !== null) {
        if (links >= MAX_LINKS) return null;
        const target = realTarget(resolve(dirname(current), link), links + 1);
        return target === null ? null : join(target, ...missing);
      }
      const parent = dirname(current);
      if (parent === current) return null;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function danglingLink(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    return null;
  }
}
