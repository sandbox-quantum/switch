import { expect, it, vi } from 'vitest';
import { cloudSessionTransport, hostJournalTransport } from './shared-session-transport';

const ipc = vi.hoisted(() => ({
  transcriptOpen: vi.fn(),
  transcriptClose: vi.fn(),
  sessionSubmit: vi.fn(),
  cloudUploadAttachment: vi.fn(),
}));
const bus = vi.hoisted(() => ({
  listeners: new Map<string, (payload: never) => void>(),
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { sdkHost: ipc },
  events: {
    on: (channel: { name: string }, listener: (payload: never) => void, topic: string) => {
      const key = `${channel.name}:${topic}`;
      bus.listeners.set(key, listener);
      return () => bus.listeners.delete(key);
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
  const push = bus.listeners.get('session:transcript-event:session')! as (payload: {
    event: unknown;
  }) => void;
  push({ event: event(7) });
  push({ event: event(8) });
  push({ event: event(9) });
  expect(heard).toEqual([8, 9]);
  expect(cursor).toHaveBeenLastCalledWith(9);

  stop();
  expect(bus.listeners.size).toBe(0);
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

it('reports a broken live feed so the view reloads the session', () => {
  const transport = hostJournalTransport('agent');
  const onError = vi.fn();
  const stop = transport.subscribe('session', 0, vi.fn(), onError, vi.fn());
  const reset = bus.listeners.get('session:transcript-reset:session')! as (payload: {
    sessionId: string;
    reason: string;
  }) => void;
  reset({ sessionId: 'session', reason: 'The connection to the agent sidecar closed.' });
  expect(onError).toHaveBeenCalledWith(
    new Error(
      'The live feed from the session stopped (The connection to the agent sidecar closed.).'
    )
  );
  stop();
});

it('uploads a cloud session’s attachment to its worker, and reads it as any host journal', async () => {
  const transport = cloudSessionTransport('cloud:server:launch');
  const staged = { attachmentId: 'ref', name: 'a.txt', mimeType: 'text/plain', bytes: 2 };
  ipc.cloudUploadAttachment.mockResolvedValueOnce(staged);
  await expect(
    transport.uploadAttachment!('session', {
      attachmentId: 'local',
      name: 'a.txt',
      mimeType: 'text/plain',
      data: 'aGk=',
    })
  ).resolves.toBe(staged);
  expect(ipc.cloudUploadAttachment).toHaveBeenCalledWith('cloud:server:launch', 'session', {
    name: 'a.txt',
    mimeType: 'text/plain',
    data: 'aGk=',
  });
  ipc.transcriptOpen.mockResolvedValueOnce('snapshot');
  await transport.snapshot('session', null);
  expect(ipc.transcriptOpen).toHaveBeenLastCalledWith('cloud:server:launch', 'session');
});
