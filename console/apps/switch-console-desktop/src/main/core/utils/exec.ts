import { resolveExecutable, windowsInstallPath } from './resolve-executable';

function gitCandidates(env: NodeJS.ProcessEnv): string[] {
  return [
    '/opt/homebrew/bin/git',
    '/usr/local/bin/git',
    '/usr/bin/git',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    windowsInstallPath(env, 'LOCALAPPDATA', 'Programs', 'Git', 'cmd', 'git.exe'),
  ].filter((candidate): candidate is string => candidate !== null);
}

export function resolveGitBin(env: NodeJS.ProcessEnv = process.env): string {
  return resolveExecutable('git', {
    overridePath: env.GIT_PATH,
    candidates: gitCandidates(env),
    env,
  });
}

/** Initial fallback path for Git before the host dependency probe completes. */
export const GIT_EXECUTABLE = resolveGitBin();

let localGitExecutableOverride: string | null = null;
const remoteGitExecutableOverrides = new Map<string, string>();

export function setGitExecutableOverride(executable: string | null, connectionId?: string): void {
  if (connectionId) {
    if (executable) remoteGitExecutableOverrides.set(connectionId, executable);
    else remoteGitExecutableOverrides.delete(connectionId);
    return;
  }

  localGitExecutableOverride = executable;
}

/** Current Git executable selected by the host dependency system, with startup fallback. */
export function getGitExecutable(connectionId?: string): string {
  if (connectionId) return remoteGitExecutableOverrides.get(connectionId) ?? 'git';
  return localGitExecutableOverride ?? GIT_EXECUTABLE;
}

export function isMissingGitExecutableError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException | undefined;
  return (
    err?.code === 'ENOENT' &&
    (err.path === 'git' || err.path === GIT_EXECUTABLE || err.path === localGitExecutableOverride)
  );
}

export function missingGitExecutableError(): Error {
  return new Error(
    'Git is not installed or Switch Console cannot find it. Install Git, then restart Switch Console.'
  );
}
