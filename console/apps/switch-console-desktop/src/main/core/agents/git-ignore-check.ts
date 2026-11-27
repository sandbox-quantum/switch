import { execFile } from 'node:child_process';
import { NON_INTERACTIVE_GIT_ENV } from '@main/core/execution-context/non-interactive-git-env';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { getGitExecutable } from '@main/core/utils/exec';

/**
 * What git says of a path in a working directory: `ignored`; `not-ignored`,
 * which `git add -A` would stage (a tracked file is always this: no
 * `.gitignore` applies to one); or `outside-git` when there is nothing to ask,
 * because the directory is in no repository or git is not installed there.
 */
export type GitIgnoreVerdict = 'ignored' | 'not-ignored' | 'outside-git';

/** Asks git, in a working directory, about a path relative to it. */
export type GitIgnoreCheck = (relPath: string) => Promise<GitIgnoreVerdict>;

const CHECK_TIMEOUT_MS = 15_000;

/** `git check-ignore` exits 1 for a path it does not ignore, and 128 outside a repository. */
const NOT_IGNORED_EXIT = 1;
const NO_REPOSITORY_EXIT = 128;
/** What a POSIX shell exits with for a command it cannot find. */
const COMMAND_NOT_FOUND_EXIT = 127;

/**
 * `-C` rather than a working directory, so a directory not made yet answers
 * "no repository" instead of failing to start. Without `--no-index`, so a
 * tracked file answers "not ignored".
 */
function checkIgnoreArgs(dir: string, relPath: string): string[] {
  return ['-C', dir, 'check-ignore', '-q', '--', relPath];
}

function unexpected(relPath: string, detail: string): Error {
  return new Error(`Could not ask git whether ${relPath} is ignored: ${detail}`);
}

/** Through the git on this computer, for a local working directory. */
export function localGitIgnoreCheck(dir: string): GitIgnoreCheck {
  return (relPath) =>
    new Promise((resolve, reject) => {
      execFile(
        getGitExecutable(),
        checkIgnoreArgs(dir, relPath),
        { env: { ...process.env, ...NON_INTERACTIVE_GIT_ENV }, timeout: CHECK_TIMEOUT_MS },
        (error) => {
          if (!error) return resolve('ignored');
          if (error.code === NOT_IGNORED_EXIT) return resolve('not-ignored');
          if (error.code === NO_REPOSITORY_EXIT || error.code === 'ENOENT')
            return resolve('outside-git');
          reject(unexpected(relPath, error.message));
        }
      );
    });
}

/** Through a remote host's shell, for a working directory there. */
export function remoteGitIgnoreCheck(
  ctx: Pick<IExecutionContext, 'exec'>,
  dir: string
): GitIgnoreCheck {
  return async (relPath) => {
    try {
      await ctx.exec('git', checkIgnoreArgs(dir, relPath), { timeout: CHECK_TIMEOUT_MS });
      return 'ignored';
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === NOT_IGNORED_EXIT) return 'not-ignored';
      if (code === NO_REPOSITORY_EXIT || code === COMMAND_NOT_FOUND_EXIT) return 'outside-git';
      if (typeof code === 'number')
        throw unexpected(relPath, error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
}
