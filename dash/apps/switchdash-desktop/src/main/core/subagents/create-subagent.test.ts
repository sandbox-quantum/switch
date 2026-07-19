import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlugin = vi.hoisted(() => vi.fn());
const getServer = vi.hoisted(() => vi.fn());
const registerSubagentsCore = vi.hoisted(() => vi.fn());
const resolveSubagentFs = vi.hoisted(() => vi.fn());
const applyLocalSubagentAutoSessionState = vi.hoisted(() => vi.fn(async () => {}));
const getRemoteAgentLocation = vi.hoisted(() => vi.fn(async () => null));
const logWarn = vi.hoisted(() => vi.fn());

vi.mock('@main/core/providers/plugin-registry', () => ({ getPlugin }));
vi.mock('@main/core/switch-servers/servers-store', () => ({ getServer }));
vi.mock('@main/core/agents/agent-location', () => ({ getRemoteAgentLocation }));
vi.mock('./register-subagents', () => ({ registerSubagentsCore }));
vi.mock('./resolve-subagent-fs', () => ({ resolveSubagentFs }));
vi.mock('./setSubagentAutoSession', () => ({ applyLocalSubagentAutoSessionState }));
vi.mock('@main/lib/logger', () => ({ log: { warn: logWarn, error: vi.fn() } }));

const { createSubagent } = await import('./create-subagent');

const behavior = {
  readDefinition: vi.fn(),
  writeDefinition: vi.fn(async () => {}),
  removeLocal: vi.fn(async () => {}),
};

function mockSubagentFs(agent: Record<string, unknown>) {
  resolveSubagentFs.mockResolvedValue({ agent, fs: {}, close: vi.fn() });
}

const LOCAL_PARENT = {
  id: 'local-parent',
  providerId: 'claude',
  serverId: 'srv-1',
  switchAgentId: 'sw-parent',
  locationId: 'loc-1',
};

const PARAMS = {
  parentAgentId: 'local-parent',
  attributes: { name: 'code-reviewer', description: 'reviews' },
};

describe('createSubagent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlugin.mockReturnValue({ behavior: { subagents: behavior } });
    getServer.mockResolvedValue({ id: 'srv-1', apiUrl: 'https://switch.example.com' });
    behavior.readDefinition.mockResolvedValue(null);
    registerSubagentsCore.mockResolvedValue({ registered: ['code-reviewer'] });
    getRemoteAgentLocation.mockResolvedValue(null);
  });

  it('registers with auto_session on and starts the watcher for a local parent', async () => {
    mockSubagentFs(LOCAL_PARENT);

    const result = await createSubagent(PARAMS);

    expect(registerSubagentsCore).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSwitchAgentId: 'sw-parent',
        subagents: [{ name: 'code-reviewer', description: 'reviews' }],
        autoSession: true,
      })
    );
    expect(applyLocalSubagentAutoSessionState).toHaveBeenCalledWith(
      'local-parent',
      'code-reviewer',
      true
    );
    expect(result).toEqual({ name: 'code-reviewer' });
  });

  it('registers with auto_session off and starts no watcher for a remote parent', async () => {
    mockSubagentFs(LOCAL_PARENT);
    getRemoteAgentLocation.mockResolvedValueOnce({
      id: 'loc-remote',
      name: 'r',
      sshHost: 'vm',
      dir: '/home/dev/r',
      createdAt: '',
      updatedAt: '',
    } as never);

    await createSubagent(PARAMS);

    expect(registerSubagentsCore).toHaveBeenCalledWith(
      expect.objectContaining({ autoSession: false })
    );
    expect(applyLocalSubagentAutoSessionState).not.toHaveBeenCalled();
  });

  it('does not fail creation when starting the watcher fails', async () => {
    mockSubagentFs(LOCAL_PARENT);
    applyLocalSubagentAutoSessionState.mockRejectedValueOnce(new Error('watcher boom'));

    const result = await createSubagent(PARAMS);

    expect(result).toEqual({ name: 'code-reviewer' });
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining('failed to start auto_session watcher'),
      expect.objectContaining({ name: 'code-reviewer' })
    );
  });

  it('removes the written definition when registration fails', async () => {
    mockSubagentFs(LOCAL_PARENT);
    registerSubagentsCore.mockRejectedValueOnce(new Error('gateway boom'));

    await expect(createSubagent(PARAMS)).rejects.toThrow('gateway boom');

    expect(behavior.removeLocal).toHaveBeenCalledWith({}, 'code-reviewer');
    expect(applyLocalSubagentAutoSessionState).not.toHaveBeenCalled();
  });
});
