import path from 'node:path';

export type FileExists = (candidate: string) => boolean;

/**
 * Windows environment variables are case-insensitive; Node preserves whatever
 * casing the parent process used, so `env.PATH` misses a `Path` inherited from
 * Explorer. Look the key up case-insensitively before reading it.
 */
export function getWindowsEnvKey(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) return key;

  const lowerKey = key.toLowerCase();
  return Object.keys(env).find((candidate) => candidate.toLowerCase() === lowerKey);
}

export function getWindowsEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const envKey = getWindowsEnvKey(env, key);
  return envKey ? env[envKey] : undefined;
}

export function getWindowsShellExecutable(env: NodeJS.ProcessEnv): string {
  return getWindowsEnvValue(env, 'ComSpec') || 'C:\\Windows\\System32\\cmd.exe';
}

export function getWindowsPathDirs(env: NodeJS.ProcessEnv): string[] {
  const rawPath = getWindowsEnvValue(env, 'PATH') ?? '';
  return rawPath.split(path.win32.delimiter).filter(Boolean);
}

export function getWindowsPathExts(
  env: NodeJS.ProcessEnv,
  options: { powershell?: boolean } = {}
): string[] {
  const rawPathExt =
    getWindowsEnvValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';
  const exts = rawPathExt
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));
  if (!options.powershell) return exts;

  const normalized = new Set(exts.map((ext) => ext.toUpperCase()));
  if (!normalized.has('.PS1')) exts.push('.PS1');

  const priority = new Map([
    ['.COM', 0],
    ['.EXE', 1],
    ['.PS1', 2],
    ['.CMD', 3],
    ['.BAT', 4],
  ]);
  return [...exts].sort((a, b) => {
    const aRank = priority.get(a.toUpperCase()) ?? 5;
    const bRank = priority.get(b.toUpperCase()) ?? 5;
    return aRank - bRank;
  });
}

export function quoteForCmdExe(input: string): string {
  if (input.length === 0) return '""';
  if (!/[\s"^&|<>()%!]/.test(input)) return input;
  return `"${input
    .replace(/%/g, '%%')
    .replace(/!/g, '^!')
    .replace(/(["^&|<>()])/g, '^$1')}"`;
}

/**
 * cmd.exe + /S /C has a quirk: if the command string starts with a quote, the
 * outer quotes are taken as part of the executable name (printed back as
 * `'"C:\Program Files\..."' is not recognized`). The documented workaround is
 * to wrap the entire command line in an extra pair of outer quotes so cmd.exe
 * strips one layer and runs the still-quoted path.
 */
export function wrapCmdExeCommandLine(commandLine: string): string {
  return commandLine.startsWith('"') ? `"${commandLine}"` : commandLine;
}

function hasWindowsPathSeparator(command: string): boolean {
  return command.includes('\\') || command.includes('/');
}

/**
 * Resolves a bare command name to a concrete file by walking PATHEXT, the way
 * cmd.exe would. Returns null when the command already carries an extension or
 * no candidate exists.
 *
 * `cwd` is only searched when supplied — cmd.exe searches the current directory
 * first, but an exec call resolving a bare name must not pick up a binary
 * sitting in the user's repository.
 */
export function resolveWindowsCommandPath({
  command,
  cwd,
  env,
  fileExists,
  powershell = false,
}: {
  command: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
  fileExists: FileExists;
  powershell?: boolean;
}): string | null {
  if (path.win32.extname(command)) {
    return null;
  }

  let baseCandidates: string[];
  if (path.win32.isAbsolute(command)) {
    baseCandidates = [command];
  } else if (hasWindowsPathSeparator(command)) {
    baseCandidates = cwd === undefined ? [] : [path.win32.join(cwd, command)];
  } else {
    baseCandidates = [
      ...(cwd === undefined ? [] : [path.win32.join(cwd, command)]),
      ...getWindowsPathDirs(env).map((dir) => path.win32.join(dir, command)),
    ];
  }

  for (const base of baseCandidates) {
    for (const ext of getWindowsPathExts(env, { powershell })) {
      const candidate = `${base}${ext}`;
      if (fileExists(candidate)) return candidate;
    }
  }

  return null;
}

export type ExecFileSpawn = {
  command: string;
  args: string[];
  /**
   * True when `args` is a pre-quoted cmd.exe command line that Node must pass
   * through untouched. Feed straight into the `windowsVerbatimArguments`
   * option of child_process.
   */
  windowsVerbatimArguments: boolean;
};

/**
 * Rewrites an argv pair so `child_process.execFile`/`spawn` can run it without
 * a shell on Windows.
 *
 * npm-global CLIs install as `.cmd`/`.bat` shims, and since Node's
 * CVE-2024-27980 hardening a shell-less spawn of one fails with EINVAL. The
 * shim has to go through cmd.exe — but via an explicit `ComSpec /d /s /c` with
 * a hand-quoted command line, not `shell: true`, which is the argument
 * injection hole that hardening closed.
 *
 * Everything else (including plain `.exe`s and every non-Windows platform) is
 * returned unchanged.
 */
export function resolveExecFileSpawn({
  command,
  args,
  platform,
  env,
  cwd,
  fileExists,
}: {
  command: string;
  args: string[];
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  fileExists: FileExists;
}): ExecFileSpawn {
  if (platform !== 'win32') {
    return { command, args, windowsVerbatimArguments: false };
  }

  const resolved = resolveWindowsCommandPath({ command, cwd, env, fileExists }) ?? command;
  const ext = path.win32.extname(resolved).toLowerCase();

  if (ext !== '.cmd' && ext !== '.bat') {
    return { command: resolved, args, windowsVerbatimArguments: false };
  }

  const commandLine = [resolved, ...args].map(quoteForCmdExe).join(' ');
  return {
    command: getWindowsShellExecutable(env),
    args: ['/d', '/s', '/c', wrapCmdExeCommandLine(commandLine)],
    windowsVerbatimArguments: true,
  };
}
