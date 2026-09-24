import { expect, it, vi } from 'vitest';
import { hostJournalTransport } from './shared-session-transport';

const ipc = vi.hoisted(() => ({
  journalSnapshot: vi.fn(),
  journalEvents: vi.fn(),
  sessionSubmit: vi.fn(),
}));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { sdkHost: ipc } }));

it('reads the host journal and sends commands through the relay', async () => {
  const transport = hostJournalTransport('agent');
  ipc.journalSnapshot.mockResolvedValueOnce('snapshot');
  expect(await transport.snapshot('session', null)).toBe('snapshot');
  expect(ipc.journalSnapshot).toHaveBeenCalledWith('agent', 'session');

  ipc.journalEvents.mockResolvedValue([]);
  const cursor = vi.fn();
  const stop = transport.subscribe('session', 7, vi.fn(), vi.fn(), cursor);
  await vi.waitFor(() => expect(cursor).toHaveBeenCalledWith(7));
  stop();
  expect(ipc.journalEvents).toHaveBeenCalledWith('agent', 'session', 7);

  ipc.sessionSubmit.mockResolvedValueOnce({
    type: 'command.status',
    commandId: 'c',
    status: 'accepted',
    code: null,
    message: null,
  });
  await transport.submit({
    contractVersion: 1,
    commandId: 'c',
    sessionId: 'session',
    epoch: 'epoch',
    body: { type: 'turn.interrupt', turnId: 'turn' },
  } as never);
  expect(ipc.sessionSubmit).toHaveBeenCalledWith(
    'agent',
    expect.objectContaining({ commandId: 'c' })
  );
});

it('offers no attachment upload: the host takes files only from its rooms', () => {
  expect(hostJournalTransport('agent').uploadAttachment).toBeUndefined();
});
