import { expect, it, vi } from 'vitest';
import { autoSessionWatcher } from './auto-session-watcher';
const configure = vi.hoisted(() => vi.fn());
vi.mock('@main/core/sdk-host/shared-watcher', () => ({ configureSharedWatcher: configure }));
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: async () => ({ id: 'agent' }) }));
vi.mock('./auto-session-store', () => ({
  listAutoSessionAgentIds: async () => ['agent'],
  listAutoSessionSubagents: async () => [],
  setAutoSessionAgent: vi.fn(),
  setAutoSessionSubagent: vi.fn(),
}));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn() } }));
it('starts persistent watchers and leaves them running when Console closes', async () => {
  await autoSessionWatcher.initialize();
  expect(configure).toHaveBeenCalledWith('agent', true);
  configure.mockClear();
  autoSessionWatcher.dispose();
  expect(configure).not.toHaveBeenCalled();
  await autoSessionWatcher.reconcile('agent', false);
  expect(configure).toHaveBeenCalledWith('agent', false);
});
