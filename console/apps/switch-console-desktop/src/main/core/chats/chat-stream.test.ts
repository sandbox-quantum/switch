import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatStreamState, ChatSummary } from '@shared/core/chats/chats';
import { ChatStream, type ChatStreamDeps, sseFrames } from './chat-stream';

function summary(roomId: string, seq: number | null): ChatSummary {
  return {
    roomId,
    name: roomId,
    channelType: 'direct',
    bridgeType: null,
    channelName: null,
    agents: [],
    canManage: true,
    ownsAgent: false,
    lastMessage:
      seq === null ? null : { seq, sentAt: '2026-01-01T00:00:00Z', preview: '', senderName: '' },
  };
}

function message(roomId: string, seq: number): ChatMessage {
  return {
    messageId: `${roomId}-${seq}`,
    seq,
    roomId,
    sentAt: '2026-01-01T00:00:00Z',
    sender: { clientId: 'c', name: 'n', kind: 'agent', agentId: 'a', userId: null },
    source: 'switch',
    body: `m${seq}`,
    format: null,
    threadRootId: null,
    attachments: [],
    clientTxn: null,
  };
}

/** A streaming response the test writes frames into. */
function feed() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status: 200 }),
    send: (event: string, data: unknown) =>
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
    ping: () => controller.enqueue(encoder.encode(': ping\n\n')),
    end: () => controller.close(),
  };
}

function harness(lists: ChatSummary[][], unauthorized = false) {
  const states: { state: ChatStreamState; detail: string | null }[] = [];
  const messages: ChatMessage[] = [];
  const removed: [string, string][] = [];
  const summaries: ChatSummary[] = [];
  const opened: string[] = [];
  const feeds: ReturnType<typeof feed>[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  let listCall = 0;
  const deps: ChatStreamDeps = {
    listChats: async () => {
      if (unauthorized) throw Object.assign(new Error('Signed out'), { unauthorized: true });
      return lists[Math.min(listCall++, lists.length - 1)]!;
    },
    open: async (after) => {
      opened.push(after);
      const next = feed();
      feeds.push(next);
      return next.response;
    },
    isUnauthorized: (error) => (error as { unauthorized?: boolean }).unauthorized === true,
    backoffMs: (attempt) => 1000 * (attempt + 1),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    sink: {
      message: (m) => messages.push(m),
      summary: (c) => summaries.push(c),
      removed: (roomId, reason) => removed.push([roomId, reason]),
      state: (state, detail) => states.push({ state, detail }),
    },
  };
  const fireRetry = () => {
    const timer = timers.find((each) => !each.cancelled && each.ms < 60_000);
    if (!timer) throw new Error('No retry is waiting.');
    timer.cancelled = true;
    timer.fn();
  };
  return { deps, states, messages, removed, summaries, opened, feeds, fireRetry };
}

describe('sseFrames', () => {
  it('splits events, skips pings and joins multi-line data', async () => {
    const encoder = new TextEncoder();
    const chunks = [': ping\n\nevent: a\ndata: {"x":', '1}\n\nevent: b\ndata: 1\ndata: 2\n\n'];
    let seen = 0;
    const frames = [];
    for await (const frame of sseFrames(
      (async function* () {
        for (const chunk of chunks) yield encoder.encode(chunk);
      })(),
      () => seen++
    ))
      frames.push(frame);
    expect(frames).toEqual([
      { event: 'a', data: '{"x":1}' },
      { event: 'b', data: '1\n2' },
    ]);
    expect(seen).toBe(2);
  });
});

describe('ChatStream', () => {
  it('reads cursors from the list, and is live only after ready', async () => {
    const h = harness([[summary('room-a', 5), summary('room-b', null)]]);
    const stream = new ChatStream(h.deps);
    stream.start();
    await vi.waitFor(() => expect(h.feeds).toHaveLength(1));
    expect(h.opened[0]).toBe('room-a:5,room-b:0');
    expect(h.summaries.map((chat) => chat.roomId)).toEqual(['room-a', 'room-b']);
    await vi.waitFor(() => expect(stream.state.state).toBe('catching-up'));

    h.feeds[0]!.send('message', message('room-a', 6));
    h.feeds[0]!.ping();
    await vi.waitFor(() => expect(h.messages).toHaveLength(1));
    expect(stream.state.state).toBe('catching-up');

    h.feeds[0]!.send('ready', {});
    await vi.waitFor(() => expect(stream.state.state).toBe('live'));
    expect(h.states.map((each) => each.state)).toEqual(['catching-up', 'live']);
    stream.stop();
  });

  it('reconnects from the cursor it reached and drops what it already delivered', async () => {
    const h = harness([[summary('room-a', 5)], [summary('room-a', 9)]]);
    const stream = new ChatStream(h.deps);
    stream.start();
    await vi.waitFor(() => expect(h.feeds).toHaveLength(1));
    h.feeds[0]!.send('message', message('room-a', 6));
    h.feeds[0]!.send('message', message('room-a', 7));
    h.feeds[0]!.send('ready', {});
    await vi.waitFor(() => expect(stream.state.state).toBe('live'));
    h.feeds[0]!.end();
    await vi.waitFor(() => expect(stream.state.state).toBe('offline'));

    h.fireRetry();
    await vi.waitFor(() => expect(h.feeds).toHaveLength(2));
    // The list now says 9, but the cursor reached stands: nothing between is skipped.
    expect(h.opened[1]).toBe('room-a:7');
    h.feeds[1]!.send('message', message('room-a', 7));
    h.feeds[1]!.send('message', message('room-a', 8));
    h.feeds[1]!.send('ready', {});
    await vi.waitFor(() => expect(stream.state.state).toBe('live'));
    expect(h.messages.map((each) => each.seq)).toEqual([6, 7, 8]);
    expect(stream.cursor('room-a')).toBe(8);
    stream.stop();
  });

  it('forgets a removed room and passes on the removal', async () => {
    const h = harness([[summary('room-a', 1)]]);
    const stream = new ChatStream(h.deps);
    stream.start();
    await vi.waitFor(() => expect(h.feeds).toHaveLength(1));
    h.feeds[0]!.send('chat.removed', { roomId: 'room-a', reason: 'unlisted' });
    await vi.waitFor(() => expect(h.removed).toEqual([['room-a', 'unlisted']]));
    expect(stream.cursor('room-a')).toBeUndefined();
    stream.stop();
  });

  it('goes offline and stops retrying once signed out', async () => {
    const h = harness([[]], true);
    const stream = new ChatStream(h.deps);
    stream.start();
    await vi.waitFor(() => expect(stream.state.state).toBe('offline'));
    expect(stream.state.detail).toBe('Signed out');
    expect(() => h.fireRetry()).toThrow('No retry is waiting.');
  });
});
