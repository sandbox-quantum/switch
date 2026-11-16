import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { createInterface } from 'node:readline';
import type { InstallCommandError, InstallCommandSpec } from '@switch-console/core/deps/runtime';
import { resolveExecFileSpawn } from '@switch-console/core/exec';
import { err, ok, type Result } from '@switch-console/shared';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import { ensureUserBinDirsInPath } from '@main/utils/userEnv';
import { classifyInstallCommandFailure } from '../dependencies/install-runner';

/**
 * Runs a command a setup's step takes, in the person's shell, as the install
 * runner does, relaying each line it prints to `onLine`. Stdin is kept open:
 * a sign-in command that waits for its browser round trip reads a closed
 * stdin as being cancelled. `onStart` gets the process, so it can be stopped.
 */
export function runSetupCommand(
  command: InstallCommandSpec,
  shell: ResolvedShellProfile,
  onLine: (line: string) => void,
  onStart: (child: ChildProcess) => void
): Promise<Result<void, InstallCommandError>> {
  return new Promise((resolve) => {
    const windows = process.platform === 'win32';
    const spec = resolveExecFileSpawn({
      command: typeof command === 'string' ? shell.executable : command.command,
      args: typeof command === 'string' ? [...shell.commandArgs, command] : command.args,
      platform: process.platform,
      env: process.env,
      fileExists: existsSync,
    });
    const child = spawn(spec.command, spec.args, {
      cwd: os.homedir(),
      env: process.env,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so stopping it stops what it started.
      detached: !windows,
      windowsHide: true,
    });
    onStart(child);
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => {
        if (line.trim()) onLine(line);
      });
    }
    child.on('error', (error) =>
      resolve(err({ type: 'process-open-failed', message: error.message }))
    );
    child.on('close', (code, signal) => {
      if (code === 0) {
        ensureUserBinDirsInPath();
        resolve(ok());
      } else if (signal) {
        resolve(err({ type: 'command-failed', output, message: 'It was stopped.' }));
      } else {
        resolve(err(classifyInstallCommandFailure({ exitCode: code ?? undefined, output })));
      }
    });
  });
}

/** Stops `child`, with everything it started. */
export function stopSetupCommand(child: ChildProcess): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined)
      process.kill(-child.pid, 'SIGTERM');
    else child.kill();
  } catch {
    // Already gone.
  }
}
