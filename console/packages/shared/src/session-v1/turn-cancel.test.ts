import { describe, expect, it } from 'vitest';
import examples from './examples.json';
import { SessionReplica } from './replica';
import { commandSchema, parseHostEvent, serverEventSchema, snapshotSchema } from './validation';

const cancel = (body: Record<string, unknown>) => ({
  ...examples.platformAnswer,
  commandId: 'cancel',
  body,
});

describe('cancelling a queued turn', () => {
  it('accepts a turn.cancel command naming a turn, and nothing more', () => {
    expect(
      commandSchema.parse(cancel({ type: 'turn.cancel', turnId: 'turn-queued' })).body
    ).toEqual({ type: 'turn.cancel', turnId: 'turn-queued' });
    expect(() => commandSchema.parse(cancel({ type: 'turn.cancel' }))).toThrow();
    expect(() =>
      commandSchema.parse(cancel({ type: 'turn.cancel', turnId: 'turn-queued', extra: true }))
    ).toThrow();
  });

  it('reads a cancelled turn from a host and from a server, and keeps it in the snapshot', () => {
    const body = {
      type: 'turn.upsert' as const,
      turnId: 'turn-queued',
      status: 'cancelled' as const,
      commandId: 'send',
    };
    parseHostEvent({
      ...examples.hostRequest,
      eventId: 'host-cancelled',
      hostSequence: examples.hostRequest.hostSequence + 1,
      body,
    });
    const initial = snapshotSchema.parse(examples.initialSnapshot);
    const event = serverEventSchema.parse({
      contractVersion: 1,
      eventId: 'event-cancelled',
      sessionId: initial.session.sessionId,
      sequence: initial.throughSequence + 1,
      occurredAt: '2026-09-07T12:00:00Z',
      body,
    });
    const replica = new SessionReplica(initial);
    replica.apply(event);
    expect(replica.snapshot().turns.find((turn) => turn.turnId === 'turn-queued')?.status).toBe(
      'cancelled'
    );
  });

  it('still refuses a turn status it does not know', () => {
    expect(() =>
      parseHostEvent({
        ...examples.hostRequest,
        body: { type: 'turn.upsert', turnId: 't', status: 'withdrawn', commandId: null },
      })
    ).toThrow();
  });
});
