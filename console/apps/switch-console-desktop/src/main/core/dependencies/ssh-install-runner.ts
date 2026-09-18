import type { InstallCommandError, InstallCommandSpec } from '@switch-console/core/deps/runtime';
import { err, ok, type Result } from '@switch-console/shared';
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

const NO_OUTPUT_TIMEOUT_MS = 5 * 60_000;

export function createSshInstallCommandRunner(
  proxy: SshClientProxy,
  onOutput: (chunk: string) => void
): InstallCommandRunner {
  return async (command) => {
    const commandLine = toRemoteCommandLine(command);
    const profile = await proxy.getRemoteShellProfile();
    const remoteCommand = buildRemoteShellCommand(profile, commandLine);
    return new Promise<Result<void, InstallCommandError>>((resolve) => {
      proxy.exec(remoteCommand, (error, channel) => {
        if (error) {
          resolve(err({ type: 'process-open-failed', message: error.message }));
          return;
        }
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
            channel.signal('TERM');
            channel.close();
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

        const collect = (data: Buffer) => {
          const chunk = data.toString();
          chunks.push(chunk);
          armStallTimer();
          onOutput(chunk);
        };
        channel.on('data', collect);
        channel.stderr.on('data', collect);
        channel.on('error', (error: Error) =>
          settle(err({ type: 'command-failed', message: error.message, output: chunks.join('') }))
        );
        channel.on('close', (exitCode: number | undefined) => {
          if (exitCode === 0) {
            log.info('[SshDependencyManager] Remote install succeeded');
            settle(ok());
            return;
          }
          const output = chunks.join('').trim();
          log.error('[SshDependencyManager] Remote install failed', { exitCode, output });
          settle(err(classifyInstallCommandFailure({ exitCode, output })));
        });
        channel.end();
      });
    });
  };
}
