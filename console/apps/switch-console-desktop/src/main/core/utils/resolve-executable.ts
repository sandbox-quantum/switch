import fs from 'node:fs';
import path from 'node:path';
import { getWindowsEnvValue, getWindowsPathExts } from '@switch-console/core/exec';

/**
 * Locates `name` on PATH the way the OS loader would, including the PATHEXT
 * extension walk Windows needs (`git` -> `git.exe`). Returns null when nothing
 * executable matches.
 */
export function findExecutableOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const pathValue = getWindowsEnvValue(env, 'PATH');
  if (!pathValue) return null;

  const extensions =
    process.platform === 'win32' && !path.extname(name) ? ['', ...getWindowsPathExts(env)] : [''];

  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;

    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }

  return null;
}

/**
 * Resolves a tool to an absolute path, in order: an explicit env override, the
 * PATH entry, then the well-known install locations for the platforms we ship
 * on. Falls back to the bare name so the OS loader gets the last word.
 */
export function resolveExecutable(
  name: string,
  options: { overridePath?: string; candidates: string[]; env?: NodeJS.ProcessEnv }
): string {
  const env = options.env ?? process.env;
  const ordered = [
    (options.overridePath ?? '').trim(),
    findExecutableOnPath(name, env) ?? '',
    ...options.candidates,
  ].filter(Boolean);

  for (const candidate of ordered) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }

  return name;
}

/** Expands a Windows install root from the environment, or null when unset. */
export function windowsInstallPath(
  env: NodeJS.ProcessEnv,
  rootVar: string,
  ...segments: string[]
): string | null {
  const root = getWindowsEnvValue(env, rootVar);
  return root ? path.win32.join(root, ...segments) : null;
}
