import { spawn } from 'node:child_process';
import { delimiter } from 'node:path';

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
