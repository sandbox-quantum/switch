import { describe, expect, it, vi } from 'vitest';
import { SessionChatClient } from './client';
import type { CommandStatus, SessionTransport } from './client';
import type { Item, ServerEvent, Snapshot } from './contract';
import activity from './examples.activity.json';
import examples from './examples.json';
import questions from './examples.questions.json';
import { SessionReplica } from './replica';
import { commandSchema, parseHostEvent, serverEventSchema, snapshotSchema } from './validation';

const initial = (): Snapshot => snapshotSchema.parse(examples.initialSnapshot);
const item = (revision: number, text: string): Item => ({
  itemId: 'assistant',
  turnId: 'turn-demo',
  revision,
  kind: 'assistant-message',
  status: 'in-progress',
  title: '',
  text,
  attachments: [],
  origin: null,
});
const event = (sequence: number, body: ServerEvent['body']): ServerEvent => ({
  contractVersion: 1,
  eventId: `event-${sequence}`,
  sessionId: 'session-demo',
  sequence,
  occurredAt: '2026-09-07T12:00:00Z',
  body,
});
function transport() {
  let listener: (event: unknown) => void = () => {};
  let failed: (error: Error) => void = () => {};
  const receipt: CommandStatus = {
    type: 'command.status',
    commandId: 'send',
    status: 'accepted',
    code: null,
    message: null,
  };
  const api: SessionTransport = {
    snapshot: vi.fn(async () => initial()),
    subscribe: vi.fn((_id, _after, next, error) => {
      listener = next;
      failed = error;
      return () => {};
    }),
    submit: vi.fn(async () => receipt),
    commandStatus: vi.fn(async () => receipt),
  };
  return {
    api,
    receipt,
    emit: (value: unknown) => listener(value),
    fail: () => failed(new Error('Connection lost')),
  };
}

describe('session-v1 wire contract', () => {
  it('validates the agreed examples and renders settlement after submitting', () => {
    commandSchema.parse(examples.platformAnswer);
    parseHostEvent(examples.hostRequest);
    const replica = new SessionReplica(examples.initialSnapshot);
    for (const update of examples.answerLifecycle) replica.apply(update);
    const snapshot = replica.snapshot();
    expect(snapshot.requests[0].state).toBe('resolved');
    expect(snapshot.requests[0].decidedBy?.surface).toBe('mattermost');
    expect(snapshot.session.pendingRequestIds).toEqual([]);
    expect(snapshot.commandStatuses[0].status).toBe('applied');
  });
  it('rejects raw data, reasoning items, unsafe counters and oversized host events', () => {
    expect(() =>
      parseHostEvent({ ...examples.hostRequest, raw: { secret: 'must not publish' } })
    ).toThrow();
    expect(() =>
      serverEventSchema.parse(
        event(11, {
          type: 'item.upsert',
          item: { ...item(1, ''), kind: 'reasoning' } as unknown as Item,
        })
      )
    ).toThrow();
    expect(() =>
      serverEventSchema.parse({
        ...event(11, { type: 'session.connectivity', connectivity: 'online' }),
        sequence: Number.MAX_SAFE_INTEGER + 1,
      })
    ).toThrow();
    expect(() =>
      parseHostEvent({
        ...examples.hostRequest,
        body: { type: 'notice', level: 'info', code: 'OUTPUT', message: 'x'.repeat(65536) },
      })
    ).toThrow('PAYLOAD_TOO_LARGE');
  });
  it('replaces text, ignores replay and accepts permission-filtered sequence gaps', () => {
    const replica = new SessionReplica(initial());
    replica.apply(event(12, { type: 'item.upsert', item: item(1, 'Hello') }));
    replica.apply(event(16, { type: 'item.upsert', item: item(2, 'Hello world') }));
    replica.apply(event(16, { type: 'item.upsert', item: item(2, 'Hello world') }));
    replica.apply(event(18, { type: 'item.upsert', item: item(1, 'Hello') }));
    expect(replica.snapshot().items).toHaveLength(1);
    expect(replica.snapshot().items[0].text).toBe('Hello world');
    expect(replica.snapshot().throughSequence).toBe(18);
  });
  it('rejects conflicting revisions and cross-session replay without advancing cursor', () => {
    const replica = new SessionReplica(initial());
    replica.apply(event(11, { type: 'item.upsert', item: item(1, 'Hello') }));
    expect(() =>
      replica.apply(event(12, { type: 'item.upsert', item: item(1, 'Different') }))
    ).toThrow('Conflicting');
    expect(() =>
      replica.apply({
        ...event(12, { type: 'session.connectivity', connectivity: 'offline' }),
        sessionId: 'another',
      })
    ).toThrow();
    expect(replica.snapshot().throughSequence).toBe(11);
  });
  it('advances a cursor even when the server filtered every event', () => {
    const replica = new SessionReplica(initial());
    replica.advanceCursor(30);
    expect(replica.snapshot().throughSequence).toBe(30);
    expect(replica.snapshot().items).toEqual([]);
  });
  it('keeps execution state on connection loss and closes interrupted requests', () => {
    const replica = new SessionReplica(initial());
    replica.apply(event(11, { type: 'session.connectivity', connectivity: 'offline' }));
    replica.apply(
      event(12, {
        type: 'request.settled',
        requestId: 'request-demo',
        revision: 2,
        outcome: 'interrupted',
        commandId: null,
        result: null,
      })
    );
    expect(replica.snapshot().session.status).toBe('running');
    expect(replica.snapshot().requests[0].state).toBe('closed');
    expect(replica.snapshot().requests[0].decidedBy).toBeNull();
  });
});

describe('session-v1 client transport', () => {
  it('subscribes after the snapshot and queues messages without client identity claims', async () => {
    const wire = transport();
    const client = new SessionChatClient('session-demo', wire.api);
    await client.connect();
    await client.send('Hello', 'send');
    expect(wire.api.subscribe).toHaveBeenCalledWith(
      'session-demo',
      10,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function)
    );
    expect(wire.api.submit).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ delivery: 'queue' }) })
    );
    expect(vi.mocked(wire.api.submit).mock.calls[0][0]).not.toHaveProperty('origin');
    expect(client.getSnapshot().snapshot?.commandStatuses[0].status).toBe('accepted');
  });
  it('reconnects reads after an epoch change without resending an uncertain command', async () => {
    vi.useFakeTimers();
    const wire = transport();
    const client = new SessionChatClient('session-demo', wire.api);
    try {
      await client.connect();
      vi.mocked(wire.api.submit).mockRejectedValueOnce(new Error('Lost reply'));
      await expect(client.send('Hello', 'send')).rejects.toThrow();
      const recovered = initial();
      recovered.session.epoch = 'recovered-epoch';
      vi.mocked(wire.api.snapshot).mockResolvedValue(recovered);
      wire.fail();
      await vi.advanceTimersByTimeAsync(1000);
      expect(client.getSnapshot().connected).toBe(true);
      expect(client.getSnapshot().snapshot?.session.epoch).toBe('recovered-epoch');
      expect(client.hasPendingCommand()).toBe(true);
      expect(wire.api.submit).toHaveBeenCalledTimes(1);
      await expect(client.send('Hello', 'send')).rejects.toThrow('STALE_EPOCH');
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });
  it('rejects oversized input before reserving the composer', async () => {
    const wire = transport();
    const client = new SessionChatClient('session-demo', wire.api);
    await client.connect();
    await expect(client.send('x'.repeat(60 * 1024), 'oversized')).rejects.toThrow('59 KiB');
    expect(client.hasPendingCommand()).toBe(false);
    expect(wire.api.submit).not.toHaveBeenCalled();
  });
  it('preserves command ID and body after a lost receipt, then reconciles', async () => {
    const wire = transport();
    const client = new SessionChatClient('session-demo', wire.api);
    await client.connect();
    vi.mocked(wire.api.submit).mockRejectedValueOnce(new Error('Lost reply'));
    await expect(client.send('Hello', 'send')).rejects.toThrow('Lost reply');
    await expect(client.send('Different', 'new')).rejects.toThrow('previous');
    await client.send('Hello', 'send');
    expect(vi.mocked(wire.api.submit).mock.calls[0][0]).toEqual(
      vi.mocked(wire.api.submit).mock.calls[1][0]
    );
  });
  it('fences the exact uncertain command without resending it', async () => {
    const wire = transport();
    wire.api.reconcile = vi.fn(async () => ({
      ...wire.receipt,
      status: 'rejected' as const,
      code: 'NOT_ACCEPTED',
      message: 'The command was not accepted.',
    }));
    const client = new SessionChatClient('session-demo', wire.api);
    await client.connect();
    vi.mocked(wire.api.submit).mockRejectedValueOnce(new Error('Lost reply'));
    await expect(client.send('Hello', 'send')).rejects.toThrow('Lost reply');
    await expect(client.reconcile()).rejects.toThrow('not accepted');
    expect(wire.api.reconcile).toHaveBeenCalledWith(vi.mocked(wire.api.submit).mock.calls[0][0]);
    expect(wire.api.submit).toHaveBeenCalledTimes(1);
    expect(wire.api.commandStatus).not.toHaveBeenCalled();
    expect(client.hasPendingCommand()).toBe(false);
  });
  it('keeps pending identity when reconciliation fails', async () => {
    const wire = transport();
    wire.api.reconcile = vi.fn(async () => {
      throw new Error('Connection lost');
    });
    const client = new SessionChatClient('session-demo', wire.api);
    await client.connect();
    vi.mocked(wire.api.submit).mockRejectedValueOnce(new Error('Lost reply'));
    await expect(client.send('Hello', 'send')).rejects.toThrow();
    await expect(client.reconcile()).rejects.toThrow('Connection lost');
    expect(client.hasPendingCommand()).toBe(true);
    expect(wire.api.submit).toHaveBeenCalledTimes(1);
  });
  it('retains uncertain commands and blocks sends while disconnected', async () => {
    const wire = transport();
    const client = new SessionChatClient('session-demo', wire.api);
    await client.connect();
    vi.mocked(wire.api.submit).mockRejectedValueOnce(new Error('Lost reply'));
    await expect(client.send('Hello', 'send')).rejects.toThrow();
    vi.mocked(wire.api.commandStatus).mockResolvedValueOnce({ ...wire.receipt, status: 'unknown' });
    await expect(client.reconcile()).rejects.toThrow('unknown');
    expect(client.hasPendingCommand()).toBe(true);
    wire.fail();
    await expect(client.send('Hello', 'send')).rejects.toThrow('HOST_OFFLINE');
    expect(client.getSnapshot().snapshot?.session.status).toBe('running');
    await client.connect();
    await client.reconcile();
    expect(client.hasPendingCommand()).toBe(false);
  });
  it('acknowledges an unknown outcome without resending or changing its receipt', async () => {
    const wire = transport();
    const client = new SessionChatClient('session-demo', wire.api);
    await client.connect();
    vi.mocked(wire.api.submit).mockResolvedValueOnce({ ...wire.receipt, status: 'unknown' });
    await expect(client.send('Hello', 'send')).rejects.toThrow('unknown');
    expect(client.hasUnknownCommand()).toBe(true);
    vi.mocked(wire.api.commandStatus).mockResolvedValueOnce({ ...wire.receipt, status: 'unknown' });
    await client.acknowledgeUnknown();
    expect(client.hasPendingCommand()).toBe(false);
    expect(wire.api.submit).toHaveBeenCalledTimes(1);
    expect(
      client.getSnapshot().snapshot?.commandStatuses.find((status) => status.commandId === 'send')
        ?.status
    ).toBe('unknown');
    client.dispose();
  });
  it('ignores events from a disconnected subscription until reconnect', async () => {
    const wire = transport();
    const client = new SessionChatClient('session-demo', wire.api);
    await client.connect();
    wire.fail();
    wire.emit(event(11, { type: 'session.connectivity', connectivity: 'online' }));
    expect(client.getSnapshot().connected).toBe(false);
    expect(client.getSnapshot().snapshot?.throughSequence).toBe(10);
  });
  it('does not regress an applied command when an older acceptance receipt arrives', async () => {
    const wire = transport();
    const client = new SessionChatClient('session-demo', wire.api);
    await client.connect();
    wire.emit(event(11, { ...wire.receipt, status: 'applied' }));
    await client.send('Hello', 'send');
    expect(client.getSnapshot().snapshot?.commandStatuses[0].status).toBe('applied');
  });
  it('refuses pages from different snapshot versions', async () => {
    const wire = transport();
    vi.mocked(wire.api.snapshot)
      .mockResolvedValueOnce({ ...initial(), nextPageToken: 'next' })
      .mockResolvedValueOnce({ ...initial(), throughSequence: 11 });
    const client = new SessionChatClient('session-demo', wire.api);
    await client.connect();
    expect(client.getSnapshot().error).toContain('changed version');
    expect(wire.api.subscribe).not.toHaveBeenCalled();
  });
  it('does not subscribe after disposal during snapshot fetch', async () => {
    const wire = transport();
    let finish: (value: unknown) => void = () => {};
    vi.mocked(wire.api.snapshot).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const client = new SessionChatClient('session-demo', wire.api);
    const connecting = client.connect();
    client.dispose();
    finish(initial());
    await connecting;
    expect(wire.api.subscribe).not.toHaveBeenCalled();
  });
});

it('rejects publication authority on host items and requests', () => {
  const audience = { kind: 'room', roomId: 'room', threadId: null };
  expect(() =>
    parseHostEvent({
      ...examples.hostRequest,
      body: {
        type: 'request.opened',
        request: { ...examples.hostRequest.body.request, audience },
      },
    })
  ).toThrow();
  expect(() =>
    parseHostEvent({
      ...examples.hostRequest,
      body: {
        type: 'item.upsert',
        item: { ...item(1, 'Hello'), audience },
      },
    })
  ).toThrow();
});

it('retains the verified actor for cancellation and clears an unrelated reservation', () => {
  for (const commandId of ['answer-demo', null]) {
    const replica = new SessionReplica(initial());
    replica.apply(examples.answerLifecycle[1]);
    replica.apply(
      event(13, {
        type: 'request.settled',
        requestId: 'request-demo',
        revision: 2,
        outcome: 'cancelled',
        commandId,
        result: null,
      })
    );
    const request = replica.snapshot().requests[0];
    expect(request.state).toBe('closed');
    expect(request.result?.result).toBeNull();
    expect(request.decidedBy).toEqual(
      commandId
        ? {
            actorId: 'actor-demo',
            surface: 'mattermost',
            commandId,
          }
        : null
    );
    expect(new SessionReplica(replica.snapshot()).snapshot().requests[0]).toEqual(request);
  }
});

it('validates the bridge question and activity recordings with the SDK reader', () => {
  parseHostEvent(questions.hostQuestions);
  commandSchema.parse(questions.platformFormAnswer);
  for (const [snapshot, events] of [
    [questions.initialSnapshot, questions.formAnswerLifecycle],
    [activity.initialSnapshot, activity.turnActivity],
  ] as const) {
    const replica = new SessionReplica(snapshot);
    for (const event of events) replica.apply(event);
  }
});

it('releases the composer after a durable stale-epoch rejection', async () => {
  const wire = transport();
  const client = new SessionChatClient('session-demo', wire.api);
  await client.connect();
  vi.mocked(wire.api.submit).mockResolvedValueOnce({
    ...wire.receipt,
    status: 'rejected',
    code: 'STALE_EPOCH',
    message: 'Session generation changed',
  });
  await expect(client.send('Hello', 'send')).rejects.toThrow('Session generation changed');
  expect(client.hasPendingCommand()).toBe(false);
  wire.receipt.commandId = 'new-send';
  await client.send('Revised message', 'new-send');
  expect(wire.api.submit).toHaveBeenCalledTimes(2);
  client.dispose();
});
