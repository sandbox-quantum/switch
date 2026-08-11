import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  launchProfilePaths: vi.fn((p: { slug: string; workingDir: string }) => [
    `.codex/${p.slug}-digest.config.toml`,
  ]),
  mcp: undefined as { launchProfilePaths?: unknown } | undefined,
  localDelete: vi.fn(async () => undefined),
  remoteDelete: vi.fn(async () => undefined),
  connectRemoteAgent: vi.fn(async () => ({ ctx: { exec: vi.fn() } })),
}));

vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: () => ({ behavior: { mcp: h.mcp } }),
}));
vi.mock('@main/core/providers/plugin-fs', () => ({
  createPluginFs: () => ({ delete: h.localDelete }),
}));
vi.mock('@main/core/agent-runtime/impl/remote-home-plugin-fs', () => ({
  createRemoteHomePluginFs: () => ({ delete: h.remoteDelete }),
}));
vi.mock('./connect-remote-agent', () => ({ connectRemoteAgent: h.connectRemoteAgent }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { removeAgentLaunchProfile } from './remove-launch-profile';

const agent = { id: 'a1', providerId: 'codex', name: 'codex-hoot' } as never;
const localLocation = { sshHost: null, dir: '/repo' } as never;
const remoteLocation = { sshHost: 'vm', dir: '/home/agent/repo' } as never;

describe('removeAgentLaunchProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.mcp = { launchProfilePaths: h.launchProfilePaths };
  });

  it('deletes the profile from the local home for a local agent', async () => {
    await removeAgentLaunchProfile(agent, localLocation, 'codex-hoot');

    expect(h.launchProfilePaths).toHaveBeenCalledWith({
      slug: 'codex-hoot',
      workingDir: '/repo',
    });
    expect(h.localDelete).toHaveBeenCalledWith('.codex/codex-hoot-digest.config.toml');
    expect(h.connectRemoteAgent).not.toHaveBeenCalled();
  });

  it('deletes the profile from the VM home for a remote agent', async () => {
    await removeAgentLaunchProfile(agent, remoteLocation, 'codex-hoot');

    // Reaches the VM home over the exec-backed remote FS, not the no-op stub.
    expect(h.connectRemoteAgent).toHaveBeenCalledWith(agent);
    expect(h.remoteDelete).toHaveBeenCalledWith('.codex/codex-hoot-digest.config.toml');
    expect(h.localDelete).not.toHaveBeenCalled();
  });

  it('uses the passed slug (the old name on rename), not the agent name', async () => {
    await removeAgentLaunchProfile(agent, localLocation, 'old-name');
    expect(h.localDelete).toHaveBeenCalledWith('.codex/old-name-digest.config.toml');
  });

  it('does nothing for a provider that writes no launch profile', async () => {
    h.mcp = {};
    await removeAgentLaunchProfile(agent, remoteLocation, 'codex-hoot');
    expect(h.connectRemoteAgent).not.toHaveBeenCalled();
    expect(h.localDelete).not.toHaveBeenCalled();
    expect(h.remoteDelete).not.toHaveBeenCalled();
  });

  it('logs and returns without throwing when the remote home cannot be reached', async () => {
    h.connectRemoteAgent.mockRejectedValueOnce(new Error('vm unreachable'));
    await expect(
      removeAgentLaunchProfile(agent, remoteLocation, 'codex-hoot')
    ).resolves.toBeUndefined();
    expect(h.remoteDelete).not.toHaveBeenCalled();
  });
});
