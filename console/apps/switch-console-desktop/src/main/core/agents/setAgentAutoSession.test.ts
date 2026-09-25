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
vi.mock('./observed-guard', () => ({
  // Every agent in these cases is one this Console runs (CHOO-2893).
  locationWhereAgentRuns: async () => ({ sshHost: h.state.sshHost, dir: '/work', observed: false }),
}));
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

it('leaves a spawn-capable controller unclaimed when the profile cannot be set', async () => {
  // The other half-applied enable. The toggle did not take, and it says so, but
  // what is left over is a controller that would start a session under a
  // profile that does not promise one — the server asks the connection there,
  // so nothing is claimed that cannot be kept.
  h.setAutoSession.mockImplementationOnce(async () => {
    h.calls.push('gateway');
    throw new Error('Gateway unreachable');
  });

  await expect(setAgentAutoSession({ agentId: 'agent-1', enabled: true })).rejects.toThrow(
    'Gateway unreachable'
  );
  expect(h.calls).toEqual(['mirror', 'controller', 'gateway']);
});

it('gives the promise up even when the controller cannot then be stood down', async () => {
  // Disabling, with the second step failing. The profile has already stopped
  // promising a session, so the leftover is a controller that may still start
  // one nobody was told to expect — the direction that does not lie to a room.
  h.state.sshHost = 'host';
  h.ensureRemoteWatcher.mockImplementationOnce(async () => {
    h.calls.push('controller');
    throw new Error('Host unreachable');
  });

  await expect(setAgentAutoSession({ agentId: 'agent-1', enabled: false })).rejects.toThrow(
    'Host unreachable'
  );
  expect(h.setAutoSession).toHaveBeenCalledWith({ id: 'server-1' }, 'switch-1', false);
  expect(h.calls).toEqual(['gateway', 'mirror', 'controller']);
});
