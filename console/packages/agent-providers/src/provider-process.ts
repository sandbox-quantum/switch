import {
  type ChildProcess,
  execFile,
  type ExecFileOptions,
  spawn,
  type SpawnOptions,
} from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import {
  resolveExecFileSpawn,
  resolveWindowsCommandPath,
} from '@switch-console/shared/windows-spawn';
import { killProcessTree } from './host/process-fence';

/**
 * Starting a provider's CLI, wherever it was installed from.
 *
 * On Windows a CLI installed with npm is a `.cmd` file, which Node refuses to
 * start without a shell; it goes through `cmd.exe /d /s /c` with its command
 * line quoted by hand instead (`resolveExecFileSpawn`), never `shell: true`.
 * A bare name is looked up on PATH with PATHEXT, as cmd.exe would. Elsewhere,
 * and for a plain `.exe`, nothing changes.
 */
function resolved(command: string, args: readonly string[], env: NodeJS.ProcessEnv | undefined) {
  return resolveExecFileSpawn({
    command,
    args: [...args],
    platform: process.platform,
    env: env ?? process.env,
    fileExists: existsSync,
  });
}

export function spawnProvider(
  command: string,
  args: readonly string[],
  options: SpawnOptions
): ChildProcess {
  const target = resolved(command, args, options.env);
  return spawn(target.command, target.args, {
    ...options,
    windowsHide: true,
    windowsVerbatimArguments: target.windowsVerbatimArguments,
  });
}

export function execProvider(
  command: string,
  args: readonly string[],
  options: ExecFileOptions
): Promise<{ stdout: string; stderr: string }> {
  const target = resolved(command, args, options.env);
  return promisify(execFile)(target.command, target.args, {
    ...options,
    encoding: 'utf8',
    windowsHide: true,
    windowsVerbatimArguments: target.windowsVerbatimArguments,
  }) as Promise<{ stdout: string; stderr: string }>;
}

/**
 * The file `name` runs from, looked up in the directories of `path`: the first
 * executable one, or on Windows the first with an extension from PATHEXT, as
 * cmd.exe finds it (npm's extensionless shell script beside `claude.cmd` is
 * not one Windows can run).
 */
export async function findOnPath(name: string, path: string | undefined): Promise<string | null> {
  if (process.platform === 'win32')
    return resolveWindowsCommandPath({
      command: name,
      env: { PATH: path ?? '', PATHEXT: process.env.PATHEXT },
      fileExists: existsSync,
    });
  for (const directory of (path ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Ends a provider process. On Windows the child may be the `cmd.exe` a
 * `.cmd` CLI runs under, and killing it alone would leave the CLI running,
 * so the whole tree goes; there is no gentler signal to send there.
 */
export function stopProvider(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' || !child.pid) {
    child.kill(signal);
    return;
  }
  const pid = child.pid;
  killProcessTree(pid).catch((error: unknown) => {
    console.error(`Could not stop the provider process (pid ${pid}): ${String(error)}`);
    child.kill(signal);
  });
}
