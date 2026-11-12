import { describe, expect, it } from 'vitest';
import { plugin } from './index';

const hostDependency = plugin.capabilities.hostDependency;

function firstOption(platform: 'macos' | 'linux' | 'windows') {
  const option = hostDependency.installCommands?.[platform]?.[0];
  if (!option) throw new Error(`no install option declared for ${platform}`);
  return option;
}

describe('pi host dependency', () => {
  // A headless agent controller's user usually cannot write npm's default
  // global prefix on Linux, a system directory.
  it('installs into the user prefix on Linux', () => {
    expect(firstOption('linux')).toEqual({
      method: 'npm',
      command: 'npm install -g --prefix "$HOME/.local" @earendil-works/pi-coding-agent',
      uninstallCommand: 'npm uninstall -g --prefix "$HOME/.local" @earendil-works/pi-coding-agent',
      recommended: true,
    });
  });

  it.each(['macos', 'windows'] as const)('installs globally on %s', (platform) => {
    expect(firstOption(platform).command).toBe('npm install -g @earendil-works/pi-coding-agent');
  });

  it('probes the pi binary and updates from npm', () => {
    expect(hostDependency.binaryNames).toEqual(['pi']);
    expect(hostDependency.updates).toMatchObject({
      releaseSource: { kind: 'npm', package: '@earendil-works/pi-coding-agent' },
    });
  });
});
