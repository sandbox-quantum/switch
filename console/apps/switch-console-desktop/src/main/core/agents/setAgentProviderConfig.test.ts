import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProviderConfig } from '@shared/core/agents/agent-provider-config';

const updateAgent = vi.fn(
  async ({ agentId, providerConfig }): Promise<Record<string, unknown> | undefined> => ({
    id: agentId,
    name: 'codex.yak',
    locationId: 'loc-1',
    providerConfig,
  })
);
const getAgentLocation = vi.fn(async (_agent: unknown) => ({
  id: 'loc-1',
  dir: '/repo',
  sshHost: null,
}));
const getRemoteAgentLocation = vi.fn();
const listAutoSessionAgentIds = vi.fn();
const ensureRemoteWatcher = vi.fn(async (_id: string) => {});
const removeAgentLaunchProfile = vi.fn(
  async (_agent: unknown, _location: unknown, _slug: string) => {}
);

vi.mock('./updateAgent', () => ({ updateAgent: (p: unknown) => updateAgent(p) }));
vi.mock('./agent-location', () => ({
  getAgentLocation: (a: unknown) => getAgentLocation(a),
  getRemoteAgentLocation: (a: unknown) => getRemoteAgentLocation(a),
}));
vi.mock('@main/core/switch-rooms/auto-session-store', () => ({
  listAutoSessionAgentIds: () => listAutoSessionAgentIds(),
}));
vi.mock('./remote-watcher', () => ({
  ensureRemoteWatcher: (id: string) => ensureRemoteWatcher(id),
}));
vi.mock('./remove-launch-profile', () => ({
  removeAgentLaunchProfile: (agent: unknown, location: unknown, slug: string) =>
    removeAgentLaunchProfile(agent, location, slug),
}));

import { setAgentProviderConfig } from './setAgentProviderConfig';

const CONFIG: AgentProviderConfig = { version: '1', model: 'gpt-5.6-terra', effort: 'high' };

describe('setAgentProviderConfig', () => {
  beforeEach(() => {
    updateAgent.mockClear();
    getAgentLocation.mockClear();
    getRemoteAgentLocation.mockReset();
    listAutoSessionAgentIds.mockReset();
    ensureRemoteWatcher.mockClear();
    removeAgentLaunchProfile.mockClear();
  });

  it('writes the config to the agent row', async () => {
    getRemoteAgentLocation.mockResolvedValue(null);

    await setAgentProviderConfig({ agentId: 'agent-1', config: CONFIG });

    expect(updateAgent).toHaveBeenCalledWith({ agentId: 'agent-1', providerConfig: CONFIG });
  });

  it('leaves a local agent alone otherwise — the profile is rewritten at the next spawn', async () => {
    getRemoteAgentLocation.mockResolvedValue(null);

    await setAgentProviderConfig({ agentId: 'agent-1', config: CONFIG });

    expect(ensureRemoteWatcher).not.toHaveBeenCalled();
    expect(removeAgentLaunchProfile).not.toHaveBeenCalled();
  });

  it('removes the launch profile when the config is cleared, so no orphan is left behind', async () => {
    getRemoteAgentLocation.mockResolvedValue(null);

    await setAgentProviderConfig({ agentId: 'agent-1', config: null });

    expect(updateAgent).toHaveBeenCalledWith({ agentId: 'agent-1', providerConfig: null });
    expect(removeAgentLaunchProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-1' }),
      expect.objectContaining({ dir: '/repo' }),
      'codex.yak'
    );
  });

  it('re-pushes the spec to a remote agent whose watcher is running (auto_session on)', async () => {
    getRemoteAgentLocation.mockResolvedValue({ id: 'loc-1', sshHost: 'vm' });
    listAutoSessionAgentIds.mockResolvedValue(['agent-1']);

    await setAgentProviderConfig({ agentId: 'agent-1', config: CONFIG });

    expect(ensureRemoteWatcher).toHaveBeenCalledWith('agent-1');
  });

  it('skips the re-push for a remote agent with auto_session off (nothing running to refresh)', async () => {
    getRemoteAgentLocation.mockResolvedValue({ id: 'loc-1', sshHost: 'vm' });
    listAutoSessionAgentIds.mockResolvedValue([]);

    await setAgentProviderConfig({ agentId: 'agent-1', config: CONFIG });

    expect(ensureRemoteWatcher).not.toHaveBeenCalled();
  });

  it('surfaces an unreachable VM rather than reporting a save that only half landed', async () => {
    getRemoteAgentLocation.mockResolvedValue({ id: 'loc-1', sshHost: 'vm' });
    listAutoSessionAgentIds.mockResolvedValue(['agent-1']);
    ensureRemoteWatcher.mockRejectedValueOnce(new Error('ssh: connect failed'));

    await expect(setAgentProviderConfig({ agentId: 'agent-1', config: CONFIG })).rejects.toThrow(
      /ssh: connect failed/
    );
  });

  it('throws when the agent does not exist', async () => {
    updateAgent.mockResolvedValueOnce(undefined);

    await expect(setAgentProviderConfig({ agentId: 'ghost', config: CONFIG })).rejects.toThrow(
      /No agent with id ghost/
    );
  });
});
