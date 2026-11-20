import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import type { InstallCommandError, InstallCommandSpec } from '@switch-console/core/deps/runtime';
import { resolveExecFileSpawn } from '@switch-console/core/exec';
import { err, ok, type Result } from '@switch-console/shared';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import { log } from '@main/lib/logger';
import { ensureUserBinDirsInPath } from '@main/utils/userEnv';
import { runOutsideConsole } from './windows-install-launch';

export type InstallCommandRunner<TData = void, TError = InstallCommandError> = (
  command: InstallCommandSpec
) => Promise<Result<TData, TError>>;

type ShellProfileResolver = () => Promise<ResolvedShellProfile>;

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/**
 * How each shell says a program is not there: Windows PowerShell and
 * PowerShell 7, cmd.exe, and POSIX shells. The POSIX one is case-sensitive,
 * as the shells write it, so `curl: error: Not Found` is not taken for a
 * missing `error`.
 */
const MISSING_COMMAND_RES = [
  /The term '([^']+)' is not recognized as (?:the |a )?name of a cmdlet/gi,
  /'([^']+)' is not recognized as an internal or external command/gi,
  /(?:^|\n)(?:[^\n:]*: )?(?:(?:line )?\d+: )?([^\s:]+): (?:command )?not found/g,
];

/** Words a log puts before a colon that are not programs. */
const NOT_A_PROGRAM = /^(error|warning|fatal|info|debug)$/i;

/**
 * How many lines a missing program's message may sit above the end of the
 * output: PowerShell follows it with its error record (`At line:1`, the
 * command, `CategoryInfo`, `FullyQualifiedErrorId`). One further up came from
 * a step inside the install (a postinstall script's `node-gyp`), which is not
 * what the install as a whole needs, and its real failure follows.
 */
const MISSING_COMMAND_TAIL_LINES = 8;

/**
 * The program a failed install command could not find, as typed (`npm`), or
 * null: the last one a shell said it could not find, when that is how the
 * output ends.
 */
export function missingCommandIn(output: string): string | null {
  const lines = output.split('\n');
  const nonEmpty = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.trim());
  const tailStart =
    nonEmpty.length > MISSING_COMMAND_TAIL_LINES
      ? nonEmpty[nonEmpty.length - MISSING_COMMAND_TAIL_LINES]!.index
      : 0;
  const tailOffset = lines.slice(0, tailStart).reduce((sum, line) => sum + line.length + 1, 0);
  let last: { at: number; name: string } | null = null;
  for (const re of MISSING_COMMAND_RES) {
    for (const match of output.matchAll(re)) {
      const name = match[1];
      if (!name || NOT_A_PROGRAM.test(name)) continue;
      const at = (match.index ?? 0) + match[0].indexOf(name);
      if (at >= tailOffset && (last === null || at > last.at)) last = { at, name };
    }
  }
  if (last === null) return null;
  const base = last.name.split(/[\\/]/).pop() ?? last.name;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

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

  if (/\bENOSPC\b|no space left on device/i.test(cleanOutput)) {
    return {
      type: 'command-failed',
      exitCode,
      output: cleanOutput,
      message: 'There is not enough free disk space. Free some space and try again.',
    };
  }

  const missingCommand = missingCommandIn(cleanOutput);
  if (missingCommand) {
    return {
      type: 'command-failed',
      exitCode,
      output: cleanOutput,
      message: `The install needs ${missingCommand}, which this computer does not have.`,
      missingCommand,
    };
  }

  return {
    type: 'command-failed',
    exitCode,
    output: cleanOutput,
    message: 'Install command failed.',
  };
}

function resolveInstallSpawn(command: InstallCommandSpec, shellProfile: ResolvedShellProfile) {
  return resolveExecFileSpawn({
    command: typeof command === 'string' ? shellProfile.executable : command.command,
    args: typeof command === 'string' ? [...shellProfile.commandArgs, command] : command.args,
    platform: process.platform,
    env: process.env,
    fileExists: existsSync,
  });
}

export async function runLocalInstallCommand(
  command: InstallCommandSpec,
  shellProfile: ResolvedShellProfile
): Promise<Result<void, InstallCommandError>> {
  return new Promise((resolve) => {
    const spec = resolveInstallSpawn(command, shellProfile);
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

/**
 * On Windows, runs the command outside Switch Console's process tree
 * (`windows-install-launch.ts`), where installers that create junctions work;
 * when Windows cannot start it that way, runs it as Console's child, and says so.
 */
async function runWindowsInstallCommand(
  command: InstallCommandSpec,
  shellProfile: ResolvedShellProfile
): Promise<Result<void, InstallCommandError>> {
  const spec = resolveInstallSpawn(command, shellProfile);
  const launch = await runOutsideConsole({
    executable: spec.command,
    args: spec.args,
    verbatim: spec.windowsVerbatimArguments,
    cwd: os.homedir(),
  });
  switch (launch.kind) {
    case 'not-launched':
      log.warn(
        '[InstallRunner] Could not start the install outside Switch Console; running it directly, where installers that create junctions can fail',
        { reason: launch.reason }
      );
      return runLocalInstallCommand(command, shellProfile);
    case 'start-failed':
      return err({ type: 'process-open-failed', message: launch.message });
    case 'ran':
      if (launch.exitCode === 0) {
        ensureUserBinDirsInPath();
        return ok();
      }
      return err(
        classifyInstallCommandFailure({ exitCode: launch.exitCode, output: launch.output })
      );
  }
}

export function createLocalInstallCommandRunner(
  resolveShellProfile: ShellProfileResolver
): InstallCommandRunner {
  return async (command) => {
    const shellProfile = await resolveShellProfile();
    return process.platform === 'win32'
      ? runWindowsInstallCommand(command, shellProfile)
      : runLocalInstallCommand(command, shellProfile);
  };
}
