import path from 'node:path';
import { getWindowsEnvKey } from '@switch-console/core/exec';

export function getWindowsPathEnvKey(env: NodeJS.ProcessEnv): string {
  return getWindowsEnvKey(env, 'PATH') ?? 'PATH';
}

export function prependWindowsPathEntry(env: NodeJS.ProcessEnv, entry: string): boolean {
  const pathKey = getWindowsPathEnvKey(env);
  const entries = (env[pathKey] ?? '').split(path.win32.delimiter).filter(Boolean);
  const existing = new Set(entries.map((item) => item.toLowerCase()));

  if (existing.has(entry.toLowerCase())) {
    return false;
  }

  env[pathKey] = [entry, ...entries].join(path.win32.delimiter);
  return true;
}
