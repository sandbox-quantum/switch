import { TransportError } from '@switch-console/core/exec';
import {
  buildRemoteShellCommand,
  FALLBACK_REMOTE_SHELL_PROFILE,
  type RemoteShellProfile,
} from '@main/core/ssh/lifecycle/remote-shell-profile';
import {
  isSshChannelOpenFailure,
  isSshChannelTimeout,
} from '@main/core/ssh/lifecycle/ssh-channel-open-failure';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import { quoteShellArg } from '@main/utils/shellEscape';
import { NON_INTERACTIVE_GIT_ENV } from './non-interactive-git-env';
import type { ExecOptions, ExecResult, IExecutionContext } from './types';

/**
 * Wrap a failure from the SSH layer that means "the pipe is broken", so
 * probe-style callers can distinguish it from "the command ran and failed".
 * Channel-open refusals/timeouts and a missing client all qualify; command
 * exit codes never do.
 */
function toTransportError(error: unknown): TransportError {
  const message = error instanceof Error ? error.message : String(error);
  return new TransportError(`SSH transport failure: ${message}`, { cause: error });
}

function isTransportShaped(error: unknown): boolean {
  if (isSshChannelOpenFailure(error) || isSshChannelTimeout(error)) return true;
  return error instanceof Error && error.message.includes('SSH connection is not available');
}

function withNonInteractiveGitEnv(command: string): string {
  if (command !== 'git') return command;
  const envPrefix = Object.entries(NON_INTERACTIVE_GIT_ENV)
    .map(([key, value]) => `${key}=${quoteShellArg(value)}`)
    .join(' ');
  return `${envPrefix} ${command}`;
}

/**
 * Sentinel emitted on stdout immediately after the login shell has sourced its
 * profile but before the real command runs. Login shells (`-lc`) source the
 * host's profile, which on hardened/branded hosts prints an MOTD banner to
 * stdout; that banner would otherwise be indistinguishable from command output.
 * {@link SshExecutionContext.exec} discards everything up to and including this
 * marker so callers see only the command's own output.
 */
export const EXEC_STDOUT_MARKER = '__SWITCHDASH_EXEC_STDOUT_BEGIN_7b19f4__';

/** Drop the login-shell banner: everything up to and including the marker line. */
export function stripExecBanner(stdout: string, marker: string): string {
  const idx = stdout.indexOf(marker);
  if (idx === -1) return stdout;
  const newline = stdout.indexOf('\n', idx);
  return newline === -1 ? '' : stdout.slice(newline + 1);
}

/**
 * Builds the full shell command string to send over SSH.
 * When `root` is provided the command runs inside `cd root &&`.
 * Args are shell-escaped for safe remote execution.
 *
 * When `marker` is set, a `printf` of the marker is prepended to the command
 * body (after any `cd`, so a missing dir still rejects) so the caller can strip
 * the login-shell banner from stdout via {@link stripExecBanner}.
 */
export function buildSshCommand(
  root: string | undefined,
  command: string,
  args: string[],
  profile?: RemoteShellProfile,
  marker?: string
): string {
  const escaped = args.map(quoteShellArg).join(' ');
  const executable = withNonInteractiveGitEnv(command);
  const inner = args.length ? `${executable} ${escaped}` : executable;
  const prefixed = marker ? `printf '%s\\n' ${quoteShellArg(marker)}; ${inner}` : inner;
  const body = root ? `cd ${quoteShellArg(root)} && ${prefixed}` : prefixed;
  return buildRemoteShellCommand(profile ?? FALLBACK_REMOTE_SHELL_PROFILE, body);
}

export class SshExecutionContext implements IExecutionContext {
  readonly root?: string;
  readonly supportsLocalSpawn = false;

  private readonly _lifetime = new AbortController();

  constructor(
    private readonly proxy: SshClientProxy,
    opts: { root?: string } = {}
  ) {
    this.root = opts.root;
  }

  async exec(command: string, args: string[] = [], opts: ExecOptions = {}): Promise<ExecResult> {
    const { signal, timeout } = opts;
    const profile = await this.proxy.getRemoteShellProfile().catch((err: unknown) => {
      throw isTransportShaped(err) ? toTransportError(err) : err;
    });
    const full = buildSshCommand(this.root, command, args, profile, EXEC_STDOUT_MARKER);
    const combined = this._signal(signal);

    return new Promise((resolve, reject) => {
      if (combined.aborted) {
        reject(combined.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }

      this.proxy.exec(full, (execErr, stream) => {
        if (execErr) {
          return reject(isTransportShaped(execErr) ? toTransportError(execErr) : execErr);
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          combined.removeEventListener('abort', onAbort);
          fn();
        };

        const onAbort = () => {
          settle(() => {
            stream.destroy();
            reject(combined.reason ?? new DOMException('Aborted', 'AbortError'));
          });
        };
        combined.addEventListener('abort', onAbort, { once: true });

        if (timeout !== undefined && timeout > 0) {
          timer = setTimeout(() => {
            settle(() => {
              stream.destroy();
              // Shaped like a child_process timeout (killed=true, partial
              // output attached) so probe-style callers treat it as a slow
              // command, not a broken transport.
              reject(
                Object.assign(new Error(`Command timed out after ${timeout}ms: ${command}`), {
                  killed: true,
                  stdout: stripExecBanner(stdout, EXEC_STDOUT_MARKER),
                  stderr,
                })
              );
            });
          }, timeout);
        }

        stream.on('data', (d: Buffer) => {
          stdout += d.toString('utf-8');
        });
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf-8');
        });

        stream.on('close', (code: number | null) => {
          settle(() => {
            const cleanStdout = stripExecBanner(stdout, EXEC_STDOUT_MARKER);
            if ((code ?? 0) === 0) {
              resolve({ stdout: cleanStdout, stderr });
            } else {
              reject(
                Object.assign(new Error(stderr || `Process exited with code ${code}`), {
                  stdout: cleanStdout,
                  stderr,
                  code: code ?? undefined,
                })
              );
            }
          });
        });

        stream.on('error', (err: Error) => {
          settle(() => {
            reject(isTransportShaped(err) ? toTransportError(err) : err);
          });
        });
      });
    });
  }

  async refreshShellEnv(): Promise<void> {
    await this.proxy.refreshRemoteShellProfile();
  }

  async execStreaming(
    command: string,
    args: string[],
    onChunk: (chunk: string) => boolean,
    opts: { signal?: AbortSignal } = {}
  ): Promise<void> {
    const { signal } = opts;
    const profile = await this.proxy.getRemoteShellProfile().catch((err: unknown) => {
      throw isTransportShaped(err) ? toTransportError(err) : err;
    });
    const full = buildSshCommand(this.root, command, args, profile);
    const combined = this._signal(signal);

    return new Promise((resolve, reject) => {
      if (combined.aborted) {
        reject(combined.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }

      this.proxy.exec(full, (execErr, stream) => {
        if (execErr) {
          return reject(isTransportShaped(execErr) ? toTransportError(execErr) : execErr);
        }

        let settled = false;

        const onAbort = () => {
          if (settled) return;
          settled = true;
          stream.destroy();
          reject(combined.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        combined.addEventListener('abort', onAbort, { once: true });

        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          if (settled) return;
          if (!onChunk(chunk)) {
            stream.destroy();
          }
        });

        stream.on('close', () => {
          combined.removeEventListener('abort', onAbort);
          if (!settled) {
            settled = true;
            resolve();
          }
        });

        stream.on('error', (err: Error) => {
          combined.removeEventListener('abort', onAbort);
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
      });
    });
  }

  dispose(): void {
    this._lifetime.abort();
  }

  private _signal(callerSignal?: AbortSignal): AbortSignal {
    const signals: AbortSignal[] = [this._lifetime.signal];
    if (callerSignal) signals.push(callerSignal);
    return AbortSignal.any(signals);
  }
}
