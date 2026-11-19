/** The install roots Git for Windows uses, from the environment Windows sets. */
export type WindowsGitInstallRoots = {
  localAppData: string | undefined;
  programFiles: string | undefined;
  programFilesX86: string | undefined;
};

const withoutTrailingSlash = (dir: string): string => dir.replace(/[\\/]+$/, '');

/** The Git for Windows root a `bin` or `usr\bin` folder sits in, if it has that shape. */
const gitRootOf = (dir: string): string | undefined => dir.match(/^(.+?)\\(?:usr\\)?bin$/i)?.[1];

/**
 * A Windows PATH value with Git for Windows' `bin` folder, which holds
 * `bash.exe`, added after its entries when no Git Bash is on it yet, and
 * `path` unchanged otherwise.
 *
 * Provider CLIs such as Cursor's run shell commands through Git Bash and fail
 * with "Can't find Bash" without it. Git's default install option puts only
 * `Git\cmd` on PATH, which finds `git` but not `bash`. A `bash.exe` on PATH
 * counts only inside a Git install, a `bin` or `usr\bin` folder whose root
 * holds `cmd\git.exe`: the `bash.exe` in `C:\Windows\System32` and the one in
 * `%LOCALAPPDATA%\Microsoft\WindowsApps` are WSL launchers, not Git Bash. The
 * folder goes last, so a `bash` the person put on PATH still wins.
 */
export function withWindowsGitBashDir(
  path: string,
  roots: WindowsGitInstallRoots,
  fileExists: (file: string) => boolean
): string {
  const entries = path.split(';').filter(Boolean).map(withoutTrailingSlash);
  const hasBash = (dir: string) => fileExists(`${dir}\\bash.exe`);
  const isGitBashDir = (dir: string) => {
    const root = gitRootOf(dir);
    return root !== undefined && hasBash(dir) && fileExists(`${root}\\cmd\\git.exe`);
  };
  if (entries.some(isGitBashDir)) return path;

  const besideGitCmd = entries
    .filter((entry) => /\\cmd$/i.test(entry) && fileExists(`${entry}\\git.exe`))
    .map((entry) => entry.replace(/\\cmd$/i, '\\bin'));
  const installed = [
    roots.localAppData && `${withoutTrailingSlash(roots.localAppData)}\\Programs\\Git\\bin`,
    roots.programFiles && `${withoutTrailingSlash(roots.programFiles)}\\Git\\bin`,
    roots.programFilesX86 && `${withoutTrailingSlash(roots.programFilesX86)}\\Git\\bin`,
  ].filter((dir): dir is string => Boolean(dir));

  const gitBin = [...besideGitCmd, ...installed].find(hasBash);
  if (!gitBin || entries.some((entry) => entry.toLowerCase() === gitBin.toLowerCase())) return path;
  return [...path.split(';').filter(Boolean), gitBin].join(';');
}
