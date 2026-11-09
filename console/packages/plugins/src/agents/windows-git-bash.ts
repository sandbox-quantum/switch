/** The install roots Git for Windows uses, from the environment Windows sets. */
export type WindowsGitInstallRoots = {
  localAppData: string | undefined;
  programFiles: string | undefined;
  programFilesX86: string | undefined;
};

const withoutTrailingSlash = (dir: string): string => dir.replace(/[\\/]+$/, '');

/**
 * A Windows PATH value with Git for Windows' `bin` folder, which holds
 * `bash.exe`, added after its entries when no `bash.exe` is on it yet, and
 * `path` unchanged otherwise.
 *
 * Provider CLIs such as Cursor's run shell commands through Git Bash and fail
 * with "Can't find Bash" without it. Git's default install option puts only
 * `Git\cmd` on PATH, which finds `git` but not `bash`. The `bash.exe` in
 * `C:\Windows\System32` is the WSL launcher, not Git Bash, so it does not
 * count. The folder goes last, so a `bash` the person put on PATH still wins.
 */
export function withWindowsGitBashDir(
  path: string,
  roots: WindowsGitInstallRoots,
  fileExists: (file: string) => boolean
): string {
  const entries = path.split(';').filter(Boolean).map(withoutTrailingSlash);
  const isGitBashDir = (dir: string) =>
    !/\\windows\\(system32|sysnative|syswow64)$/i.test(dir) && fileExists(`${dir}\\bash.exe`);
  if (entries.some(isGitBashDir)) return path;

  const besideGitCmd = entries
    .filter((entry) => /\\cmd$/i.test(entry) && fileExists(`${entry}\\git.exe`))
    .map((entry) => entry.replace(/\\cmd$/i, '\\bin'));
  const installed = [
    roots.localAppData && `${withoutTrailingSlash(roots.localAppData)}\\Programs\\Git\\bin`,
    roots.programFiles && `${withoutTrailingSlash(roots.programFiles)}\\Git\\bin`,
    roots.programFilesX86 && `${withoutTrailingSlash(roots.programFilesX86)}\\Git\\bin`,
  ].filter((dir): dir is string => Boolean(dir));

  const gitBin = [...besideGitCmd, ...installed].find(isGitBashDir);
  return gitBin ? [...path.split(';').filter(Boolean), gitBin].join(';') : path;
}
