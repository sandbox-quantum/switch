import { beforeEach, describe, expect, it, vi } from 'vitest';

const getLocationById = vi.hoisted(() => vi.fn());
const getAgents = vi.hoisted(() => vi.fn());
const createAgent = vi.hoisted(() => vi.fn(async () => ({})));
const getPlugin = vi.hoisted(() => vi.fn());
const discoverLocal = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());

vi.mock('@main/core/locations/store', () => ({ getLocationById }));
vi.mock('@main/core/agents/getAgents', () => ({ getAgents }));
vi.mock('@main/core/agents/createAgent', () => ({ createAgent }));
vi.mock('@main/core/providers/plugin-registry', () => ({ getPlugin }));
vi.mock('@main/core/providers/plugin-fs', () => ({ createPluginFs: () => ({}) }));
vi.mock('@main/lib/logger', () => ({ log: { warn: logWarn, error: vi.fn() } }));

const { reconcileAgentRowsForLocation } = await import('./reconcile-agent-rows');

const LOCAL_LOCATION = { id: 'loc-1', name: 'repo', sshHost: null, dir: '/home/dev/repo' };

function parent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'parent-1',
    locationId: 'loc-1',
    name: 'main',
    providerId: 'claude',
    definitionName: null,
    switchAgentId: 'sw-parent',
    apiEndpoint: 'https://switch.example.com',
    serverId: 'srv-1',
    ...overrides,
  };
}

describe('reconcileAgentRowsForLocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLocationById.mockResolvedValue(LOCAL_LOCATION);
    getPlugin.mockReturnValue({ behavior: { subagents: { discoverLocal } } });
    discoverLocal.mockResolvedValue([]);
  });

  it('creates an agent row for a discovered subagent not yet represented', async () => {
    getAgents.mockResolvedValue([parent()]);
    discoverLocal.mockResolvedValue([
      {
        name: 'code-reviewer',
        description: 'reviews',
        model: null,
        switchAgentId: 'sw-child',
        apiEndpoint: 'https://switch.example.com',
      },
    ]);

    const result = await reconcileAgentRowsForLocation('loc-1');

    expect(result).toEqual({ created: 1 });
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        locationId: 'loc-1',
        name: 'code-reviewer',
        providerId: 'claude',
        definitionName: 'code-reviewer',
        switchAgentId: 'sw-child',
        serverId: 'srv-1',
        autoApprove: false,
      })
    );
  });

  it('is idempotent: skips subagents already represented by definitionName', async () => {
    getAgents.mockResolvedValue([
      parent(),
      {
        ...parent({ id: 'sub-1', name: 'code-reviewer' }),
        definitionName: 'code-reviewer',
        switchAgentId: 'sw-child',
      },
    ]);
    discoverLocal.mockResolvedValue([
      {
        name: 'code-reviewer',
        description: null,
        model: null,
        switchAgentId: 'sw-child',
        apiEndpoint: null,
      },
    ]);

    const result = await reconcileAgentRowsForLocation('loc-1');

    expect(result).toEqual({ created: 0 });
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('skips remote locations (their dir lives on the SSH host)', async () => {
    getLocationById.mockResolvedValue({ ...LOCAL_LOCATION, sshHost: 'vm' });

    const result = await reconcileAgentRowsForLocation('loc-1');

    expect(result).toEqual({ created: 0 });
    expect(getAgents).not.toHaveBeenCalled();
  });

  it('does not seed from an unlinked parent (no server)', async () => {
    getAgents.mockResolvedValue([parent({ serverId: null })]);
    discoverLocal.mockResolvedValue([
      {
        name: 'code-reviewer',
        description: null,
        model: null,
        switchAgentId: 'sw-child',
        apiEndpoint: null,
      },
    ]);

    const result = await reconcileAgentRowsForLocation('loc-1');

    expect(result).toEqual({ created: 0 });
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('degrades when discovery throws, without failing the reconcile', async () => {
    getAgents.mockResolvedValue([parent()]);
    discoverLocal.mockRejectedValue(new Error('unreadable dir'));

    const result = await reconcileAgentRowsForLocation('loc-1');

    expect(result).toEqual({ created: 0 });
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining('local discovery failed'),
      expect.objectContaining({ parentAgentId: 'parent-1' })
    );
  });
});
