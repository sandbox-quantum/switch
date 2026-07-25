import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlugin = vi.hoisted(() => vi.fn());
const getServer = vi.hoisted(() => vi.fn());
const registerSubagentsBulk = vi.hoisted(() => vi.fn());
const parseSwitchAgentCredentials = vi.hoisted(() => vi.fn());
const readSwitchAgentCredentials = vi.hoisted(() => vi.fn());
const openRemoteSubagentFs = vi.hoisted(() => vi.fn());
const writeSettings = vi.hoisted(() => vi.fn(async () => {}));
const remoteClose = vi.hoisted(() => vi.fn());
const remoteRead = vi.hoisted(() => vi.fn());
const getAgents = vi.hoisted(() => vi.fn());
const getLocationByHostDir = vi.hoisted(() => vi.fn());
const reconcileAgentRowsForLocation = vi.hoisted(() => vi.fn(async () => ({ created: 0 })));
const applyLocalSubagentAutoSessionState = vi.hoisted(() => vi.fn(async () => {}));
const logWarn = vi.hoisted(() => vi.fn());

vi.mock('@main/core/providers/plugin-registry', () => ({ getPlugin }));
vi.mock('@main/core/providers/plugin-fs', () => ({ createPluginFs: vi.fn() }));
vi.mock('@main/core/switch-servers/servers-store', () => ({ getServer }));
vi.mock('@main/core/switch-servers/gateway-client', () => ({ registerSubagentsBulk }));
vi.mock('@main/core/switch-rooms/switch-credentials', () => ({
  parseSwitchAgentCredentials,
  readSwitchAgentCredentials,
}));
vi.mock('./resolve-subagent-fs', () => ({ openRemoteSubagentFs }));
vi.mock('./reconcile-agent-rows', () => ({ reconcileAgentRowsForLocation }));
vi.mock('@main/core/agents/getAgents', () => ({ getAgents }));
vi.mock('@main/core/locations/store', () => ({ getLocationByHostDir }));
vi.mock('./setSubagentAutoSession', () => ({ applyLocalSubagentAutoSessionState }));
vi.mock('@main/lib/logger', () => ({ log: { warn: logWarn, error: vi.fn() } }));

const { registerSubagents, registerSubagentsRemote } = await import('./register-subagents');

const REMOTE = {
  providerId: 'claude',
  serverId: 'srv-1',
  sshHost: 'box',
  remoteRepoDir: '/home/dev/r',
};

describe('registerSubagentsRemote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlugin.mockReturnValue({ behavior: { subagents: { writeSettings } } });
    getServer.mockResolvedValue({ id: 'srv-1', apiUrl: 'https://switch.example.com' });
    openRemoteSubagentFs.mockResolvedValue({
      fs: { read: remoteRead },
      close: remoteClose,
    });
  });

  it('returns early without connecting when there are no subagents', async () => {
    const result = await registerSubagentsRemote({ ...REMOTE, subagents: [] });
    expect(result).toEqual({ registered: [] });
    expect(openRemoteSubagentFs).not.toHaveBeenCalled();
  });

  it('reads parent creds from the remote settings, registers, writes creds, and closes', async () => {
    remoteRead.mockResolvedValueOnce('{"env":{"SWITCH_AGENT_ID":"sw-parent"}}');
    parseSwitchAgentCredentials.mockReturnValueOnce({
      agentId: 'sw-parent',
      apiEndpoint: 'https://switch.example.com',
      token: 'tok',
    });
    registerSubagentsBulk.mockResolvedValueOnce([
      { subagentName: 'code-reviewer', id: 'child-1', apiKey: 'key-1' },
    ]);

    const result = await registerSubagentsRemote({
      ...REMOTE,
      subagents: [{ name: 'code-reviewer', description: 'reviews' }],
    });

    expect(remoteRead).toHaveBeenCalledWith('.claude/settings.local.json');
    expect(registerSubagentsBulk).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: 'https://switch.example.com' }),
      {
        parentAgentId: 'sw-parent',
        subagents: [{ subagentName: 'code-reviewer', description: 'reviews' }],
        autoSession: false,
      }
    );
    expect(applyLocalSubagentAutoSessionState).not.toHaveBeenCalled();
    expect(writeSettings).toHaveBeenCalledWith(
      { read: remoteRead },
      expect.objectContaining({
        subagentName: 'code-reviewer',
        apiToken: 'key-1',
        agentId: 'child-1',
      })
    );
    expect(result).toEqual({ registered: ['code-reviewer'] });
    expect(remoteClose).toHaveBeenCalledTimes(1);
  });

  it('fails loud (and still closes) when the remote host has no parent creds', async () => {
    remoteRead.mockResolvedValueOnce(null);
    parseSwitchAgentCredentials.mockReturnValueOnce(null);

    await expect(
      registerSubagentsRemote({
        ...REMOTE,
        subagents: [{ name: 'x', description: 'y' }],
      })
    ).rejects.toThrow(/No Switch agent configured/);

    expect(registerSubagentsBulk).not.toHaveBeenCalled();
    expect(remoteClose).toHaveBeenCalledTimes(1);
  });
});

const LOCAL = {
  providerId: 'claude',
  serverId: 'srv-1',
  dir: '/home/dev/r',
};

describe('registerSubagents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlugin.mockReturnValue({ behavior: { subagents: { writeSettings } } });
    getServer.mockResolvedValue({ id: 'srv-1', apiUrl: 'https://switch.example.com' });
    readSwitchAgentCredentials.mockResolvedValue({
      agentId: 'sw-parent',
      apiEndpoint: 'https://switch.example.com',
      token: 'tok',
    });
  });

  it('registers with auto_session on and starts a watcher per new subagent', async () => {
    registerSubagentsBulk.mockResolvedValueOnce([
      { subagentName: 'code-reviewer', id: 'child-1', apiKey: 'key-1' },
      { subagentName: 'doc-writer', id: 'child-2', apiKey: 'key-2' },
    ]);
    getLocationByHostDir.mockResolvedValueOnce({ id: 'loc-1' });
    getAgents.mockResolvedValueOnce([
      { id: 'local-other', switchAgentId: 'sw-other' },
      { id: 'local-parent', switchAgentId: 'sw-parent' },
    ]);

    const result = await registerSubagents({
      ...LOCAL,
      subagents: [
        { name: 'code-reviewer', description: 'reviews' },
        { name: 'doc-writer', description: 'writes docs' },
      ],
    });

    expect(registerSubagentsBulk).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: 'https://switch.example.com' }),
      expect.objectContaining({ parentAgentId: 'sw-parent', autoSession: true })
    );
    expect(getLocationByHostDir).toHaveBeenCalledWith(null, '/home/dev/r');
    expect(applyLocalSubagentAutoSessionState).toHaveBeenCalledTimes(2);
    expect(applyLocalSubagentAutoSessionState).toHaveBeenCalledWith(
      'local-parent',
      'code-reviewer',
      true
    );
    expect(applyLocalSubagentAutoSessionState).toHaveBeenCalledWith(
      'local-parent',
      'doc-writer',
      true
    );
    expect(result).toEqual({ registered: ['code-reviewer', 'doc-writer'] });
  });

  it('warns instead of failing when no local agent matches the dir', async () => {
    registerSubagentsBulk.mockResolvedValueOnce([
      { subagentName: 'code-reviewer', id: 'child-1', apiKey: 'key-1' },
    ]);
    getLocationByHostDir.mockResolvedValueOnce(undefined);

    const result = await registerSubagents({
      ...LOCAL,
      subagents: [{ name: 'code-reviewer', description: 'reviews' }],
    });

    expect(result).toEqual({ registered: ['code-reviewer'] });
    expect(applyLocalSubagentAutoSessionState).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining('no local agent for dir'),
      expect.objectContaining({ dir: '/home/dev/r' })
    );
  });

  it('does not fail registration when starting a watcher fails', async () => {
    registerSubagentsBulk.mockResolvedValueOnce([
      { subagentName: 'code-reviewer', id: 'child-1', apiKey: 'key-1' },
    ]);
    getLocationByHostDir.mockResolvedValueOnce({ id: 'loc-1' });
    getAgents.mockResolvedValueOnce([{ id: 'local-parent', switchAgentId: 'sw-parent' }]);
    applyLocalSubagentAutoSessionState.mockRejectedValueOnce(new Error('watcher boom'));

    const result = await registerSubagents({
      ...LOCAL,
      subagents: [{ name: 'code-reviewer', description: 'reviews' }],
    });

    expect(result).toEqual({ registered: ['code-reviewer'] });
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining('failed to start auto_session watcher'),
      expect.objectContaining({ name: 'code-reviewer' })
    );
  });
});
