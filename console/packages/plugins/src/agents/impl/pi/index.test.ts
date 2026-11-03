import { describe, expect, it } from 'vitest';
import { pluginRegistry } from '../../registry';
import { plugin } from './index';

const hostDependency = plugin.capabilities.hostDependency;

describe('pi plugin', () => {
  it('is registered last, after the providers there were', () => {
    expect(pluginRegistry.ids()).toEqual([
      'codex',
      'claude',
      'antigravity',
      'cursor',
      'opencode',
      'pi',
    ]);
    expect(plugin.validate()).toEqual([]);
  });

  it('installs exactly the Pi release Switch runs, on every platform', () => {
    for (const platform of ['macos', 'linux', 'windows'] as const) {
      const npm = hostDependency.installCommands[platform]?.find(
        (option) => option.method === 'npm'
      );
      expect(npm?.command, platform).toBe('npm install -g @earendil-works/pi-coding-agent@1.4.0');
    }
    expect(hostDependency.binaryNames).toEqual(['pi']);
  });

  it('asks the version offline and never looks up a newer release', () => {
    expect(hostDependency.versionArgs).toEqual(['--version', '--offline']);
    expect(hostDependency.updates).toEqual({
      kind: 'supported',
      releaseSource: { kind: 'none' },
      update: { kind: 'package-manager' },
    });
  });

  it('runs only through the session host', () => {
    expect(plugin.capabilities.prompt.kind).toBe('none');
    expect(plugin.capabilities.mcp.kind).toBe('none');
    expect(plugin.capabilities.sessions.kind).toBe('resumable');
    expect(plugin.capabilities.autoApprove.kind).toBe('supported');
  });
});
