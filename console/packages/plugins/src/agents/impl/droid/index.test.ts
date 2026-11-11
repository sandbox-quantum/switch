import { describe, expect, it } from 'vitest';
import {
  DROID_INSTALL_UNIX,
  DROID_INSTALL_WINDOWS,
  droidUpdateCommand,
  plugin,
  provider,
} from './index';

const dependency = plugin.capabilities.hostDependency;

describe('Factory Droid host dependency', () => {
  it('looks for droid binary and specifies default versionArgs', () => {
    expect(dependency.binaryNames).toEqual(['droid']);
    expect(dependency.versionArgs ?? ['--version']).toEqual(['--version']);
  });

  it.each([
    ['macos', DROID_INSTALL_UNIX],
    ['linux', DROID_INSTALL_UNIX],
    ['windows', DROID_INSTALL_WINDOWS],
  ] as const)('installs droid with official installer on %s', (platform, command) => {
    const options = dependency.installCommands[platform] ?? [];
    expect((options.find((option) => option.recommended) ?? options[0])?.command).toBe(command);
  });

  it('offers homebrew cask for macos', () => {
    const macOptions = dependency.installCommands.macos ?? [];
    expect(macOptions.find((o) => o.method === 'homebrew')?.command).toBe(
      'brew install --cask droid'
    );
  });

  it('runs the Windows installer through PowerShell from either shell', () => {
    expect(DROID_INSTALL_WINDOWS).toContain('https://app.factory.ai/cli.ps1');
    expect(DROID_INSTALL_WINDOWS).not.toMatch(/[$%]/);
  });

  it('updates droid with its own update command', () => {
    expect(dependency.updates).toMatchObject({ update: { kind: 'cli', args: ['update'] } });
  });

  it('runs `droid update` for droid, wherever it is installed', () => {
    for (const binaryPath of [
      '/home/u/.local/bin/droid',
      'C:\\Users\\u\\AppData\\Local\\droid\\bin\\droid.exe',
    ])
      expect(droidUpdateCommand(binaryPath)).toEqual({
        command: binaryPath,
        args: ['update'],
      });
    expect(provider.behavior.hostDependency?.buildUpdateCommand).toBe(droidUpdateCommand);
  });
});
