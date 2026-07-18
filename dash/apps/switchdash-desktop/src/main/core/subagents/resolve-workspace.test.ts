import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@shared/core/agents/agents';
import type { Location } from '@shared/core/locations/locations';

const getAgentById = vi.hoisted(() => vi.fn());
const getRemoteAgentLocation = vi.hoisted(() => vi.fn());
const getLocationById = vi.hoisted(() => vi.fn());
const ensureSshConnected = vi.hoisted(() => vi.fn(async () => ({ proxy: true })));
const sshClose = vi.hoisted(() => vi.fn());
const SshFileSystemCtor = vi.hoisted(() => vi.fn());
const createPluginFs = vi.hoisted(() => vi.fn((root: string) => ({ __local: root })));
const createRemotePluginFs = vi.hoisted(() => vi.fn(() => ({ __remote: true })));

vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById }));
vi.mock('@main/core/agents/agent-location', () => ({ getRemoteAgentLocation }));
vi.mock('@main/core/locations/store', () => ({ getLocationById }));
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({ ensureSshConnected }));
vi.mock('@main/core/fs/impl/ssh-fs', () => ({
  SshFileSystem: vi.fn(function (this: Record<string, unknown>, proxy: unknown, root: unknown) {
    SshFileSystemCtor(proxy, root);
    this.close = sshClose;
  }),
}));
vi.mock('@main/core/providers/plugin-fs', () => ({ createPluginFs }));
vi.mock('@main/core/providers/remote-plugin-fs', () => ({ createRemotePluginFs }));

const { resolveSubagentWorkspace, openRemoteSubagentFs } = await import('./resolve-workspace');

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: 'agent-1',
    locationId: 'loc-1',
    name: 'parent',
    providerId: 'claude',
    switchAgentId: 'sw-1',
    apiEndpoint: 'https://switch.example.com',
    serverId: 'srv-1',
    status: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function location(overrides: Partial<Location>): Location {
  return {
    id: 'loc-1',
    name: 'parent',
    sshHost: null,
    dir: '/local/proj',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('resolveSubagentWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createPluginFs.mockImplementation((root: string) => ({ __local: root }));
    createRemotePluginFs.mockReturnValue({ __remote: true });
    getRemoteAgentLocation.mockResolvedValue(null);
  });

  it('throws when the agent does not exist', async () => {
    getAgentById.mockResolvedValueOnce(undefined);
    await expect(resolveSubagentWorkspace('missing')).rejects.toThrow(/No agent with id missing/);
  });

  it('resolves a local agent to its location dir on disk', async () => {
    getAgentById.mockResolvedValueOnce(agent({}));
    getRemoteAgentLocation.mockResolvedValueOnce(null);
    getLocationById.mockResolvedValueOnce(location({ dir: '/local/proj' }));

    const ws = await resolveSubagentWorkspace('agent-1');

    expect(createPluginFs).toHaveBeenCalledWith('/local/proj');
    expect(ws.fs).toEqual({ __local: '/local/proj' });
    expect(ensureSshConnected).not.toHaveBeenCalled();
    // close is a no-op for local — must not throw.
    expect(() => ws.close()).not.toThrow();
  });

  it('throws when a local agent has no location on disk', async () => {
    getAgentById.mockResolvedValueOnce(agent({}));
    getRemoteAgentLocation.mockResolvedValueOnce(null);
    getLocationById.mockResolvedValueOnce(undefined);
    await expect(resolveSubagentWorkspace('agent-1')).rejects.toThrow(/no location on disk/);
  });

  it('resolves a remote agent over SFTP and closes the channel', async () => {
    getAgentById.mockResolvedValueOnce(agent({ locationId: 'loc-remote' }));
    getRemoteAgentLocation.mockResolvedValueOnce(
      location({ id: 'loc-remote', sshHost: 'box', dir: '/home/dev/r' }) as Location & {
        sshHost: string;
      }
    );

    const ws = await resolveSubagentWorkspace('agent-1');

    expect(ensureSshConnected).toHaveBeenCalledWith('agent-ssh:box', 'box');
    expect(SshFileSystemCtor).toHaveBeenCalledWith(expect.anything(), '/home/dev/r');
    expect(createRemotePluginFs).toHaveBeenCalledTimes(1);
    expect(ws.fs).toEqual({ __remote: true });
    // Home scope is empty for remote agents.
    expect(await ws.homeFs.list('.')).toEqual([]);

    ws.close();
    expect(sshClose).toHaveBeenCalledTimes(1);
  });
});

describe('openRemoteSubagentFs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createRemotePluginFs.mockReturnValue({ __remote: true });
  });

  it('connects over SSH, roots a remote plugin fs at the repo dir, and closes it', async () => {
    const { fs, close } = await openRemoteSubagentFs('box', '/home/dev/r');

    expect(ensureSshConnected).toHaveBeenCalledWith('agent-ssh:box', 'box');
    expect(SshFileSystemCtor).toHaveBeenCalledWith(expect.anything(), '/home/dev/r');
    expect(fs).toEqual({ __remote: true });

    close();
    expect(sshClose).toHaveBeenCalledTimes(1);
  });
});
