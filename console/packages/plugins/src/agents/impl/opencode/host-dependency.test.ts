import { describe, expect, it } from 'vitest';
import { plugin } from './index';

const hostDependency = plugin.capabilities.hostDependency;

function firstOption(platform: 'macos' | 'linux' | 'windows') {
  const option = hostDependency.installCommands?.[platform]?.[0];
  if (!option) throw new Error(`no install option declared for ${platform}`);
  return option;
}

describe('opencode host dependency', () => {
  // npm's default global prefix on Linux is a system directory, so a plain
  // `npm install -g` needs root. Remote agent users generally do not have it,
  // and the install dies with EACCES partway through host setup.
  it('installs into the user prefix on Linux', () => {
    const option = firstOption('linux');
    expect(option.command).toContain('--prefix "$HOME/.local"');
    expect(option.uninstallCommand).toContain('--prefix "$HOME/.local"');
    expect(option.recommended).toBe(true);
  });

  // OpenCode 2 (`@opencode/cli`) serves an API Switch does not speak yet.
  it('installs OpenCode 1 from npm on macOS and Linux', () => {
    for (const platform of ['macos', 'linux'] as const) {
      expect(firstOption(platform).command).toMatch(/opencode-ai$/);
      expect(firstOption(platform).command).not.toContain('@opencode/cli');
    }
  });

  // macOS npm prefixes are user-writable already, and moving them would
  // strand anyone who installed before this.
  it('leaves the macOS prefix alone', () => {
    expect(firstOption('macos').command).not.toContain('--prefix');
  });

  it('uninstalls both opencode-ai and the @opencode/cli Console used to install', () => {
    for (const platform of ['macos', 'linux'] as const) {
      const cmd = firstOption(platform).uninstallCommand ?? '';
      expect(cmd).toContain('@opencode/cli');
      expect(cmd).toContain('opencode-ai');
    }
  });

  // A fresh Windows has no Node, so no npm.
  it('installs the OpenCode 1 release on Windows, without npm, and offers npm after it', () => {
    const [release, npm] = hostDependency.installCommands?.windows ?? [];
    expect(release?.recommended).toBe(true);
    expect(release?.command).toContain('/releases/download/v1.');
    expect(release?.command).toContain('opencode-windows-x64.zip');
    expect(release?.command).not.toMatch(/[$%]/);
    expect(release?.command.slice(release.command.indexOf('"') + 1, -1)).not.toContain('"');
    expect(release?.uninstallCommand).toContain("'.opencode', 'bin'");
    expect(npm?.command).toBe('npm install -g opencode-ai');
    expect(npm?.recommended).toBeUndefined();
  });

  it('probes the opencode binary', () => {
    expect(hostDependency.binaryNames).toEqual(['opencode']);
  });
});
