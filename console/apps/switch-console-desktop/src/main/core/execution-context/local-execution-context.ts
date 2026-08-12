import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolveExecFileSpawn } from '@switch-console/core/exec';
import {
  getGitExecutable,
  isMissingGitExecutableError,
  missingGitExecutableError,
} from '@main/core/utils/exec';
import { NON_INTERACTIVE_GIT_ENV } from './non-interactive-git-env';
import type { ExecOptions, ExecResult, IExecutionContext } from './types';

const execFileAsync = promisify(execFile);

function buildNonInteractiveGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...NON_INTERACTIVE_GIT_ENV,
  };
}

export class LocalExecutionContext implements IExecutionContext {
  readonly root: string;
  readonly supportsLocalSpawn = true;

  private readonly _lifetime = new AbortController();

  constructor(opts: { root?: string } = {}) {
    this.root = opts.root ?? '';
  }

  private _signal(callerSignal?: AbortSignal): AbortSignal {
    const signals: AbortSignal[] = [this._lifetime.signal];
    if (callerSignal) signals.push(callerSignal);
    return AbortSignal.any(signals);
  }

  private resolveCommand(command: string): string {
    return command === 'git' ? getGitExecutable() : command;
  }

  /**
   * Rewrites the argv so a Windows `.cmd`/`.bat` shim — how every npm-global CLI
   * installs there — runs through cmd.exe instead of failing with EINVAL.
   */
  private resolveSpawn(command: string, args: string[]) {
    return resolveExecFileSpawn({
      command: this.resolveCommand(command),
      args,
      platform: process.platform,
      env: process.env,
      fileExists: existsSync,
    });
  }

  exec(command: string, args: string[] = [], opts: ExecOptions = {}): Promise<ExecResult> {
    const { timeout, maxBuffer } = opts;
    const spawnSpec = this.resolveSpawn(command, args);
    return execFileAsync(spawnSpec.command, spawnSpec.args, {
      cwd: this.root || undefined,
      env: command === 'git' ? buildNonInteractiveGitEnv() : undefined,
      timeout,
      maxBuffer,
      signal: this._signal(opts.signal),
      windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
    }).catch((error) => {
      if (command === 'git' && isMissingGitExecutableError(error)) {
        throw missingGitExecutableError();
      }
      throw error;
    }) as Promise<ExecResult>;
  }

  execStreaming(
    command: string,
    args: string[],
    onChunk: (chunk: string) => boolean,
    opts: { signal?: AbortSignal } = {}
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = this._signal(opts.signal);

      if (signal.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }

      const spawnSpec = this.resolveSpawn(command, args);
      const child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: this.root || undefined,
        env: command === 'git' ? buildNonInteractiveGitEnv() : undefined,
        windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
      });

      let settled = false;

      const onAbort = () => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (settled) return;
        if (!onChunk(chunk)) {
          child.kill('SIGTERM');
        }
      });

      child.on('error', (err) => {
        signal.removeEventListener('abort', onAbort);
        if (!settled) {
          settled = true;
          reject(
            command === 'git' && isMissingGitExecutableError(err)
              ? missingGitExecutableError()
              : err
          );
        }
      });

      child.on('close', () => {
        signal.removeEventListener('abort', onAbort);
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  }

  dispose(): void {
    this._lifetime.abort();
  }
}
