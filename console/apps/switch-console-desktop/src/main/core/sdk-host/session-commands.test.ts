import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ relay: vi.fn(), status: vi.fn() }));
vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: async () => ({ switchAgentId: 'switch-agent', serverId: 'server' }),
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  getServer: async () => ({ id: 'server' }),
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({ relaySessionCommand: mocks.relay }));
vi.mock('./host-journal', () => ({
  hostJournals: { tail: async () => ({ commandStatus: mocks.status }) },
}));
vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }));

const { reconcileSessionCommand, submitSessionCommand } = await import('./session-commands');

const command = {
  contractVersion: 1 as const,
  commandId: 'command-1',
  sessionId: 'session',
  epoch: 'epoch',
  body: { type: 'turn.interrupt' as const, turnId: 'turn' },
};
const applied = {
  type: 'command.status' as const,
  commandId: 'command-1',
  status: 'applied' as const,
  code: null,
  message: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.relay.mockResolvedValue(undefined);
});

it('relays the command and returns what its host recorded', async () => {
  mocks.status.mockReturnValueOnce(null).mockReturnValue(applied);
  expect(await submitSessionCommand('agent', command)).toEqual(applied);
  expect(mocks.relay).toHaveBeenCalledWith({ id: 'server' }, 'switch-agent', command);
});

it('says the command was dispatched when the host has not recorded it yet', async () => {
  mocks.status.mockReturnValue(null);
  expect((await submitSessionCommand('agent', command)).status).toBe('dispatched');
});

it('reconciles from the host record, relaying again only if it never arrived', async () => {
  mocks.status.mockReturnValue(applied);
  expect(await reconcileSessionCommand('agent', command)).toEqual(applied);
  expect(mocks.relay).not.toHaveBeenCalled();

  mocks.status.mockReturnValueOnce(null).mockReturnValue(applied);
  expect(await reconcileSessionCommand('agent', command)).toEqual(applied);
  expect(mocks.relay).toHaveBeenCalledTimes(1);
});

it('refuses when Switch cannot relay', async () => {
  mocks.relay.mockRejectedValue(new Error('HOST_OFFLINE'));
  await expect(submitSessionCommand('agent', command)).rejects.toThrow('HOST_OFFLINE');
});
