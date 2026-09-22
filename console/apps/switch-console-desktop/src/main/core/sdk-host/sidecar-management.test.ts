import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  setAutoSession: vi.fn(),
  list: vi.fn(),
  agent: vi.fn(),
  remote: vi.fn(),
}));
vi.mock('@main/core/agents/setAgentAutoSession', () => ({
  setAgentAutoSession: mocks.setAutoSession,
}));
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: mocks.agent }));
vi.mock('@main/core/agents/agent-location', () => ({ getRemoteAgentLocation: mocks.remote }));
vi.mock('@main/core/switch-rooms/auto-session-store', () => ({
  listAutoSessionAgentIds: mocks.list,
}));
vi.mock('./shared-watcher', () => ({ configureSharedWatcher: mocks.configure }));
const { manageAgentSidecar } = await import('./sidecar-management');
beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue(['agent']);
  mocks.configure.mockResolvedValue(undefined);
  mocks.setAutoSession.mockResolvedValue(undefined);
  mocks.agent.mockResolvedValue({ id: 'agent', locationId: 'location' });
  mocks.remote.mockResolvedValue({ sshHost: 'builder' });
});
it.each(['update', 'restart'] as const)(
  '%s waits for the old watcher to stop before starting the new bundle',
  async (action) => {
    let finish!: () => void;
    mocks.configure.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const pending = manageAgentSidecar('agent', action);
    await vi.waitFor(() => expect(mocks.configure).toHaveBeenCalledWith('agent', false));
    expect(mocks.configure).toHaveBeenCalledTimes(1);
    finish();
    await pending;
    expect(mocks.configure.mock.calls).toEqual([
      ['agent', false],
      ['agent', true],
    ]);
    expect(mocks.setAutoSession).not.toHaveBeenCalled();
  }
);
it('does not start a competing watcher if stopping fails', async () => {
  mocks.configure.mockRejectedValueOnce(new Error('Still running'));
  await expect(manageAgentSidecar('agent', 'restart')).rejects.toThrow('Still running');
  expect(mocks.configure).toHaveBeenCalledTimes(1);
});
it.each([
  ['start', true],
  ['stop', false],
] as const)('%s updates the persistent automatic-session preference', async (action, enabled) => {
  await manageAgentSidecar('agent', action);
  expect(mocks.setAutoSession).toHaveBeenCalledWith({ agentId: 'agent', enabled });
  expect(mocks.configure).not.toHaveBeenCalled();
});
it('refuses to update a local agent, which has no deployed sidecar', async () => {
  mocks.remote.mockResolvedValue(null);
  await expect(manageAgentSidecar('agent', 'update')).rejects.toThrow('no deployed sidecar');
  expect(mocks.configure).not.toHaveBeenCalled();
});
it('does not silently enable automatic sessions when asked to update a stopped sidecar', async () => {
  mocks.list.mockResolvedValue([]);
  await expect(manageAgentSidecar('agent', 'update')).rejects.toThrow('Automatic sessions are off');
  expect(mocks.configure).not.toHaveBeenCalled();
});
