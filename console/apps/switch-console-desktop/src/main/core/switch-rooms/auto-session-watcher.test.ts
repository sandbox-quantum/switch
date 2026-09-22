import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  apply: vi.fn(),
  configure: vi.fn(),
  dispose: vi.fn(async () => {}),
  agents: vi.fn(),
  agentById: vi.fn(),
  autoSessionIds: vi.fn(),
  setAutoSessionAgent: vi.fn(),
}));
vi.mock('@main/core/sdk-host/shared-watcher', () => ({
  applyControllerState: mocks.apply,
  configureSharedWatcher: mocks.configure,
}));
vi.mock('@main/core/sdk-host/local-host', () => ({ disposeLocalHosts: mocks.dispose }));
vi.mock('@main/core/agents/getAgents', () => ({ getAgents: mocks.agents }));
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: mocks.agentById }));
vi.mock('./auto-session-store', () => ({
  listAutoSessionAgentIds: mocks.autoSessionIds,
  listAutoSessionSubagents: async () => [],
  setAutoSessionAgent: mocks.setAutoSessionAgent,
  setAutoSessionSubagent: vi.fn(),
}));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn() } }));
const { autoSessionWatcher } = await import('./auto-session-watcher');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.autoSessionIds.mockResolvedValue([]);
  mocks.agentById.mockResolvedValue({ id: 'agent' });
  mocks.agents.mockResolvedValue([
    { id: 'linked', switchAgentId: 'switch-1' },
    { id: 'unlinked', switchAgentId: null },
  ]);
});

it('gives every Switch-linked agent a controller at boot, and only those', async () => {
  await autoSessionWatcher.initialize();
  expect(mocks.apply.mock.calls).toEqual([['linked', 'restore']]);
});

it('restores controllers at boot rather than asking for one back', async () => {
  await autoSessionWatcher.initialize();
  // A displaced controller stood down because another client took this agent's
  // connection. Booting Console is not somebody asking for it back, so the
  // sweep must not clear that and start the two trading the connection.
  expect(mocks.apply).toHaveBeenCalledWith('linked', 'restore');
});

it('keeps sweeping when one agent’s controller cannot start', async () => {
  mocks.agents.mockResolvedValue([
    { id: 'broken', switchAgentId: 'switch-1' },
    { id: 'linked', switchAgentId: 'switch-2' },
  ]);
  mocks.apply.mockRejectedValueOnce(new Error('Host unreachable'));
  await autoSessionWatcher.initialize();
  expect(mocks.apply).toHaveBeenCalledWith('linked', 'restore');
});

it('drops a deleted agent from the automatic-session mirror', async () => {
  mocks.autoSessionIds.mockResolvedValue(['gone']);
  mocks.agentById.mockResolvedValue(null);
  await autoSessionWatcher.initialize();
  expect(mocks.setAutoSessionAgent).toHaveBeenCalledWith('gone', false);
});

it('applies the saved settings when asked to reconcile an agent', async () => {
  await autoSessionWatcher.reconcile('agent');
  expect(mocks.apply).toHaveBeenCalledWith('agent', 'explicit');
});

it('stops everything it hosts when Console closes', async () => {
  await autoSessionWatcher.dispose();
  expect(mocks.dispose).toHaveBeenCalled();
});
