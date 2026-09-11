import { expect, it, vi } from 'vitest';
import { initializeRemoteDiscovery } from './remote-watcher';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  handlers: new Map<string, (value: unknown) => void>(),
}));
vi.mock('./agent-events', () => ({
  agentEvents: {
    on: (name: string, handler: (value: unknown) => void) => mocks.handlers.set(name, handler),
  },
}));
vi.mock('./remote-session-reconciler', () => ({
  remoteSessionReconciler: { start: mocks.start, stop: mocks.stop },
}));
vi.mock('./getAgents', () => ({
  getAgents: async () => [{ id: 'existing', switchAgentId: 'registered' }],
}));
vi.mock('./getAgentById', () => ({ getAgentById: vi.fn() }));
vi.mock('@main/core/sdk-host/shared-watcher', () => ({ configureSharedWatcher: vi.fn() }));
vi.mock('@main/core/switch-rooms/auto-session-store', () => ({ listAutoSessionAgentIds: vi.fn() }));

it('discovers existing and newly onboarded agents and stops removed identities', async () => {
  await initializeRemoteDiscovery();
  expect(mocks.start).toHaveBeenCalledWith('existing');
  mocks.handlers.get('agent:created')!({
    id: 'new-local',
    switchAgentId: 'registered',
    serverId: 'server',
  });
  expect(mocks.start).toHaveBeenCalledWith('new-local');
  mocks.handlers.get('agent:updated')!({ id: 'new-local', switchAgentId: null });
  expect(mocks.stop).toHaveBeenCalledWith('new-local');
  mocks.handlers.get('agent:updated')!({ id: 'missing-server', switchAgentId: 'registered' });
  expect(mocks.start).toHaveBeenCalledWith('missing-server');
  mocks.handlers.get('agent:deleted')!('existing');
  expect(mocks.stop).toHaveBeenCalledWith('existing');
});
