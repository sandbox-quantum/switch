import { expect, it, vi } from 'vitest';
import { autoSessionWatcher } from './auto-session-watcher';
const configure = vi.hoisted(() => vi.fn());
const dispose = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@main/core/sdk-host/shared-watcher', () => ({ configureSharedWatcher: configure }));
vi.mock('@main/core/sdk-host/local-host', () => ({ disposeLocalHosts: dispose }));
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: async () => ({ id: 'agent' }) }));
vi.mock('./auto-session-store', () => ({
  listAutoSessionAgentIds: async () => ['agent'],
  listAutoSessionSubagents: async () => [],
  setAutoSessionAgent: vi.fn(),
  setAutoSessionSubagent: vi.fn(),
}));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn() } }));

it('starts watchers for saved agents and reconciles them off on request', async () => {
  await autoSessionWatcher.initialize();
  expect(configure).toHaveBeenCalledWith('agent', true);
  configure.mockClear();
  await autoSessionWatcher.reconcile('agent', false);
  expect(configure).toHaveBeenCalledWith('agent', false);
});

it('stops everything it hosts when Console closes', async () => {
  await autoSessionWatcher.dispose();
  expect(dispose).toHaveBeenCalled();
});
