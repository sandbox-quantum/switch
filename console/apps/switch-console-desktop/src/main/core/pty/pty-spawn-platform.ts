import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  getWindowsShellExecutable,
  quoteForCmdExe,
  resolveWindowsCommandPath,
  wrapCmdExeCommandLine,
  type FileExists,
} from '@switch-console/core/exec';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import { log } from '@main/lib/logger';
import { quoteCshArg } from '@main/utils/shellEscape';
import { buildTmuxShellLine } from './tmux-session-name';

export type PtyCommandSpec =
  | { kind: 'argv'; command: string; args: string[] }
  | { kind: 'shell-line'; commandLine: string };

/**
 * Environment for the tmux pane, set with `new-session -e`.
 *
 * Only meaningful alongside `tmuxSessionName`. A pane inherits the tmux
 * SERVER's environment rather than that of the shell running `new-session`,
 * so anything handed to the pty — hook credentials, registry config, the
 * Switch connection id — stops at that boundary unless it is repeated here.
 * Without it a tmux session sees a materially different environment from an
 * otherwise identical non-tmux one.
 */
type PaneEnv = { paneEnv?: Record<string, string> };

export type PtySpawnIntent =
  | ({
      kind: 'interactive-shell';
      cwd: string;
      shellProfile?: ResolvedShellProfile;
      shellSetup?: string;
      tmuxSessionName?: string;
    } & PaneEnv)
  | ({
      kind: 'run-command';
      cwd: string;
      command: PtyCommandSpec;
      shellProfile?: ResolvedShellProfile;
      shellSetup?: string;
      tmuxSessionName?: string;
    } & PaneEnv);

export type LocalPtySpawnWarning = 'shell_setup_ignored_on_windows' | 'tmux_unsupported_on_windows';

export type ResolvedLocalPtySpawn = {
  command: string;
  args: string[];
  cwd: string;
  warnings: LocalPtySpawnWarning[];
};

function getPosixShell(env: NodeJS.ProcessEnv): string {
  return env.SHELL || '/bin/sh';
}

function getResolvedShell(intent: PtySpawnIntent, env: NodeJS.ProcessEnv): string {
  return intent.shellProfile?.executable ?? getPosixShell(env);
}

function getInteractiveArgs(intent: PtySpawnIntent): string[] {
  return intent.shellProfile?.interactiveArgs ?? ['-il'];
}

function getCommandArgs(intent: PtySpawnIntent): string[] {
  return intent.shellProfile?.commandArgs ?? ['-c'];
}

function getSetupWrapperArgs(intent: PtySpawnIntent): string[] {
  if (!intent.shellProfile) return ['-c'];
  switch (intent.shellProfile.family) {
    case 'posix':
    case 'csh':
      return ['-c'];
    case 'windows-cmd':
    case 'powershell':
    case 'wsl':
      return intent.shellProfile.commandArgs;
  }
}

function shellArgQuoter(intent: PtySpawnIntent): (input: string) => string {
  return intent.shellProfile?.family === 'csh' ? quoteCshArg : quotePosixArg;
}

function isWindows(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

function quotePosixArg(input: string): string {
  if (input.length === 0) return "''";
  if (!/[\s'"\\$`\n\r\t;&|<>(){}[\]*?!]/.test(input)) return input;
  return `'${input.replace(/'/g, "'\\''")}'`;
}

function argvToPosixShellLine(intent: PtySpawnIntent, command: string, args: string[]): string {
  return [command, ...args].map(shellArgQuoter(intent)).join(' ');
}

function quoteForPowerShell(input: string): string {
  if (input.length === 0) return "''";
  if (!/[\s'`"$;&|<>(){}[\],]/.test(input)) return input;
  return `'${input.replace(/'/g, "''")}'`;
}

function windowsWarnings(intent: PtySpawnIntent): LocalPtySpawnWarning[] {
  const warnings: LocalPtySpawnWarning[] = [];
  if (intent.shellSetup) warnings.push('shell_setup_ignored_on_windows');
  if (intent.tmuxSessionName) warnings.push('tmux_unsupported_on_windows');
  return warnings;
}

function windowsShellLineSpawn({
  commandLine,
  cwd,
  env,
  shellProfile,
  warnings,
}: {
  commandLine: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  shellProfile: PtySpawnIntent['shellProfile'];
  warnings: LocalPtySpawnWarning[];
}): ResolvedLocalPtySpawn {
  const shell = shellProfile?.executable ?? getWindowsShellExecutable(env);
  const commandArgs = shellProfile?.commandArgs ?? ['/d', '/s', '/c'];
  return {
    command: shell,
    args:
      shellProfile?.family === 'powershell' || shellProfile?.family === 'wsl'
        ? [...commandArgs, commandLine]
        : [...commandArgs, wrapCmdExeCommandLine(commandLine)],
    cwd,
    warnings,
  };
}

function cmdShellLineSpawn({
  commandLine,
  cwd,
  env,
  warnings,
}: {
  commandLine: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  warnings: LocalPtySpawnWarning[];
}): ResolvedLocalPtySpawn {
  return {
    command: getWindowsShellExecutable(env),
    args: ['/d', '/s', '/c', wrapCmdExeCommandLine(commandLine)],
    cwd,
    warnings,
  };
}

function powerShellFileArgs(suppressProfile: boolean): string[] {
  return [suppressProfile ? '-NoProfile' : '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File'];
}

function resolveWindowsSpawn(
  intent: PtySpawnIntent,
  env: NodeJS.ProcessEnv,
  fileExists: FileExists
): ResolvedLocalPtySpawn {
  const warnings = windowsWarnings(intent);
  const shell = intent.shellProfile?.executable ?? getWindowsShellExecutable(env);

  if (intent.kind === 'interactive-shell') {
    return {
      command: shell,
      args: intent.shellProfile?.interactiveArgs ?? [],
      cwd: intent.cwd,
      warnings,
    };
  }

  if (intent.command.kind === 'shell-line') {
    return windowsShellLineSpawn({
      commandLine: intent.command.commandLine,
      cwd: intent.cwd,
      env,
      shellProfile: intent.shellProfile,
      warnings,
    });
  }

  const { command, args } = intent.command;
  if (intent.shellProfile?.family === 'wsl') {
    return windowsShellLineSpawn({
      commandLine: argvToPosixShellLine(intent, command, args),
      cwd: intent.cwd,
      env,
      shellProfile: intent.shellProfile,
      warnings,
    });
  }

  const resolvedCommand =
    resolveWindowsCommandPath({
      command,
      cwd: intent.cwd,
      env,
      fileExists,
      powershell: intent.shellProfile?.family === 'powershell',
    }) ?? command;
  const ext = path.win32.extname(resolvedCommand).toLowerCase();

  if (ext === '.cmd' || ext === '.bat') {
    if (intent.shellProfile?.family === 'powershell') {
      return windowsShellLineSpawn({
        commandLine: `& ${[resolvedCommand, ...args].map(quoteForPowerShell).join(' ')}`,
        cwd: intent.cwd,
        env,
        shellProfile: intent.shellProfile,
        warnings,
      });
    }
    return cmdShellLineSpawn({
      commandLine: [resolvedCommand, ...args].map(quoteForCmdExe).join(' '),
      cwd: intent.cwd,
      env,
      warnings,
    });
  }

  if (ext === '.ps1') {
    const selectedPowerShell =
      intent.shellProfile?.family === 'powershell' ? intent.shellProfile : undefined;
    return {
      command: selectedPowerShell?.executable ?? 'powershell.exe',
      args: [...powerShellFileArgs(selectedPowerShell === undefined), resolvedCommand, ...args],
      cwd: intent.cwd,
      warnings,
    };
  }

  if (!ext) {
    if (intent.shellProfile?.family === 'powershell') {
      return windowsShellLineSpawn({
        commandLine: `& ${[command, ...args].map(quoteForPowerShell).join(' ')}`,
        cwd: intent.cwd,
        env,
        shellProfile: intent.shellProfile,
        warnings,
      });
    }
    return cmdShellLineSpawn({
      commandLine: [command, ...args].map(quoteForCmdExe).join(' '),
      cwd: intent.cwd,
      env,
      warnings,
    });
  }

  return { command: resolvedCommand, args, cwd: intent.cwd, warnings };
}

function resolvePosixSpawn(intent: PtySpawnIntent, env: NodeJS.ProcessEnv): ResolvedLocalPtySpawn {
  const shell = getResolvedShell(intent, env);
  const interactiveArgs = getInteractiveArgs(intent);
  const commandArgs = getCommandArgs(intent);
  const setupWrapperArgs = getSetupWrapperArgs(intent);

  if (intent.kind === 'interactive-shell') {
    if (intent.tmuxSessionName) {
      const commandLine = intent.shellSetup
        ? `${intent.shellSetup} && exec ${quotePosixArg(shell)} ${interactiveArgs.join(' ')}`
        : `exec ${quotePosixArg(shell)} ${interactiveArgs.join(' ')}`;
      return {
        command: shell,
        args: [
          ...(intent.shellSetup ? setupWrapperArgs : commandArgs),
          buildTmuxShellLine(intent.tmuxSessionName, commandLine, intent.paneEnv),
        ],
        cwd: intent.cwd,
        warnings: [],
      };
    }

    if (intent.shellSetup) {
      return {
        command: shell,
        args: [
          ...setupWrapperArgs,
          `${intent.shellSetup} && exec ${quotePosixArg(shell)} ${interactiveArgs.join(' ')}`,
        ],
        cwd: intent.cwd,
        warnings: [],
      };
    }

    return { command: shell, args: interactiveArgs, cwd: intent.cwd, warnings: [] };
  }

  if (
    intent.shellProfile?.family === 'powershell' ||
    intent.shellProfile?.family === 'windows-cmd' ||
    intent.shellProfile?.family === 'wsl'
  ) {
    throw new Error(
      `Cannot run POSIX shell-wrapped commands through ${intent.shellProfile.resolvedShellId}`
    );
  }

  const commandLine =
    intent.command.kind === 'shell-line'
      ? intent.command.commandLine
      : argvToPosixShellLine(intent, intent.command.command, intent.command.args);
  const fullCommandLine = intent.shellSetup
    ? `${intent.shellSetup} && ${commandLine}`
    : commandLine;

  if (intent.tmuxSessionName) {
    return {
      command: shell,
      args: [
        ...commandArgs,
        buildTmuxShellLine(intent.tmuxSessionName, fullCommandLine, intent.paneEnv),
      ],
      cwd: intent.cwd,
      warnings: [],
    };
  }

  return {
    command: shell,
    args: [...commandArgs, fullCommandLine],
    cwd: intent.cwd,
    warnings: [],
  };
}

export function resolveLocalPtySpawn({
  intent,
  platform,
  env,
  fileExists = existsSync,
}: {
  intent: PtySpawnIntent;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fileExists?: FileExists;
}): ResolvedLocalPtySpawn {
  return isWindows(platform)
    ? resolveWindowsSpawn(intent, env, fileExists)
    : resolvePosixSpawn(intent, env);
}

export function logLocalPtySpawnWarnings(
  source: string,
  warnings: LocalPtySpawnWarning[],
  context: Record<string, string>
): void {
  if (warnings.length === 0) return;
  log.warn(`${source}: local PTY platform warning`, { ...context, warnings });
}
