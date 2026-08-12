import { describe, expect, it } from 'vitest';
import {
  getWindowsEnvValue,
  quoteForCmdExe,
  resolveExecFileSpawn,
  resolveWindowsCommandPath,
} from './windows-spawn';

const WINDOWS_ENV: NodeJS.ProcessEnv = {
  Path: 'C:\\Program Files\\nodejs;C:\\Windows\\System32',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
};

function existsIn(paths: string[]) {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (candidate: string) => set.has(candidate.toLowerCase());
}

describe('getWindowsEnvValue', () => {
  it('finds a key whose casing differs from the request', () => {
    expect(getWindowsEnvValue(WINDOWS_ENV, 'PATH')).toBe(WINDOWS_ENV.Path);
  });

  it('returns undefined when nothing matches', () => {
    expect(getWindowsEnvValue(WINDOWS_ENV, 'NOPE')).toBeUndefined();
  });
});

describe('quoteForCmdExe', () => {
  it('quotes a path containing a space', () => {
    expect(quoteForCmdExe('C:\\Program Files\\nodejs\\npm.cmd')).toBe(
      '"C:\\Program Files\\nodejs\\npm.cmd"'
    );
  });

  it('escapes cmd.exe metacharacters', () => {
    expect(quoteForCmdExe('a&b')).toBe('"a^&b"');
  });
});

describe('resolveWindowsCommandPath', () => {
  it('walks PATHEXT over the PATH directories', () => {
    const resolved = resolveWindowsCommandPath({
      command: 'npm',
      env: WINDOWS_ENV,
      fileExists: existsIn(['C:\\Program Files\\nodejs\\npm.cmd']),
    });
    // The resolved name carries the PATHEXT casing, which cmd.exe accepts.
    expect(resolved).toBe('C:\\Program Files\\nodejs\\npm.CMD');
  });

  it('does not search the working directory unless one is given', () => {
    const fileExists = existsIn(['C:\\repo\\npm.cmd']);
    expect(resolveWindowsCommandPath({ command: 'npm', env: WINDOWS_ENV, fileExists })).toBeNull();
    expect(
      resolveWindowsCommandPath({ command: 'npm', cwd: 'C:\\repo', env: WINDOWS_ENV, fileExists })
    ).toBe('C:\\repo\\npm.CMD');
  });

  it('returns null when the command already has an extension', () => {
    expect(
      resolveWindowsCommandPath({
        command: 'npm.cmd',
        env: WINDOWS_ENV,
        fileExists: () => true,
      })
    ).toBeNull();
  });
});

describe('resolveExecFileSpawn', () => {
  it('passes argv through untouched off Windows', () => {
    const spawn = resolveExecFileSpawn({
      command: 'npm',
      args: ['root', '-g'],
      platform: 'darwin',
      env: {},
      fileExists: () => true,
    });
    expect(spawn).toEqual({
      command: 'npm',
      args: ['root', '-g'],
      windowsVerbatimArguments: false,
    });
  });

  it('routes a .cmd shim through cmd.exe with a quoted command line', () => {
    const spawn = resolveExecFileSpawn({
      command: 'npm',
      args: ['root', '-g'],
      platform: 'win32',
      env: WINDOWS_ENV,
      fileExists: existsIn(['C:\\Program Files\\nodejs\\npm.cmd']),
    });

    expect(spawn.command).toBe('C:\\Windows\\System32\\cmd.exe');
    // The whole line is wrapped once more because it starts with a quote.
    expect(spawn.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""C:\\Program Files\\nodejs\\npm.CMD" root -g"',
    ]);
    expect(spawn.windowsVerbatimArguments).toBe(true);
  });

  it('spawns a resolved .exe directly', () => {
    const spawn = resolveExecFileSpawn({
      command: 'where',
      args: ['git'],
      platform: 'win32',
      env: WINDOWS_ENV,
      fileExists: existsIn(['C:\\Windows\\System32\\where.exe']),
    });

    expect(spawn).toEqual({
      command: 'C:\\Windows\\System32\\where.EXE',
      args: ['git'],
      windowsVerbatimArguments: false,
    });
  });

  it('honours an explicit .cmd path that was never on PATH', () => {
    const spawn = resolveExecFileSpawn({
      command: 'D:\\tools\\claude.cmd',
      args: ['--version'],
      platform: 'win32',
      env: WINDOWS_ENV,
      fileExists: () => false,
    });

    expect(spawn.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(spawn.args[3]).toBe('D:\\tools\\claude.cmd --version');
  });
});
