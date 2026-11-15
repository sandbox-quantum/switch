import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/lib/logger', () => ({ log: { warn: () => {} } }));

const { ChatActivityStream } = await import('./activity-stream');
const { SERVER_TOO_OLD_FOR_ACTIVITY } = await import('@shared/core/chats/activity');

const item = {
  agentId: 'a',
  sessionId: 's',
  turnId: 't',
  itemId: 'turn',
  kind: 'turn',
  revision: 1,
  status: 'running',
  title: '',
  text: '',
  commandId: null,
  roomId: 'room-1',
  threadId: null,
  messageId: 'm1',
  occurredAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('ChatActivityStream', () => {
  it('asks for snapshots on ready and resync, and passes rows that match the contract', async () => {
    const body = [
      'event: ready\ndata: {}\n\n',
      ': ping\n\n',
      `event: activity\ndata: ${JSON.stringify(item)}\n\n`,
      'event: activity\ndata: {"roomId":"room-1"}\n\n',
      'event: resync\ndata: {}\n\n',
    ].join('');
    const seen: string[] = [];
    const stream = new ChatActivityStream({
      open: async () => new Response(body),
      isUnauthorized: () => false,
      backoffMs: () => 60_000,
      setTimer: () => () => {},
      sink: {
        activity: (row) => seen.push(`activity:${row.messageId}`),
        approval: () => seen.push('approval'),
        resync: () => seen.push('resync'),
        state: (state) => seen.push(state),
      },
    });
    stream.start();
    await vi.waitFor(() =>
      expect(seen).toEqual(['live', 'resync', 'activity:m1', 'resync', 'offline'])
    );
    stream.stop();
  });

  it('stops asking a server that has no activity feed until started again', async () => {
    let opened = 0;
    const seen: (string | null)[] = [];
    const stream = new ChatActivityStream({
      open: async () => {
        opened++;
        return new Response('Not Found', { status: 404 });
      },
      isUnauthorized: () => false,
      backoffMs: () => 0,
      setTimer: (fn) => {
        fn();
        return () => {};
      },
      sink: {
        activity: () => {},
        approval: () => {},
        resync: () => {},
        state: (state, detail) => seen.push(`${state}:${detail}`),
      },
    });
    stream.start();
    await vi.waitFor(() => expect(seen).toEqual([`offline:${SERVER_TOO_OLD_FOR_ACTIVITY}`]));
    expect(stream.state).toEqual({ state: 'offline', detail: SERVER_TOO_OLD_FOR_ACTIVITY });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(opened).toBe(1);
    stream.start();
    await vi.waitFor(() => expect(opened).toBe(2));
    stream.stop();
  });

  it('reconnects at once when started while waiting to retry', async () => {
    let opened = 0;
    const timers: { cancelled: boolean }[] = [];
    const stream = new ChatActivityStream({
      open: async () => {
        opened++;
        return new Response('Bad Gateway', { status: 502 });
      },
      isUnauthorized: () => false,
      backoffMs: () => 30_000,
      setTimer: () => {
        const timer = { cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      sink: { activity: () => {}, approval: () => {}, resync: () => {}, state: () => {} },
    });
    stream.start();
    await vi.waitFor(() => expect(timers).toHaveLength(2));
    stream.start();
    await vi.waitFor(() => expect(opened).toBe(2));
    expect(timers[1]!.cancelled).toBe(true);
    stream.stop();
    expect(timers.every((each) => each.cancelled)).toBe(true);
  });
});
