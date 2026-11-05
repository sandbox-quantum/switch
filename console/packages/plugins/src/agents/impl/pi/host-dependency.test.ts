import { describe, expect, it } from 'vitest';
import { plugin } from './index';

const hostDependency = plugin.capabilities.hostDependency;

function firstOption(platform: 'macos' | 'linux' | 'windows') {
  const option = hostDependency.installCommands?.[platform]?.[0];
  if (!option) throw new Error(`no install option declared for ${platform}`);
  return option;
}

describe('pi host dependency', () => {
  it('installs the Pi package on every platform and probes the pi binary', () => {
    for (const platform of ['macos', 'linux', 'windows'] as const)
      expect(firstOption(platform).command).toContain('@earendil-works/pi-coding-agent');
    expect(hostDependency.binaryNames).toEqual(['pi']);
  });

  // npm's default global prefix on Linux is a system directory, so a plain
  // `npm install -g` needs root, which a remote agent's user generally lacks.
  it('installs and uninstalls in the user prefix on Linux', () => {
    const option = firstOption('linux');
    expect(option.command).toContain('--prefix "$HOME/.local"');
    expect(option.uninstallCommand).toContain('--prefix "$HOME/.local"');
  });

  it.each(['macos', 'windows'] as const)('leaves the %s prefix alone', (platform) => {
    expect(firstOption(platform).command).not.toContain('--prefix');
  });

  it('is updated from npm', () => {
    expect(hostDependency.updates).toMatchObject({
      kind: 'supported',
      releaseSource: { kind: 'npm', package: '@earendil-works/pi-coding-agent' },
    });
  });
});
