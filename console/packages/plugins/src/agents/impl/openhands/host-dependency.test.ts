import { expect, it } from 'vitest';
import { plugin } from './index';

it('detects the native CLI and offers a user-scoped install on supported platforms', () => {
  const dependency = plugin.capabilities.hostDependency;
  expect(dependency.binaryNames).toEqual(['openhands']);
  for (const platform of ['linux', 'macos'] as const)
    expect(dependency.installCommands?.[platform]?.[0]?.command).toBe(
      'uv tool install --python 3.12 openhands'
    );
  expect(dependency.installCommands?.windows).toBeUndefined();
});

it('uses the session host for model discovery, MCP and prompts', () => {
  expect(plugin.metadata.id).toBe('openhands');
  expect(plugin.capabilities).toMatchObject({
    autoApprove: { kind: 'supported' },
    models: { kind: 'none' },
    mcp: { kind: 'none' },
    sessions: { kind: 'resumable' },
  });
});
