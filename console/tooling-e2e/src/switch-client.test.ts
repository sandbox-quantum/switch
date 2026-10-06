import { describe, expect, it } from 'vitest';
import { EventWatcher, parseSseFrame } from './switch-client.ts';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
  });
}

const CONNECTION_STATE =
  'event: connection_state\ndata: {"generation":3,"cursor":7,"heartbeat_interval_seconds":0.01}\n\n';

describe('parseSseFrame', () => {
  it('reads id, event and data, and ignores comments', () => {
    expect(parseSseFrame('id: 12\nevent: message\ndata: {"a":1}')).toEqual({
      id: '12',
      event: 'message',
      data: '{"a":1}',
    });
    expect(parseSseFrame(': keepalive')).toBeNull();
  });
});

describe('EventWatcher', () => {
  it('collects sequenced room events split across chunks and beats the latest cursor', async () => {
    const beats: [number, number | null][] = [];
    const watcher = new EventWatcher(
      streamOf([
        CONNECTION_STATE,
        ': keepalive\n\nid: 8\nevent: mess',
        'age\ndata: {"type":"message","room_id":"r","payload":{"body":"hi"}}\n\n',
        'event: subscription_changed\ndata: {"rooms":[]}\n\n',
      ]),
      new AbortController(),
      async (cursor, generation) => {
        beats.push([cursor, generation]);
      }
    );
    await watcher.opened(1_000);
    const { match, seen } = await watcher.waitFor((event) => event.payload?.body === 'hi', 1_000);
    expect(match?.room_id).toBe('r');
    expect(seen).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    watcher.close();
    expect(beats[0]).toEqual([8, 3]);
  });

  it('throws when the stream is evicted rather than reporting a quiet stream', async () => {
    const watcher = new EventWatcher(
      streamOf([CONNECTION_STATE, 'event: evicted\ndata: {"code":"taken_over"}\n\n']),
      new AbortController(),
      async () => undefined
    );
    await watcher.opened(1_000);
    await expect(watcher.waitFor(() => false, 1_000)).rejects.toThrow(/evicted/);
  });
});
