import type { IExecutionContext } from '../../exec/execution-context';
import { isTransportFailure } from '../../exec/transport-error';
import type { Platform } from '../capability';
import { toPlatform } from './install-options';
import type { ProbeResult } from './types';

const WHICH_TIMEOUT_MS = 5_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const REALPATH_TIMEOUT_MS = 5_000;

function targetPlatform(platform?: Platform): Platform {
  return platform ?? toPlatform(process.platform);
}

/**
 * Extracts binary paths for `command` from `which`/`where` stdout that may be
 * polluted by login-shell noise. A remote `bash -lc`/`zsh -lc` sources the
 * profile, which on some hosts echoes an MOTD banner (ASCII art, hostname) to
 * stdout ahead of the command output — and that art can include lines starting
 * with `/`, so an "absolute-path-shaped" filter is not enough. A genuine
 * `which`/`where` result is an absolute path whose basename is the command
 * itself (plus an executable extension on Windows), which banner lines are not.
 * Returns matching lines in output (PATH) order.
 */
function extractCommandPaths(stdout: string, command: string, platform: Platform): string[] {
  // `command` may be a bare name or an absolute path override; match on its
  // basename either way so `which /custom/codex` -> `/custom/codex` resolves.
  const expected = command.split(/[\\/]/).pop() ?? command;
  const lower = expected.toLowerCase();
  const matches =
    platform === 'windows'
      ? (s: string) => {
          if (!/^[A-Za-z]:[\\/]/.test(s) && !s.startsWith('\\\\')) return false;
          const base = (s.split(/[\\/]/).pop() ?? '').toLowerCase();
          return base === lower || base.startsWith(`${lower}.`);
        }
      : (s: string) => s.startsWith('/') && (s.split('/').pop() ?? '') === expected;
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(matches);
}

/**
 * Extracts a resolved path from `realpath` stdout that may carry the same
 * login-shell banner noise. Unlike `which`, the result basename differs from
 * the input (symlinks are followed), so match on shape: an absolute path with
 * no interior whitespace. `realpath` prints its result after any banner, so
 * take the last such line.
 */
function extractRealpath(stdout: string, platform: Platform): string | null {
  const isPathLike =
    platform === 'windows'
      ? (s: string) => /^[A-Za-z]:[\\/]\S*$/.test(s) || /^\\\\\S+$/.test(s)
      : (s: string) => /^\/\S*$/.test(s);
  const paths = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(isPathLike);
  return paths.length > 0 ? paths[paths.length - 1] : null;
}

/**
 * Resolves all absolute paths for a command binary in PATH order.
 * Uses `where` on Windows (which already lists all matches) and `which -a` on
 * macOS/Linux. Returns an empty array when the command is not found.
 * A transport failure (dead connection, channel timeout) propagates — it is
 * not evidence of absence.
 *
 * The first entry is the PATH winner (same result as resolveCommandPath).
 */
export async function resolveAllCommandPaths(
  command: string,
  ctx: IExecutionContext,
  platform?: Platform
): Promise<string[]> {
  const plat = targetPlatform(platform);
  try {
    if (plat === 'windows') {
      const { stdout } = await ctx.exec('where', [command], { timeout: WHICH_TIMEOUT_MS });
      return extractCommandPaths(stdout, command, plat);
    }
    const { stdout } = await ctx.exec('which', ['-a', command], { timeout: WHICH_TIMEOUT_MS });
    return extractCommandPaths(stdout, command, plat);
  } catch (error) {
    if (isTransportFailure(error)) throw error;
    return [];
  }
}

/**
 * Resolves the absolute path of a command binary.
 * Uses `where` on Windows and `which` on macOS/Linux.
 * Returns `null` if the command is not found. A transport failure (dead
 * connection, channel timeout) propagates — it is not evidence of absence.
 */
export async function resolveCommandPath(
  command: string,
  ctx: IExecutionContext,
  platform?: Platform
): Promise<string | null> {
  const plat = targetPlatform(platform);
  const resolveCmd = plat === 'windows' ? 'where' : 'which';
  try {
    const { stdout } = await ctx.exec(resolveCmd, [command], { timeout: WHICH_TIMEOUT_MS });
    return extractCommandPaths(stdout, command, plat)[0] ?? null;
  } catch (error) {
    if (isTransportFailure(error)) throw error;
    return null;
  }
}

/**
 * Resolves the canonical realpath of a binary by following symlinks.
 * Runs `realpath` on Unix or falls back to the given path on failure/Windows.
 * Used to determine the true install location for method inference.
 */
export async function resolveRealpath(
  resolvedPath: string,
  ctx: IExecutionContext,
  platform?: Platform
): Promise<string> {
  const plat = targetPlatform(platform);
  if (plat === 'windows') return resolvedPath;
  try {
    const { stdout } = await ctx.exec('realpath', [resolvedPath], {
      timeout: REALPATH_TIMEOUT_MS,
    });
    const real = extractRealpath(stdout, plat) ?? stdout.trim();
    return real || resolvedPath;
  } catch (error) {
    if (isTransportFailure(error)) throw error;
    return resolvedPath;
  }
}

/**
 * Runs `command args` and collects stdout/stderr up to a timeout.
 * Command failures are captured in the returned `ProbeResult`; a transport
 * failure (dead connection, channel timeout) propagates — the probe never ran,
 * so there is no result to report.
 */
export async function runVersionProbe(
  command: string,
  resolvedPath: string | null,
  args: string[],
  ctx: IExecutionContext,
  timeoutMs: number = VERSION_PROBE_TIMEOUT_MS
): Promise<ProbeResult> {
  const bin = resolvedPath ?? command;
  try {
    const { stdout, stderr } = await ctx.exec(bin, args, { timeout: timeoutMs });
    return { command, path: resolvedPath, stdout, stderr, exitCode: 0, timedOut: false };
  } catch (err: unknown) {
    if (isTransportFailure(err)) throw err;
    const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
    return {
      command,
      path: resolvedPath,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.code ?? null,
      timedOut: !!e.killed,
    };
  }
}
