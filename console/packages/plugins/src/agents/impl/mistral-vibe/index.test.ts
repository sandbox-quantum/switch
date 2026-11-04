import { expect, it } from 'vitest';
import { pluginRegistry } from '../../plugin-registry';
import { plugin } from './index';

it('registers native Vibe discovery and installation on each platform', () => {
  expect(pluginRegistry.get('mistral-vibe')?.metadata.name).toBe('Mistral Vibe');
  expect(plugin.validate()).toEqual([]);
  expect(plugin.capabilities.hostDependency.binaryNames).toEqual(['vibe-acp']);
  for (const platform of ['macos', 'linux', 'windows'] as const)
    expect(plugin.capabilities.hostDependency.installCommands[platform]?.[0]?.command).toBe(
      'uv tool install mistral-vibe'
    );
});

it('delegates models and prompts to ACP and supports resumable sessions', () => {
  expect(plugin.capabilities.models.kind).toBe('none');
  expect(plugin.capabilities.prompt.kind).toBe('none');
  expect(plugin.capabilities.sessions.kind).toBe('resumable');
  expect(plugin.capabilities.autoApprove.kind).toBe('supported');
  expect(plugin.assets.icon.alt).toBe('Mistral Vibe');
});
