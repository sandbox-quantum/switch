import { execFile } from 'node:child_process';
import { join } from 'node:path';

/**
 * The value of `Path` in `reg query` output, or null when it has none.
 */
export function parseRegQueryPath(output: string): string | null {
  const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im.exec(output);
  return match ? match[1] : null;
}

/** `value` with each `%NAME%` replaced by that variable, matched as Windows
 * does without regard to case; an unknown name is left as it is. */
export function expandWindowsEnvVars(value: string, env: NodeJS.ProcessEnv): string {
  const lookup = new Map(Object.entries(env).map(([key, val]) => [key.toLowerCase(), val]));
  return value.replace(
    /%([^%]+)%/g,
    (whole, name: string) => lookup.get(name.toLowerCase()) ?? whole
  );
}

export type RegQuery = (key: string) => Promise<string | null>;

const REGISTRY_PATH_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
];

function regQuery(env: NodeJS.ProcessEnv): RegQuery {
  const reg = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  return (key) =>
    new Promise((resolve) => {
      execFile(
        reg,
        ['query', key, '/v', 'Path'],
        { windowsHide: true, timeout: 5_000 },
        (error, stdout) => resolve(error ? null : stdout)
      );
    });
}

/**
 * The PATH a process started now would get on Windows: the machine's, then
 * the user's, as stored in the registry with their variables expanded.
 *
 * An installer (Claude Code's, winget's, Node's) adds its folder there and to
 * nothing already running, so a controller started before the install keeps
 * not finding the CLI until it is restarted. Null when neither key can be
 * read, for the caller to report.
 */
export async function windowsRegistryPath(
  env: NodeJS.ProcessEnv,
  query: RegQuery = regQuery(env)
): Promise<string | null> {
  const outputs = await Promise.all(REGISTRY_PATH_KEYS.map(query));
  const parts: string[] = [];
  let readAny = false;
  for (const output of outputs) {
    if (output === null) continue;
    readAny = true;
    const value = parseRegQueryPath(output);
    if (value) parts.push(expandWindowsEnvVars(value, env));
  }
  return readAny ? parts.join(';') : null;
}

/** `current` with the entries of `extra` it lacks added after it, compared as
 * Windows compares folders: without regard to case or a trailing slash. */
export function withWindowsPathEntries(current: string, extra: string): string {
  const key = (entry: string) => entry.replace(/[\\/]+$/, '').toLowerCase();
  const entries = current.split(';').filter(Boolean);
  const seen = new Set(entries.map(key));
  for (const entry of extra.split(';').filter(Boolean)) {
    if (seen.has(key(entry))) continue;
    seen.add(key(entry));
    entries.push(entry);
  }
  return entries.join(';');
}
