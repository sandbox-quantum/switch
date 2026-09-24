import { beforeEach, expect, it, vi } from 'vitest';
import { stopSavedSession } from './stop-saved-session';

const mocks = vi.hoisted(() => ({
  agent: vi.fn(),
  stop: vi.fn(),
  stopLocal: vi.fn(),
}));
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: mocks.agent }));
vi.mock('./stop-shared-session', () => ({ stopSharedSession: mocks.stop }));
vi.mock('./local-host', () => ({ stopLocalSession: mocks.stopLocal }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.agent.mockResolvedValue({ switchAgentId: 'remote-agent', serverId: 'server' });
  mocks.stop.mockResolvedValue(undefined);
  mocks.stopLocal.mockResolvedValue(undefined);
});

it('asks the session host to stop, then stops the local worker', async () => {
  await stopSavedSession('session', 'agent');
  expect(mocks.stop).toHaveBeenCalledWith('agent', 'session');
  expect(mocks.stopLocal).toHaveBeenCalledWith('session');
});

it('leaves an unlinked agent to its local worker', async () => {
  mocks.agent.mockResolvedValue({ switchAgentId: null });
  await stopSavedSession('session', 'agent');
  expect(mocks.stop).not.toHaveBeenCalled();
  expect(mocks.stopLocal).toHaveBeenCalledWith('session');
});

it('still stops the local worker when the host stop is uncertain', async () => {
  mocks.stop.mockRejectedValue(new Error('Stop delivery has not been confirmed.'));
  await expect(stopSavedSession('session', 'agent')).rejects.toThrow('not been confirmed');
  expect(mocks.stopLocal).toHaveBeenCalledWith('session');
});
