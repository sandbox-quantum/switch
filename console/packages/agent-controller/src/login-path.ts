import { execFile, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const MARKER = '__SWITCH_LOGIN_PATH__';

/**
 * `current` with the user's login-shell PATH entries it lacks added after it.
 *
 * A controller started by launchd (a LaunchAgent) gets `/usr/bin:/bin:/usr/sbin:/sbin`
 * and nothing more, so the provider CLIs, git and gh it looks for, and those
 * its sessions inherit, would be the ones that PATH finds rather than the ones
 * the user's own shell does. What the controller was given comes first, so a
 * PATH set on purpose (a virtualenv, nvm, direnv) still wins, unless it is
 * launchd's bare default, which the shell's goes ahead of. Null when the
 * shell cannot say within `timeoutMs`, for the caller to report.
 *
 * The shell is interactive, as Console's own lookup runs it, so its profile
 * may hang (an ssh-add prompt, a network call) and ignore SIGTERM: it runs in
 * a process group of its own, which is killed outright at the timeout, and
 * nothing it left running is waited for.
 */
export function loginShellPath(
  shell: string,
  current: string,
  timeoutMs = 5_000
): Promise<string | null> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (path: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      resolve(path);
    };
    const child = spawn(shell, ['-ilc', `printf '\\n${MARKER}%s\\n' "$PATH"`], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      // Keep shell frameworks from updating themselves on a background start.
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
    });
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.split('\n').find((candidate) => candidate.startsWith(MARKER));
      // The PATH is all that is wanted: once it is out, what else the
      // profile does is not waited for.
      if (line !== undefined && output.includes('\n', output.indexOf(MARKER)))
        finish(merged(line.slice(MARKER.length).trim(), current));
    });
    child.once('error', () => finish(null));
    child.once('exit', () => {
      const line = output.split('\n').find((candidate) => candidate.startsWith(MARKER));
      finish(line ? merged(line.slice(MARKER.length).trim(), current) : null);
    });
    child.unref();
  });
}

/** The PATH launchd gives a LaunchAgent, which nobody chose: the shell's goes first then. */
const LAUNCHD_DEFAULT = '/usr/bin:/bin:/usr/sbin:/sbin';

function merged(shellPath: string, current: string): string | null {
  if (!shellPath) return null;
  const shellEntries = shellPath.split(delimiter).filter(Boolean);
  const currentEntries = current.split(delimiter).filter(Boolean);
  const [first, then] =
    current === LAUNCHD_DEFAULT || current === ''
      ? [shellEntries, currentEntries]
      : [currentEntries, shellEntries];
  const seen = new Set(first);
  return [...first, ...then.filter((entry) => !seen.has(entry))].join(delimiter);
}

/**
 * `path` with the folders provider installers put CLIs in that it lacks, added
 * after it: `~/.local/bin`, where Claude Code's and OpenCode's installers
 * write, is often missing from a shell profile. Switch Console adds the same
 * folder to its own PATH, so what it installed is found here too.
 */
export function withUserBinDirs(path: string, home: string): string {
  const entries = path.split(delimiter).filter(Boolean);
  const additions = [join(home, '.local', 'bin')].filter(
    (dir) => !entries.includes(dir) && isDirectory(dir)
  );
  return [...entries, ...additions].join(delimiter);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

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
  const parts: string[] = [];
  let readAny = false;
  for (const key of REGISTRY_PATH_KEYS) {
    const output = await query(key);
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
