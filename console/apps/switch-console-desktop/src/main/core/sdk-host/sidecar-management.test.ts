import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  apply: vi.fn(),
  setStopped: vi.fn(),
  agent: vi.fn(),
  remote: vi.fn(),
}));
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: mocks.agent }));
vi.mock('@main/core/agents/agent-location', () => ({ getRemoteAgentLocation: mocks.remote }));
vi.mock('@main/core/agents/observed-guard', () => ({
  // Every agent in these cases is one this Console runs (CHOO-2893).
  locationWhereAgentRuns: async () => ({ sshHost: 'host', dir: '/work', observed: false }),
}));
vi.mock('@main/core/switch-rooms/auto-session-store', () => ({
  setControllerStopped: mocks.setStopped,
}));
vi.mock('./shared-watcher', () => ({
  configureSharedWatcher: mocks.configure,
  applyControllerState: mocks.apply,
}));
const { manageAgentSidecar } = await import('./sidecar-management');
beforeEach(() => {
  vi.resetAllMocks();
  mocks.configure.mockResolvedValue(undefined);
  mocks.apply.mockResolvedValue(undefined);
  mocks.setStopped.mockResolvedValue(undefined);
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
    await vi.waitFor(() =>
      expect(mocks.configure).toHaveBeenCalledWith(
        'agent',
        { connected: false, spawning: false },
        'explicit'
      )
    );
    expect(mocks.apply).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(mocks.apply).toHaveBeenCalledWith('agent', 'explicit');
  }
);
it('does not start a competing watcher if stopping fails', async () => {
  mocks.configure.mockRejectedValueOnce(new Error('Still running'));
  await expect(manageAgentSidecar('agent', 'restart')).rejects.toThrow('Still running');
  expect(mocks.apply).not.toHaveBeenCalled();
});
it('restarts a controller whose automatic sessions are off', async () => {
  // There is a controller to restart either way now, so this no longer refuses
  // with "Automatic sessions are off" — and it does not turn them on to proceed.
  await manageAgentSidecar('agent', 'restart');
  expect(mocks.apply).toHaveBeenCalledWith('agent', 'explicit');
});
it('takes the connection away on stop and records that somebody did', async () => {
  await manageAgentSidecar('agent', 'stop');
  expect(mocks.setStopped).toHaveBeenCalledWith('agent', true);
  expect(mocks.configure).toHaveBeenCalledWith(
    'agent',
    { connected: false, spawning: false },
    'explicit'
  );
  expect(mocks.apply).not.toHaveBeenCalled();
});
it('puts a stopped agent back on the air on start, and stops recording it stopped', async () => {
  await manageAgentSidecar('agent', 'start');
  expect(mocks.setStopped).toHaveBeenCalledWith('agent', false);
  expect(mocks.configure).not.toHaveBeenCalled();
  expect(mocks.apply).toHaveBeenCalledWith('agent', 'explicit');
});
it('refuses to update a local agent, which has no deployed sidecar', async () => {
  mocks.remote.mockResolvedValue(null);
  await expect(manageAgentSidecar('agent', 'update')).rejects.toThrow('no deployed sidecar');
  expect(mocks.configure).not.toHaveBeenCalled();
  expect(mocks.setStopped).not.toHaveBeenCalled();
});
