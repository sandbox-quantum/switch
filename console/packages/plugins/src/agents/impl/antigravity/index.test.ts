import { describe, expect, it } from 'vitest';
import {
  AGY_INSTALL_UNIX,
  AGY_INSTALL_WINDOWS,
  antigravityUpdateCommand,
  plugin,
  provider,
} from './index';

const dependency = plugin.capabilities.hostDependency;

describe('Antigravity host dependency', () => {
  it('looks for Google’s agy first and still finds a legacy antigravity-acp install', () => {
    expect(dependency.binaryNames).toEqual(['agy', 'antigravity-acp']);
    expect(dependency.versionArgs ?? ['--version']).toEqual(['--version']);
  });

  it.each([
    ['macos', AGY_INSTALL_UNIX],
    ['linux', AGY_INSTALL_UNIX],
    ['windows', AGY_INSTALL_WINDOWS],
  ] as const)('installs agy with Google’s installer on %s', (platform, command) => {
    const options = dependency.installCommands[platform] ?? [];
    expect((options.find((option) => option.recommended) ?? options[0])?.command).toBe(command);
  });

  it('runs the Windows installer through PowerShell from either shell', () => {
    expect(AGY_INSTALL_WINDOWS).toContain('https://antigravity.google/cli/install.ps1');
    // The install runner's shell may be cmd.exe or PowerShell; each would
    // expand one of these before PowerShell saw the command.
    expect(AGY_INSTALL_WINDOWS).not.toMatch(/[$%]/);
  });

  it('updates agy with its own update command', () => {
    expect(dependency.updates).toMatchObject({ update: { kind: 'cli', args: ['update'] } });
  });

  it('runs `agy update` for agy, wherever it is installed', () => {
    for (const binaryPath of [
      '/home/u/.local/bin/agy',
      'C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe',
    ])
      expect(antigravityUpdateCommand(binaryPath)).toEqual({
        command: binaryPath,
        args: ['update'],
      });
    expect(provider.behavior.hostDependency?.buildUpdateCommand).toBe(antigravityUpdateCommand);
  });

  it('updates a legacy antigravity-acp install by installing agy, which it takes no update command for', () => {
    expect(antigravityUpdateCommand('/home/u/.local/bin/antigravity-acp')).toEqual({
      command: 'bash',
      args: ['-c', AGY_INSTALL_UNIX],
    });
  });
});
