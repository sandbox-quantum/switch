import { describe, expect, it } from 'vitest';
import { OPENCODE_UNSUPPORTED_MESSAGE, plugin } from './index';

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

  // OpenCode 2.x is the separate @opencode/cli package with an API Console cannot
  // drive, so install and update stay on the opencode-ai 1.x major.
  it('installs the opencode-ai 1.x line on every platform', () => {
    for (const platform of ['macos', 'linux', 'windows'] as const) {
      const command = firstOption(platform).command;
      expect(command).toMatch(/ opencode-ai@1$/);
      expect(command).not.toContain('@opencode/cli');
    }
  });

  it('updates by re-running the pinned install', () => {
    expect(hostDependency.updates).toEqual({
      kind: 'supported',
      releaseSource: { kind: 'npm', package: 'opencode-ai' },
      update: { kind: 'package-manager' },
    });
    for (const platform of ['macos', 'linux', 'windows'] as const) {
      expect(firstOption(platform).updateCommand).toBeUndefined();
    }
  });

  it('reports OpenCode 2.x as unsupported', () => {
    expect(hostDependency.unsupportedFrom).toEqual({
      version: '2.0.0',
      message: OPENCODE_UNSUPPORTED_MESSAGE,
    });
    expect(OPENCODE_UNSUPPORTED_MESSAGE).toContain("OpenCode 2.x isn't supported yet");
  });

  // macOS and Windows npm prefixes are user-writable already, and moving them
  // would strand anyone who installed before this.
  it.each(['macos', 'windows'] as const)('leaves the %s prefix alone', (platform) => {
    expect(firstOption(platform).command).not.toContain('--prefix');
  });

  it('uninstalls both opencode-ai and @opencode/cli on every platform', () => {
    for (const platform of ['macos', 'linux', 'windows'] as const) {
      const cmd = firstOption(platform).uninstallCommand ?? '';
      expect(cmd).toContain('@opencode/cli');
      expect(cmd).toContain('opencode-ai');
    }
  });

  it('probes the opencode binary', () => {
    expect(hostDependency.binaryNames).toEqual(['opencode']);
  });
});
