import { describe, expect, it } from 'vitest';
import { pluginRegistry } from '../../plugin-registry';
import { plugin } from './index';

describe('Copilot provider registration', () => {
  it('is discoverable by the same plugin used by Console and headless controllers', () => {
    const registered = pluginRegistry.get('copilot');
    expect(registered?.metadata).toMatchObject({
      id: 'copilot',
      name: 'GitHub Copilot',
      cliLabel: 'GitHub Copilot CLI',
    });
    expect(registered?.capabilities.hostDependency.binaryNames).toEqual(['copilot']);
  });

  it.each(['macos', 'linux', 'windows'] as const)('offers an install hint on %s', (platform) => {
    expect(plugin.capabilities.hostDependency.installCommands[platform]).toContainEqual({
      method: 'npm',
      command: 'npm install -g @github/copilot',
    });
  });

  it('uses native ACP sessions and exposes auto approval through Switch policy', () => {
    expect(plugin.capabilities).toMatchObject({
      autoApprove: { kind: 'supported' },
      sessions: { kind: 'resumable' },
      prompt: { kind: 'none' },
      mcp: { kind: 'none' },
    });
  });
});
