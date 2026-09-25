import type { PluginFs } from '@switch-console/core/agents/plugins';
/**
 * Changing an agent's configuration has to reach the thing that launches it —
 * which, for a remote agent, is a launch spec sitting on the VM (CHOO-2228).
 *
 * Writing the config file alone is enough for a provider whose CLI reads its
 * definition at every spawn (Claude Code), and not enough for one whose
 * settings are handed over as a generated profile: there the spec has to be
 * rebuilt, or an auto-started session keeps running on the previous
 * instructions while the app shows the new ones.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setAgentProviderConfig = vi.hoisted(() => vi.fn(async (_params: unknown) => {}));
const state = vi.hoisted(() => ({
  providerId: 'codex',
  files: new Map<string, string>(),
}));

const fakeFs = vi.hoisted(
  () => (): PluginFs => ({
    read: async (path: string) => state.files.get(path) ?? null,
    write: async (path: string, content: string) => {
      state.files.set(path, content);
    },
    delete: async (path: string) => {
      state.files.delete(path);
    },
    exists: async (path: string) => state.files.has(path),
    list: async () => [],
  })
);

vi.mock('./getAgentById', () => ({
  getAgentById: async (agentId: string) => ({
    id: agentId,
    name: 'agent-one',
    providerId: state.providerId,
    locationId: 'loc-1',
  }),
}));
vi.mock('./agent-location', () => ({
  getAgentLocation: async () => ({ id: 'loc-1', dir: '/repo', sshHost: 'vm-1' }),
}));
vi.mock('./agent-workspace-fs', () => ({
  resolveWorkspaceFsFor: async () => ({ fs: fakeFs(), close: () => {} }),
}));
vi.mock('./setAgentProviderConfig', () => ({
  setAgentProviderConfig: (params: unknown) => setAgentProviderConfig(params),
}));
vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: (id: string) => ({
    behavior:
      id === 'claude'
        ? {
            repoAgents: {
              definitionPath: (name: string) => `.claude/agents/${name}.md`,
              renderDefinition: (attributes: Record<string, unknown>) =>
                `---\nname: ${String(attributes.name)}\n---\n\n${String(attributes.instructions)}\n`,
              readDefinition: async () => null,
            },
          }
        : { mcp: { launchProfileFields: () => [] } },
  }),
}));

import { setAgentInstructions } from './agent-config';

beforeEach(() => {
  setAgentProviderConfig.mockClear();
  state.files.clear();
  state.providerId = 'codex';
});

describe('setAgentInstructions', () => {
  it('rebuilds the launch profile for a provider that reads one', async () => {
    // Codex takes its instructions as a generated profile file, baked into the
    // remote launch spec. Without this the VM keeps the old prompt.
    await setAgentInstructions({ agentId: 'agent-1', instructions: 'Be careful.' });

    expect(setAgentProviderConfig).toHaveBeenCalledTimes(1);
    expect(setAgentProviderConfig.mock.calls[0]?.[0]).toMatchObject({
      agentId: 'agent-1',
      config: { values: { instructions: 'Be careful.' } },
    });
  });

  it('does not for a provider whose CLI reads the definition itself', async () => {
    // Claude Code launches with `--agent <name>` and reads the definition file
    // fresh each time, which the write above already updated.
    state.providerId = 'claude';

    await setAgentInstructions({ agentId: 'agent-1', instructions: 'Be careful.' });

    expect(setAgentProviderConfig).not.toHaveBeenCalled();
  });

  it('carries a cleared prompt through too, not just a set one', async () => {
    await setAgentInstructions({ agentId: 'agent-1', instructions: 'Be careful.' });
    setAgentProviderConfig.mockClear();

    await setAgentInstructions({ agentId: 'agent-1', instructions: '' });

    expect(setAgentProviderConfig).toHaveBeenCalledTimes(1);
    expect(setAgentProviderConfig.mock.calls[0]?.[0]).toMatchObject({
      agentId: 'agent-1',
      config: null,
    });
  });
});
