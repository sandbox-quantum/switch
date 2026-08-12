import type { InstallCommandError, InstallCommandSpec } from '@switch-console/core/deps/runtime';
import { err, ok, type Result } from '@switch-console/shared';
import { openSsh2Pty } from '@main/core/pty/ssh2-pty';
import { buildRemoteShellCommand } from '@main/core/ssh/lifecycle/remote-shell-profile';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import { log } from '@main/lib/logger';
import { quoteShellArg } from '@main/utils/shellEscape';
import { classifyInstallCommandFailure, type InstallCommandRunner } from './install-runner';

/** Remote hosts are POSIX-only today, so an argv spec is quoted for `sh`. */
function toRemoteCommandLine(command: InstallCommandSpec): string {
  if (typeof command === 'string') return command;
  return [command.command, ...command.args].map(quoteShellArg).join(' ');
}

/**
 * Runs an install/update command string on a remote host over SSH.
 *
 * Mirrors the local install runner: install commands are full shell lines run
 * through the remote shell in a PTY (many installers want a TTY), with the exit
 * code classified into an InstallCommandError rather than thrown. Uses the same
 * remote shell wrapping as agent session execution so PATH/env match.
 *
 * Output is both accumulated (for the failure transcript) and handed to
 * `onOutput` as it arrives, so a caller can show what the host is doing during
 * an install that takes minutes rather than only once it is over.
 */

/**
 * How long an install may produce no output at all before it is abandoned.
 *
 * Generous, because a slow mirror can legitimately go quiet for a while: this
 * is a backstop against a command that will *never* finish, not a performance
 * budget. The case it exists for is an install stopped on a prompt nobody can
 * answer — which, because it holds the package manager's lock while it waits,
 * silently breaks every later install on that host until someone finds it and
 * kills it. Failing loudly after some minutes is strictly better than a step
 * that spins forever.
 */
const NO_OUTPUT_TIMEOUT_MS = 5 * 60_000;

export function createSshInstallCommandRunner(
  proxy: SshClientProxy,
  onOutput: (chunk: string) => void
): InstallCommandRunner {
  return async (command) => {
    const commandLine = toRemoteCommandLine(command);
    const profile = await proxy.getRemoteShellProfile();
    const remoteCommand = buildRemoteShellCommand(profile, commandLine);
    const installId = `ssh-install:${crypto.randomUUID()}`;

    const opened = await openSsh2Pty(proxy, {
      id: installId,
      command: remoteCommand,
      cols: 80,
      rows: 24,
    });
    if (!opened.success) {
      const error: InstallCommandError = {
        type: 'pty-open-failed',
        message: opened.error.message,
      };
      return err(error);
    }

    const pty = opened.data;
    return new Promise<Result<void, InstallCommandError>>((resolve) => {
      const chunks: string[] = [];
      let settled = false;
      let stallTimer: NodeJS.Timeout;

      const settle = (result: Result<void, InstallCommandError>) => {
        if (settled) return;
        settled = true;
        clearTimeout(stallTimer);
        resolve(result);
      };

      const armStallTimer = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          const output = chunks.join('').trim();
          log.error('[SshDependencyManager] Remote install produced no output; abandoning', {
            command: commandLine,
            output,
          });
          // Kill it rather than leaving it: a stopped install holds the package
          // manager's lock, and orphaning it here would break the next attempt
          // just as thoroughly while telling nobody why.
          pty.kill();
          settle(
            err({
              type: 'command-failed',
              message: `The install stopped responding — nothing was printed for ${NO_OUTPUT_TIMEOUT_MS / 60_000} minutes, so it was cancelled. It may be waiting on a prompt that cannot be answered from here.`,
              output,
            })
          );
        }, NO_OUTPUT_TIMEOUT_MS);
      };

      armStallTimer();

      pty.onData((chunk) => {
        chunks.push(chunk);
        armStallTimer();
        onOutput(chunk);
      });
      pty.onExit(({ exitCode }) => {
        if (exitCode === 0) {
          log.info('[SshDependencyManager] Remote install succeeded');
          settle(ok());
          return;
        }
        const output = chunks.join('').trim();
        log.error('[SshDependencyManager] Remote install failed', { exitCode, output });
        settle(err(classifyInstallCommandFailure({ exitCode, output })));
      });
    });
  };
}
