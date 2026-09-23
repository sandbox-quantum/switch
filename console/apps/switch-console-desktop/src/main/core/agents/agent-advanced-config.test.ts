import type { PluginFs } from '@switch-console/core/agents/plugins';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  getAgentAdvancedFields,
  getAgentAdvancedSurface,
  readAgentAdvancedConfig,
  updateAgentAdvancedConfig,
} from './agent-advanced-config';
import { agentLaunchSpecialization } from './agent-launch-config';

const files = vi.hoisted(() => new Map<string, string>());
vi.mock('./getAgentById', () => ({
  getAgentById: async () => ({ id: 'agent-1', name: 'scout', providerId: 'antigravity' }),
}));
vi.mock('./agent-location', () => ({
  getAgentLocation: async () => ({ dir: '/work', sshHost: null }),
}));
vi.mock('./agent-workspace-fs', () => ({
  resolveWorkspaceFsFor: async () => ({
    fs: {
      read: async (path) => files.get(path) ?? null,
      write: async (path, content) => {
        files.set(path, content);
      },
      delete: async (path) => {
        files.delete(path);
      },
      exists: async (path) => files.has(path),
      list: async () => [...files.keys()],
    } satisfies PluginFs,
    close: () => {},
  }),
}));
vi.mock('./setAgentProviderConfig', () => ({ setAgentProviderConfig: vi.fn() }));

beforeEach(() => files.clear());

it('exposes Antigravity model defaults without advertising a native MCP config or profile', () => {
  expect(getAgentAdvancedSurface('antigravity')).toBe('session');
  expect(getAgentAdvancedFields('antigravity')).toEqual([
    expect.objectContaining({ key: 'model', catalogue: { kind: 'model' } }),
  ]);
  expect(getAgentAdvancedSurface('claude')).toBe('definition');
  expect(getAgentAdvancedSurface('codex')).toBe('launch-profile');
});

it('round-trips the model through editing and the session launch configuration', async () => {
  await updateAgentAdvancedConfig({ agentId: 'agent-1', attributes: { model: 'model-a' } });
  expect(await readAgentAdvancedConfig('agent-1')).toEqual({ model: 'model-a' });
  expect(await agentLaunchSpecialization('agent-1')).toEqual({ model: 'model-a' });

  await updateAgentAdvancedConfig({ agentId: 'agent-1', attributes: {} });
  expect(await readAgentAdvancedConfig('agent-1')).toEqual({});
  expect(await agentLaunchSpecialization('agent-1')).toBeUndefined();
});
