import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How discovery treats the directories a shared server names (CHOO-2893): each
 * agent comes in the way this account can reach it — loaded from disk where it
 * can read the directory, followed through the server where another account
 * holds it, and not offered where the directory is not on this host.
 */

const getServer = vi.hoisted(() => vi.fn());
const fetchAgents = vi.hoisted(() => vi.fn());
const fetchMe = vi.hoisted(() => vi.fn());
const discoverConfiguredAgents = vi.hoisted(() => vi.fn());
const getAgents = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const probeDirAccess = vi.hoisted(() => vi.fn());
const hostHomes = vi.hoisted(() => vi.fn());

vi.mock('@main/core/switch-servers/servers-store', () => ({ getServer }));
vi.mock('@main/core/switch-servers/gateway-client', () => ({ fetchAgents, fetchMe }));
vi.mock('./discover-configured-agents', () => ({ discoverConfiguredAgents }));
vi.mock('./getAgents', () => ({ getAgents }));
vi.mock('./observed-agents', () => ({ probeDirAccess, hostHomes }));
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({ ensureSshConnected: vi.fn() }));
vi.mock('@main/core/execution-context/ssh-execution-context', () => ({
  SshExecutionContext: class {},
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn() } }));

const { discoverLoadableAgentsOnHost } = await import('./discover-loadable-agents');

const SERVER = { id: 'srv-1', name: 'Team', apiUrl: 'http://localhost:41001' };

function remote(id: string, name: string, dir: string, type = 'claude-code') {
  return {
    id,
    name,
    displayName: null,
    description: `${name} agent`,
    connectorType: 'known',
    ownerId: 'admin-id',
    ownerName: 'Admin',
    knownAgentType: type,
    knownAgentOptions: { repo_dir: dir },
    addressingPolicy: null,
    iconUrl: null,
    createdAt: '',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getServer.mockResolvedValue(SERVER);
  fetchMe.mockResolvedValue({ id: 'admin-id' });
  getAgents.mockResolvedValue([]);
  hostHomes.mockResolvedValue([
    { account: 'alice', home: '/home/alice' },
    { account: 'bob', home: '/home/bob' },
  ]);
});

describe('discoverLoadableAgentsOnHost on a shared host', () => {
  it('loads what this account can read, follows what it cannot, and skips what is elsewhere', async () => {
    fetchAgents.mockResolvedValue([
      remote('mine', 'builder', '/home/bob/builder'),
      remote('theirs', 'reviewer', '/home/alice/reviewer'),
      remote('laptop', 'local-helper', '/Users/carol/helper'),
    ]);
    probeDirAccess.mockResolvedValue(
      new Map([
        ['/home/bob/builder', 'readable'],
        ['/home/alice/reviewer', 'denied'],
        ['/Users/carol/helper', 'missing'],
      ])
    );
    discoverConfiguredAgents.mockResolvedValue([
      {
        name: 'builder',
        switchAgentId: 'mine',
        apiEndpoint: 'http://localhost:41001',
        providerId: 'claude',
        providerSource: 'definition',
        alreadyAgent: false,
      },
    ]);

    const { agents } = await discoverLoadableAgentsOnHost({ sshHost: 'vm-1', serverId: 'srv-1' });

    expect(agents).toHaveLength(2);
    expect(agents.find((a) => a.name === 'builder')).toMatchObject({
      observed: false,
      observedOwner: null,
      providerSource: 'definition',
      blockedReason: null,
    });
    expect(agents.find((a) => a.name === 'reviewer')).toMatchObject({
      dir: '/home/alice/reviewer',
      switchAgentId: 'theirs',
      apiEndpoint: 'http://localhost:41001',
      providerId: 'claude',
      providerSource: 'server',
      observed: true,
      observedOwner: 'alice',
      viewerIsOwner: true,
      blockedReason: null,
    });
    // The other account's directory is never scanned.
    expect(discoverConfiguredAgents).toHaveBeenCalledOnce();
    expect(discoverConfiguredAgents).toHaveBeenCalledWith(
      expect.objectContaining({ dir: '/home/bob/builder' })
    );
  });

  it('follows the agents of a readable directory whose files it cannot read', async () => {
    fetchAgents.mockResolvedValue([remote('theirs', 'reviewer', '/srv/shared/reviewer')]);
    probeDirAccess.mockResolvedValue(new Map([['/srv/shared/reviewer', 'readable']]));
    discoverConfiguredAgents.mockRejectedValue(new Error('Permission denied'));

    const { agents } = await discoverLoadableAgentsOnHost({ sshHost: 'vm-1', serverId: 'srv-1' });

    expect(agents).toEqual([
      expect.objectContaining({ name: 'reviewer', observed: true, observedOwner: null }),
    ]);
  });

  it('marks an agent this Console already follows', async () => {
    fetchAgents.mockResolvedValue([remote('theirs', 'reviewer', '/home/alice/reviewer')]);
    probeDirAccess.mockResolvedValue(new Map([['/home/alice/reviewer', 'denied']]));
    getAgents.mockResolvedValue([{ serverId: 'srv-1', switchAgentId: 'theirs' }]);

    const { agents } = await discoverLoadableAgentsOnHost({ sshHost: 'vm-1', serverId: 'srv-1' });

    expect(agents[0]).toMatchObject({
      alreadyAgent: true,
      blockedReason: 'Already loaded in this Console',
    });
  });

  it('cannot offer an agent of a type this build does not know', async () => {
    fetchAgents.mockResolvedValue([
      remote('theirs', 'reviewer', '/home/alice/reviewer', 'mystery'),
    ]);
    probeDirAccess.mockResolvedValue(new Map([['/home/alice/reviewer', 'denied']]));

    const { agents } = await discoverLoadableAgentsOnHost({ sshHost: 'vm-1', serverId: 'srv-1' });

    expect(agents[0]).toMatchObject({ providerId: null, providerSource: 'unknown' });
    expect(agents[0]!.blockedReason).toMatch(/mystery agent/);
  });

  it('keeps the old behaviour when the host cannot be asked about access', async () => {
    fetchAgents.mockResolvedValue([remote('mine', 'builder', '/home/bob/builder')]);
    probeDirAccess.mockRejectedValue(new Error('ssh dropped'));
    discoverConfiguredAgents.mockResolvedValue([]);

    await discoverLoadableAgentsOnHost({ sshHost: 'vm-1', serverId: 'srv-1' });

    expect(discoverConfiguredAgents).toHaveBeenCalledOnce();
    expect(hostHomes).not.toHaveBeenCalled();
  });
});
