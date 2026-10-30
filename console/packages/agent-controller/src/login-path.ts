import { execFile, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, join, win32 } from 'node:path';
import type { Logger } from './log';

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
 * write, is often missing from a shell profile, and on Windows is only on the
 * PATH of processes started after the installer ran. Switch Console adds the
 * same folder to its own PATH, so what it installed is found here too.
 */
export function withUserBinDirs(path: string, home: string, platform: NodeJS.Platform): string {
  const sep = platform === 'win32' ? win32.delimiter : delimiter;
  const dir = join(home, '.local', 'bin');
  const entries = path.split(sep).filter(Boolean);
  const present = platform === 'win32' ? sameWindowsEntry : (a: string, b: string) => a === b;
  if (entries.some((entry) => present(entry, dir)) || !isDirectory(dir)) return entries.join(sep);
  return [...entries, dir].join(sep);
}

function sameWindowsEntry(a: string, b: string): boolean {
  const norm = (entry: string) => entry.replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

const WINDOWS_PATH_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
];

/**
 * The PATH Windows gives a process started now: the machine's then the
 * user's, as installers write them to the registry, with `%VAR%` expanded
 * from `env`. A process keeps the PATH it was started with, so a CLI whose
 * installer added its folder since is otherwise not found until a restart.
 * Null when neither could be read.
 */
export async function windowsRegistryPath(
  env: NodeJS.ProcessEnv,
  query: (key: string) => Promise<string> = regQueryPath
): Promise<string | null> {
  const values = await Promise.all(
    WINDOWS_PATH_KEYS.map((key) =>
      query(key).then(
        (stdout) => parseRegPath(stdout),
        () => null
      )
    )
  );
  if (values.every((value) => value === null)) return null;
  return values
    .filter((value): value is string => value !== null)
    .map((value) => expandWindowsVars(value, env))
    .join(win32.delimiter);
}

function regQueryPath(key: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'reg',
      ['query', key, '/v', 'Path'],
      { timeout: 5_000, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });
}

/** The `Path` value in `reg query <key> /v Path` output, or null when it has none. */
export function parseRegPath(stdout: string): string | null {
  const match = stdout.match(/^\s+Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im);
  return match ? match[1]! : null;
}

function expandWindowsVars(value: string, env: NodeJS.ProcessEnv): string {
  const lookup = new Map(Object.entries(env).map(([key, val]) => [key.toUpperCase(), val]));
  return value.replace(
    /%([^%]+)%/g,
    (whole, name: string) => lookup.get(name.toUpperCase()) ?? whole
  );
}

/** `current` with the entries of `registry` it lacks added after it, compared as Windows does. */
export function mergeWindowsPath(registry: string, current: string): string {
  const entries = current.split(win32.delimiter).filter(Boolean);
  for (const entry of registry.split(win32.delimiter).filter(Boolean))
    if (!entries.some((existing) => sameWindowsEntry(existing, entry))) entries.push(entry);
  return entries.join(win32.delimiter);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Puts the login shell's PATH (on Windows, the registry's), and the user's own
 * bin folders, on `env`: a controller started by a service or an app has
 * neither, and would not find the provider CLIs a person installed.
 */
export function pathRefresher(deps: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  log: Pick<Logger, 'warn'>;
  windowsPath: (env: NodeJS.ProcessEnv) => Promise<string | null>;
}): () => Promise<void> {
  const { env, log, platform } = deps;
  return async () => {
    const current = env.PATH ?? '';
    if (platform === 'win32') {
      const registry = await deps.windowsPath(env);
      if (registry === null)
        log.warn(
          "Could not read PATH from the Windows registry; provider CLIs, git and gh are looked for on this process's own",
          { path: current }
        );
      const path = registry === null ? current : mergeWindowsPath(registry, current);
      env.PATH = withUserBinDirs(path, deps.home, platform);
      return;
    }
    const shell = env.SHELL ?? (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const path = await loginShellPath(shell, current);
    if (path === null)
      log.warn(
        "Could not read the login shell's PATH; provider CLIs, git and gh are looked for on this process's own",
        { shell, path: current }
      );
    env.PATH = withUserBinDirs(path ?? current, deps.home, platform);
  };
}
