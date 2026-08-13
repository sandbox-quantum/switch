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

  it('installs the opencode-ai package on every platform', () => {
    for (const platform of ['macos', 'linux', 'windows'] as const) {
      expect(firstOption(platform).command).toContain('opencode-ai');
    }
  });

  // macOS and Windows npm prefixes are user-writable already, and moving them
  // would strand anyone who installed before this.
  it.each(['macos', 'windows'] as const)('leaves the %s prefix alone', (platform) => {
    expect(firstOption(platform).command).not.toContain('--prefix');
  });

  it('probes the opencode binary', () => {
    expect(hostDependency.binaryNames).toEqual(['opencode']);
  });
});
