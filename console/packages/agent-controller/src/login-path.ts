import { spawnSync } from 'node:child_process';
import { delimiter } from 'node:path';

const MARKER = '__SWITCH_LOGIN_PATH__';

/**
 * The user's login-shell PATH, with any entry only `current` has after it.
 *
 * A controller started by launchd (a LaunchAgent) gets `/usr/bin:/bin:/usr/sbin:/sbin`
 * and nothing more, so the provider CLIs, git and gh it looks for, and those
 * its sessions inherit, would be the ones that PATH finds rather than the ones
 * the user's own shell does. Console resolves its own PATH the same way before
 * it starts the embedded controller. Null when the shell cannot say, for the
 * caller to report.
 */
export function loginShellPath(
  shell: string,
  current: string,
  run: typeof spawnSync = spawnSync
): string | null {
  const result = run(shell, ['-ilc', `printf '\\n${MARKER}%s\\n' "$PATH"`], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Keep shell frameworks from updating themselves on a background start.
    env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
  });
  if (result.error || result.status !== 0) return null;
  const line = String(result.stdout)
    .split('\n')
    .find((candidate) => candidate.startsWith(MARKER));
  const shellPath = line?.slice(MARKER.length).trim();
  if (!shellPath) return null;
  const shellEntries = shellPath.split(delimiter).filter(Boolean);
  const seen = new Set(shellEntries);
  const extra = current.split(delimiter).filter((entry) => entry && !seen.has(entry));
  return [...shellEntries, ...extra].join(delimiter);
}
