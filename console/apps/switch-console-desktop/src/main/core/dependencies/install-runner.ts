import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import type { InstallCommandError, InstallCommandSpec } from '@switch-console/core/deps/runtime';
import { resolveExecFileSpawn } from '@switch-console/core/exec';
import { err, ok, type Result } from '@switch-console/shared';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import { ensureUserBinDirsInPath } from '@main/utils/userEnv';

export type InstallCommandRunner<TData = void, TError = InstallCommandError> = (
  command: InstallCommandSpec
) => Promise<Result<TData, TError>>;

type ShellProfileResolver = () => Promise<ResolvedShellProfile>;

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function classifyInstallCommandFailure({
  exitCode,
  output,
}: {
  exitCode: number | undefined;
  output: string;
}): InstallCommandError {
  const cleanOutput = output.replace(ANSI_RE, '').trim();
  if (/\bEACCES\b|permission denied|not have the permissions/i.test(cleanOutput)) {
    return {
      type: 'permission-denied',
      exitCode,
      output: cleanOutput,
      message: 'User does not have sufficient permissions.',
    };
  }

  return {
    type: 'command-failed',
    exitCode,
    output: cleanOutput,
    message: 'Install command failed.',
  };
}

export async function runLocalInstallCommand(
  command: InstallCommandSpec,
  shellProfile: ResolvedShellProfile
): Promise<Result<void, InstallCommandError>> {
  return new Promise((resolve) => {
    const spec = resolveExecFileSpawn({
      command: typeof command === 'string' ? shellProfile.executable : command.command,
      args: typeof command === 'string' ? [...shellProfile.commandArgs, command] : command.args,
      platform: process.platform,
      env: process.env,
      fileExists: existsSync,
    });
    const child = spawn(spec.command, spec.args, {
      cwd: os.homedir(),
      env: process.env,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) =>
      resolve(err({ type: 'process-open-failed', message: error.message }))
    );
    child.on('close', (code) => {
      if (code === 0) {
        ensureUserBinDirsInPath();
        resolve(ok());
      } else {
        resolve(err(classifyInstallCommandFailure({ exitCode: code ?? undefined, output })));
      }
    });
  });
}

export function createLocalInstallCommandRunner(
  resolveShellProfile: ShellProfileResolver
): InstallCommandRunner {
  return async (command) => runLocalInstallCommand(command, await resolveShellProfile());
}
