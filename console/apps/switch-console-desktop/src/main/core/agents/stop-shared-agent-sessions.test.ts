import { beforeEach, expect, it, vi } from 'vitest';
import type { Agent } from '@shared/core/agents/agents';
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  submit: vi.fn(),
  status: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  fetchSdkSessions: mocks.list,
  fetchSdkSnapshot: mocks.snapshot,
  submitSdkCommand: mocks.submit,
  fetchSdkCommandStatus: mocks.status,
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  getServer: async () => ({ id: 'server' }),
}));
const { stopSharedAgentSessions } = await import('./stop-shared-agent-sessions');
const session = {
  sessionId: 'session',
  agentId: 'agent',
  hostId: 'host',
  epoch: 'epoch',
  provider: 'claude',
  status: 'running',
  connectivity: 'online',
  pendingRequestIds: [],
  capabilities: {
    input: 'queue',
    approvals: true,
    questions: true,
    interrupt: true,
    reset: true,
    compact: false,
    modelChange: false,
    attachmentMimeTypes: [],
  },
};
const agent = { id: 'local-agent', serverId: 'server', switchAgentId: 'agent' } as Agent;
const receipt = {
  type: 'command.status',
  commandId: 'stop-epoch',
  status: 'applied',
  code: null,
  message: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue([session]);
  mocks.submit.mockResolvedValue(receipt);
  mocks.status.mockResolvedValue(receipt);
  mocks.snapshot.mockResolvedValue({
    contractVersion: 1,
    throughSequence: 0,
    session,
    items: [],
    turns: [],
    requests: [],
    commandStatuses: [],
    nextPageToken: null,
  });
});
it('stops server-discovered sessions even when no Console runtime is attached', async () => {
  await stopSharedAgentSessions(agent);
  expect(mocks.submit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ sessionId: 'session', body: { type: 'session.stop' } })
  );
});
it('keeps the same stop identity after a lost acknowledgement', async () => {
  mocks.submit.mockRejectedValueOnce(new Error('Lost acknowledgement'));
  await expect(stopSharedAgentSessions(agent)).rejects.toThrow('Lost acknowledgement');
  await stopSharedAgentSessions(agent);
  expect(mocks.submit.mock.calls[0][1]).toEqual(mocks.submit.mock.calls[1][1]);
});
it('blocks removal on an unknown stop outcome', async () => {
  mocks.status.mockResolvedValue({ ...receipt, status: 'unknown' });
  await expect(stopSharedAgentSessions(agent)).rejects.toThrow('unknown');
  expect(mocks.submit).toHaveBeenCalledTimes(1);
});
it('does not stop other agents or retired sessions', async () => {
  mocks.list.mockResolvedValue([
    { ...session, agentId: 'other' },
    { ...session, retired: true },
  ]);
  await stopSharedAgentSessions(agent);
  expect(mocks.submit).not.toHaveBeenCalled();
});
