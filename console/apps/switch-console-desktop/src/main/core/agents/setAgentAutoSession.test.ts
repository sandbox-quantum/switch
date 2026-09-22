import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const state: { agent: Record<string, unknown> | null; sshHost: string | null } = {
    agent: null,
    sshHost: null,
  };
  return {
    calls,
    state,
    setAutoSession: vi.fn(async () => void calls.push('gateway')),
    setAutoSessionAgent: vi.fn(async () => void calls.push('mirror')),
    reconcile: vi.fn(async () => void calls.push('controller')),
    ensureRemoteWatcher: vi.fn(async () => void calls.push('controller')),
  };
});

vi.mock('@main/core/switch-rooms/auto-session-store', () => ({
  listAutoSessionAgentIds: vi.fn(async () => []),
  setAutoSessionAgent: h.setAutoSessionAgent,
}));
vi.mock('@main/core/switch-rooms/auto-session-watcher', () => ({
  autoSessionWatcher: { reconcile: h.reconcile },
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  fetchAgentOptions: vi.fn(),
  setAutoSession: h.setAutoSession,
  GatewayError: class GatewayError extends Error {},
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  getServer: vi.fn(async () => ({ id: 'server-1' })),
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./agent-location', () => ({ getRemoteAgentLocation: async () => h.state.sshHost }));
vi.mock('./getAgentById', () => ({ getAgentById: async () => h.state.agent }));
vi.mock('./remote-watcher', () => ({ ensureRemoteWatcher: h.ensureRemoteWatcher }));

import { setAgentAutoSession } from './setAgentAutoSession';

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.length = 0;
  h.state.sshHost = null;
  h.state.agent = { id: 'agent-1', serverId: 'server-1', switchAgentId: 'switch-1' };
});

it('makes the controller spawn-capable before claiming the profile that promises a session', async () => {
  await setAgentAutoSession({ agentId: 'agent-1', enabled: true });

  expect(h.calls).toEqual(['mirror', 'controller', 'gateway']);
});

it('gives up the promise before standing the controller down', async () => {
  await setAgentAutoSession({ agentId: 'agent-1', enabled: false });

  expect(h.calls).toEqual(['gateway', 'mirror', 'controller']);
});

it('leaves the profile alone when a remote controller cannot be told it may spawn', async () => {
  // The profile is what the server answers an addressed agent on: claiming
  // auto_session over a controller that never heard would promise a session
  // nothing is going to start, and an unreachable host leaves it promising.
  h.state.sshHost = 'host';
  h.ensureRemoteWatcher.mockRejectedValueOnce(new Error('Host unreachable'));

  await expect(setAgentAutoSession({ agentId: 'agent-1', enabled: true })).rejects.toThrow(
    'Host unreachable'
  );
  expect(h.setAutoSession).not.toHaveBeenCalled();
});
