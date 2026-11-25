import type { Executable } from './types';

/**
 * `npm install -g` or `npm uninstall -g` of `packages`, into `prefix` where
 * npm is not to use its default (`"$HOME/.local"` on Linux, which needs no
 * root). Installing takes the first package; uninstalling takes them all, as
 * npm skips the ones it does not have.
 */
export function buildNpmGlobalCli(
  verb: 'install' | 'uninstall',
  packages: [string, ...string[]],
  prefix: string | null
): string {
  const flag = prefix ? ` --prefix ${prefix}` : '';
  const names = verb === 'install' ? packages[0] : packages.join(' ');
  return `npm ${verb} -g${flag} ${names}`;
}

/** The npm prefix `executable` was installed into, by its path: the person's own `~/.local`, or npm's default. */
export function inferNpmPrefix(executable: Executable): string | null {
  return executable.realpath.includes('/.local/lib/node_modules/') ? '"$HOME/.local"' : null;
}
