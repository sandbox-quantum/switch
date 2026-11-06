/** Where Git for Windows may be installed, from the environment variables Windows sets. */
export interface WindowsGitLocations {
  programFiles?: string | undefined;
  programW6432?: string | undefined;
  programFilesX86?: string | undefined;
  localAppData?: string | undefined;
}

const trimSlashes = (dir: string): string => dir.replace(/[\\/]+$/, '');

/** Windows' own `bash.exe` is the WSL launcher, not a shell a provider CLI can run commands in. */
const isWindowsSystemDir = (dir: string): boolean =>
  /\\windows\\(system32|sysnative|syswow64)$/i.test(trimSlashes(dir));

/**
 * A Windows PATH value with the folder of Git for Windows that holds
 * `bash.exe` (`...\Git\bin`) added after its entries, when no `bash.exe` is
 * reachable already, and `path` unchanged otherwise.
 *
 * Provider CLIs such as Cursor's run an agent's shell commands through Git
 * Bash and stop with "Can't find Bash" when it is not on PATH. Git's
 * installer puts only `...\Git\cmd` on PATH when a person chooses the
 * default "Git from the command line" option, which finds `git` but not
 * `bash`. A per-user install (`%LOCALAPPDATA%\Programs\Git`) is the common
 * case on a managed machine.
 *
 * The folder next to a `git` that is already on PATH is tried first, then the
 * usual install locations. It goes last, as a terminal opened since would
 * have it, so a `bash` the person put on PATH still wins. The WSL launcher in
 * `System32` does not count as one.
 *
 * `isFile` says whether a path is a file, so the caller supplies the file system.
 */
export function withWindowsGitBashDir(
  path: string,
  locations: WindowsGitLocations,
  isFile: (file: string) => boolean
): string {
  const entries = path.split(';').filter(Boolean);
  const hasBash = (dir: string): boolean =>
    !isWindowsSystemDir(dir) && isFile(`${trimSlashes(dir)}\\bash.exe`);
  if (entries.some(hasBash)) return path;

  const besideGit = entries
    .filter(
      (entry) => /\\cmd$/i.test(trimSlashes(entry)) && isFile(`${trimSlashes(entry)}\\git.exe`)
    )
    .map((entry) => `${trimSlashes(entry).replace(/\\cmd$/i, '')}\\bin`);
  const installRoots = [
    locations.localAppData && `${trimSlashes(locations.localAppData)}\\Programs\\Git`,
    locations.programW6432 && `${trimSlashes(locations.programW6432)}\\Git`,
    locations.programFiles && `${trimSlashes(locations.programFiles)}\\Git`,
    locations.programFilesX86 && `${trimSlashes(locations.programFilesX86)}\\Git`,
  ].filter((root): root is string => Boolean(root));
  const candidates = [...besideGit, ...installRoots.map((root) => `${root}\\bin`)];

  const gitBin = candidates.find((dir) => isFile(`${dir}\\bash.exe`));
  if (!gitBin) return path;
  return [...entries, gitBin].join(';');
}
