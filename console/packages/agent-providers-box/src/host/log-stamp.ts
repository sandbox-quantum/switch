import { format } from 'node:util';

/** The console methods a host's own log lines go through. */
const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** `text` with `at` (ISO, UTC) at the start of every line. */
export function stampLines(text: string, at: Date): string {
  const stamp = at.toISOString();
  return text
    .split('\n')
    .map((line) => `${stamp} ${line}`)
    .join('\n');
}

/**
 * Puts the time at the start of every line this process writes through the
 * console, so `worker.log` and `supervisor.log` can be read by time rather
 * than by line order (a kill -9 proof was once argued from line order). Only for the long-running host and supervisor processes: the
 * helpers whose output a caller parses (`--models`, `--probe`, the git and
 * gh helpers) are never stamped. Output a child process writes straight to
 * the same file, and a crash Node itself prints, carry no stamp.
 */
export function stampConsole(target: Console = console, now: () => Date = () => new Date()): void {
  for (const level of LEVELS) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => original(stampLines(format(...args), now()));
  }
}

/** The modes of `shared-daemon` that supervise or run a host and write its logs. */
const STAMPED_MODES = new Set(['--supervise', '--watch-supervise', '--watch-worker']);

/**
 * Whether `shared-daemon` was started as a long-running supervisor or host
 * (a session host is started with no mode), rather than a helper whose output
 * its caller reads: `--models`, `--probe`, `--git-credential`, `--github-cli`,
 * or the short `--ensure` and `--restart` runs.
 */
export function longRunning(
  root: string | undefined,
  configPath: string | undefined,
  mode: string | undefined
): boolean {
  if (!root || !configPath || root.startsWith('--')) return false;
  return mode === undefined || STAMPED_MODES.has(mode);
}
