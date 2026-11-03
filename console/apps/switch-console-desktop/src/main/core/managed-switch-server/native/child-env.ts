import path from 'node:path';

/**
 * Environments for the processes the local server spawns.
 *
 * Windows variable names are case-insensitive, but a copy of `process.env`
 * (`{ ...process.env }`) is a plain object whose keys are not: on a desktop
 * the search path is `Path`, so setting `env.PATH` on the copy adds a second
 * variable instead of changing the first, and reading `env.PATH` finds
 * nothing. Node hands both to the child, which then sees two search paths, one
 * of them holding only what was prepended (CHOO-4041). Every write here
 * matches an existing name case-insensitively on Windows and keeps its
 * spelling, so the child gets one of each.
 */

type Platform = NodeJS.Platform;

function existingKey(env: NodeJS.ProcessEnv, name: string, platform: Platform): string {
  if (platform !== 'win32') return name;
  const folded = name.toUpperCase();
  return Object.keys(env).find((key) => key.toUpperCase() === folded) ?? name;
}

/** Read `name`, case-insensitively on Windows. */
export function getEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: Platform = process.platform
): string | undefined {
  return env[existingKey(env, name, platform)];
}

/** Set `name`, or unset it with `undefined`, case-insensitively on Windows. */
export function setEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  value: string | undefined,
  platform: Platform = process.platform
): void {
  if (platform === 'win32') {
    const folded = name.toUpperCase();
    const matches = Object.keys(env).filter((key) => key.toUpperCase() === folded);
    for (const key of matches.slice(1)) delete env[key];
    name = matches[0] ?? name;
  }
  if (value === undefined) delete env[name];
  else env[name] = value;
}

/**
 * `base` with `overrides` applied (`undefined` unsets). On Windows, names that
 * differ only by case collapse into one, the first spelling kept.
 */
export function childEnv(
  base: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
  platform: Platform = process.platform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (platform === 'win32' && getEnv(env, key, platform) !== undefined) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) setEnv(env, key, value, platform);
  return env;
}

/** Put `dir` first on the search path, whatever the variable is called. */
export function prependPath(
  env: NodeJS.ProcessEnv,
  dir: string,
  platform: Platform = process.platform
): void {
  const delimiter = platform === 'win32' ? path.win32.delimiter : path.posix.delimiter;
  const current = getEnv(env, 'PATH', platform);
  setEnv(env, 'PATH', current ? `${dir}${delimiter}${current}` : dir, platform);
}
