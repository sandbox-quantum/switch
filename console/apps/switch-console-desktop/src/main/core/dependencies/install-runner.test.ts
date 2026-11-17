import { describe, expect, it, vi } from 'vitest';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import {
  classifyInstallCommandFailure,
  missingCommandIn,
  runLocalInstallCommand,
} from './install-runner';

vi.mock('@main/utils/userEnv', () => ({ ensureUserBinDirsInPath: vi.fn() }));
const profile: ResolvedShellProfile = {
  id: 'bash',
  resolvedShellId: 'bash',
  resolvedFromSystem: false,
  executable: '/bin/bash',
  available: true,
  family: 'posix',
  commandArgs: ['-c'],
};

describe('noninteractive install commands', () => {
  it('preserves literal argv without shell expansion', async () => {
    const value = '$(exit 9) "quoted" ; exit 8';
    const result = await runLocalInstallCommand(
      {
        command: process.execPath,
        args: ['-e', 'process.exit(process.argv[1] === process.argv[2] ? 0 : 1)', value, value],
      },
      profile
    );
    expect(result.success).toBe(true);
  });
  it('runs shell descriptors with closed stdin', async () => {
    expect((await runLocalInstallCommand('test ! -t 0 && test ! -t 1', profile)).success).toBe(
      true
    );
  });
  it('captures stderr and failure status', async () => {
    const result = await runLocalInstallCommand('echo "permission denied" >&2; exit 13', profile);
    expect(result).toMatchObject({
      success: false,
      error: { type: 'permission-denied', exitCode: 13 },
    });
  });
  it('reports missing executables', async () => {
    const result = await runLocalInstallCommand(
      { command: '/nonexistent/switch-install-test', args: [] },
      profile
    );
    expect(result).toMatchObject({ success: false, error: { type: 'process-open-failed' } });
  });
  it('says when the disk is full', () => {
    const error = classifyInstallCommandFailure({
      exitCode: 1,
      output: 'npm ERR! code ENOSPC\nnpm ERR! nospc ENOSPC: no space left on device, write',
    });
    expect(error.type).toBe('command-failed');
    expect(error.message).toMatch(/not enough free disk space/i);
  });
  it('classifies command failures', () => {
    expect(classifyInstallCommandFailure({ exitCode: 1, output: 'failed' }).type).toBe(
      'command-failed'
    );
  });
});

describe('a program the install command needed but could not find', () => {
  it.each([
    [
      'Windows PowerShell',
      "npm : The term 'npm' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.",
      'npm',
    ],
    [
      'PowerShell 7',
      "winget: The term 'winget' is not recognized as a name of a cmdlet, function, script file, or executable program.",
      'winget',
    ],
    ['cmd.exe', "'npm.cmd' is not recognized as an internal or external command,", 'npm'],
    ['bash', 'bash: line 1: npm: command not found', 'npm'],
    ['sh', 'sh: 1: npm: not found', 'npm'],
    ['a path', "The term 'C:\\tools\\curl.exe' is not recognized as the name of a cmdlet", 'curl'],
  ])('names it from %s', (_shell, output, command) => {
    expect(missingCommandIn(output)).toBe(command);
  });

  it('names nothing for an ordinary failure', () => {
    expect(missingCommandIn('npm ERR! code E404\nnpm ERR! 404 Not Found')).toBeNull();
    expect(missingCommandIn('Error: Not Found')).toBeNull();
    expect(missingCommandIn('curl: error: Not Found')).toBeNull();
    expect(missingCommandIn('curl: error: not found')).toBeNull();
  });

  it('is reported as the missing program, not a generic failure', () => {
    expect(
      classifyInstallCommandFailure({
        exitCode: 1,
        output: "npm : The term 'npm' is not recognized as the name of a cmdlet, function",
      })
    ).toMatchObject({ type: 'command-failed', missingCommand: 'npm' });
  });
});

describe('missingCommandIn, about where in the output', () => {
  it('passes over a program a step inside the install could not find', () => {
    const output = [
      '> some-native-dep@1.0.0 install',
      'sh: node-gyp: not found',
      ...Array.from({ length: 10 }, (_, i) => `npm ERR! line ${i}`),
      'npm ERR! A complete log of this run can be found in: …',
    ].join('\n');
    expect(missingCommandIn(output)).toBeNull();
  });

  it('takes the last missing program when that is how the output ends', () => {
    expect(missingCommandIn('bash: unzip: command not found\nbash: npm: command not found')).toBe(
      'npm'
    );
  });
});
