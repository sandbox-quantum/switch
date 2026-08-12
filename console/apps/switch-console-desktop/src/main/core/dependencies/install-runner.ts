import os from 'node:os';
import type { InstallCommandError, InstallCommandSpec } from '@switch-console/core/deps/runtime';
import { err, ok, type Result } from '@switch-console/shared';
import { spawnLocalPty } from '@main/core/pty/local-pty';
import type { Pty } from '@main/core/pty/pty';
import {
  logLocalPtySpawnWarnings,
  resolveLocalPtySpawn,
  type PtyCommandSpec,
} from '@main/core/pty/pty-spawn-platform';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import { log } from '@main/lib/logger';
import { ensureUserBinDirsInPath } from '@main/utils/userEnv';

export type InstallCommandRunner<TData = void, TError = InstallCommandError> = (
  command: InstallCommandSpec
) => Promise<Result<TData, TError>>;

/**
 * An argv spec stays argv all the way into the PTY layer, which quotes it for
 * the target shell. Only a descriptor's own shell line is passed through as one.
 */
function toPtyCommand(command: InstallCommandSpec): PtyCommandSpec {
  return typeof command === 'string'
    ? { kind: 'shell-line', commandLine: command }
    : { kind: 'argv', command: command.command, args: command.args };
}

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

function waitForInstallPty(pty: Pty): Promise<Result<void, InstallCommandError>> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    pty.onData((chunk: string) => chunks.push(chunk));
    pty.onExit(({ exitCode }) => {
      if (exitCode === 0) {
        log.info(`[DependencyManager] Install succeeded`);
        resolve(ok());
        return;
      }

      const output = chunks.join('').trim();
      log.error(`[DependencyManager] Install failed`, { exitCode, output });
      resolve(err(classifyInstallCommandFailure({ exitCode, output })));
    });
  });
}

export async function runLocalInstallCommand(
  command: InstallCommandSpec,
  shellProfile: ResolvedShellProfile
): Promise<Result<void, InstallCommandError>> {
  const installId = `install:${crypto.randomUUID()}`;
  const resolved = resolveLocalPtySpawn({
    platform: process.platform,
    env: process.env,
    intent: {
      kind: 'run-command',
      cwd: os.homedir(),
      command: toPtyCommand(command),
      shellProfile,
    },
  });
  logLocalPtySpawnWarnings('DependencyManager', resolved.warnings, { installId });

  let pty: Pty;
  try {
    pty = spawnLocalPty({
      id: installId,
      command: resolved.command,
      args: resolved.args,
      cwd: resolved.cwd,
      env: process.env as Record<string, string>,
      cols: 80,
      rows: 24,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.resolve(err({ type: 'pty-open-failed', message }));
  }

  return waitForInstallPty(pty).then((result) => {
    if (result.success) {
      ensureUserBinDirsInPath();
    }
    return result;
  });
}

export function createLocalInstallCommandRunner(
  resolveShellProfile: ShellProfileResolver
): InstallCommandRunner {
  return async (command) => {
    const shellProfile = await resolveShellProfile();
    return await runLocalInstallCommand(command, shellProfile);
  };
}
