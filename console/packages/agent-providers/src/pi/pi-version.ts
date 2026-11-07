import { tmpdir } from 'node:os';
import { execWithin, OUT_OF_TIME } from './exec-within';
import { piArgs } from './pi-args';
import { PI_AGENT_DIR_ENV, piAgentDir } from './pi-paths';

/** The one Pi release Switch is built and tested against. */
export const PI_VERSION = '1.4.0';

export const PI_PACKAGE = '@earendil-works/pi-coding-agent';

/** What Pi is asked to print its version with: offline, so it reaches no server (`pi-args.ts`). */
export const PI_VERSION_ARGS: readonly string[] = piArgs({ kind: 'version' });

const VERSION_TIMEOUT_MS = 15_000;

/**
 * A Pi other than `PI_VERSION`, or one that would not say which it is. When
 * asking failed, `reason` says how (an error code such as `ENOENT` or
 * `EACCES`, an exit, a signal, or `OUT_OF_TIME`) and so does the message;
 * `cause` is the error itself.
 */
export class PiVersionError extends Error {
  readonly reason: string | null;

  constructor(
    readonly found: string | null,
    failure?: { reason: string; cause?: unknown }
  ) {
    super(
      `Switch runs Pi ${PI_VERSION} only, and this Pi ${found === null ? `did not print its version${failure ? ` (${failure.reason})` : ''}` : `is ${found}`}: install ${PI_PACKAGE}@${PI_VERSION}.`,
      failure?.cause === undefined ? undefined : { cause: failure.cause }
    );
    this.name = 'PiVersionError';
    this.reason = failure?.reason ?? null;
  }
}

/**
 * How asking failed, as `PiVersionError.reason` says it. A process Node itself
 * killed with SIGKILL (`killed`, no error code) was killed for its time:
 * `execWithin` kills only so, by its own timer or by execFile's `timeout`,
 * which runs out at the same moment and, on a busy machine, may be the one
 * seen first (PV-1). That is `OUT_OF_TIME`, as when its own timer is seen
 * first; a SIGKILL from anyone else is not `killed`.
 */
function failureReason(error: unknown): string {
  const failed = (error ?? {}) as { code?: unknown; signal?: unknown; killed?: unknown };
  if (failed.killed === true && failed.signal === 'SIGKILL' && typeof failed.code !== 'string')
    return 'OUT_OF_TIME';
  if (typeof failed.code === 'string' && failed.code) return failed.code;
  if (typeof failed.signal === 'string' && failed.signal) return failed.signal;
  if (typeof failed.code === 'number') return `exit ${failed.code}`;
  return error instanceof Error ? error.name : 'unknown failure';
}

/** The version a Pi printed: its first line, when that is a version number. */
export function parsePiVersion(stdout: string): string | null {
  const line = stdout.trim().split('\n')[0]?.trim() ?? '';
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(line) ? line : null;
}

/**
 * Throws `PiVersionError` unless the Pi at `binaryPath` is exactly
 * `PI_VERSION`. Asked with Switch's profile, offline, and from a directory of
 * no project, so asking reads nothing of the person's.
 *
 * Its time (`timeoutMs`, default 15 s) is a hard limit: when it runs out Pi is
 * killed (SIGKILL) and `PiVersionError` is thrown at once, never waiting for
 * the process to end.
 */
export async function assertPiVersion(
  binaryPath: string,
  options: { env?: Record<string, string>; cwd?: string; timeoutMs?: number } = {}
): Promise<string> {
  const env = options.env ?? {};
  let done: Awaited<ReturnType<typeof execWithin>>;
  try {
    done = await execWithin(binaryPath, PI_VERSION_ARGS, {
      cwd: options.cwd ?? tmpdir(),
      env: { ...env, [PI_AGENT_DIR_ENV]: piAgentDir(env) },
      timeout: options.timeoutMs ?? VERSION_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    throw new PiVersionError(null, { reason: failureReason(error), cause: error });
  }
  if (done === OUT_OF_TIME) throw new PiVersionError(null, { reason: 'OUT_OF_TIME' });
  const { stdout } = done;
  const found = parsePiVersion(stdout);
  if (found !== PI_VERSION) throw new PiVersionError(found);
  return found;
}
