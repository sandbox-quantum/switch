import { expect, it, vi } from 'vitest';
import { hostJournalTransport } from './shared-session-transport';

const ipc = vi.hoisted(() => ({
  transcriptOpen: vi.fn(),
  transcriptClose: vi.fn(),
  sessionSubmit: vi.fn(),
}));
const bus = vi.hoisted(() => ({
  listeners: new Map<string, (payload: { event: unknown }) => void>(),
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { sdkHost: ipc },
  events: {
    on: (_channel: unknown, listener: (payload: { event: unknown }) => void, topic: string) => {
      bus.listeners.set(topic, listener);
      return () => bus.listeners.delete(topic);
    },
  },
}));

const event = (sequence: number) => ({
  contractVersion: 1,
  eventId: `event-${sequence}`,
  sessionId: 'session',
  sequence,
  occurredAt: '2026-09-24T12:00:00.000Z',
  body: { type: 'notice', level: 'info', code: 'X', message: 'hi' },
});

it('opens the transcript, hears pushed events after its cursor, and closes it', async () => {
  const transport = hostJournalTransport('agent');
  ipc.transcriptOpen.mockResolvedValueOnce('snapshot');
  expect(await transport.snapshot('session', null)).toBe('snapshot');
  expect(ipc.transcriptOpen).toHaveBeenCalledWith('agent', 'session');

  const heard: number[] = [];
  const cursor = vi.fn();
  const stop = transport.subscribe(
    'session',
    7,
    (e) => heard.push((e as { sequence: number }).sequence),
    vi.fn(),
    cursor
  );
  const push = bus.listeners.get('session')!;
  push({ event: event(7) });
  push({ event: event(8) });
  push({ event: event(9) });
  expect(heard).toEqual([8, 9]);
  expect(cursor).toHaveBeenLastCalledWith(9);

  stop();
  expect(bus.listeners.has('session')).toBe(false);
  expect(ipc.transcriptClose).toHaveBeenCalledWith('session');
});

it('sends commands to the session through main', async () => {
  ipc.sessionSubmit.mockResolvedValueOnce({
    type: 'command.status',
    commandId: 'c',
    status: 'accepted',
    code: null,
    message: null,
  });
  await hostJournalTransport('agent').submit({
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
