import { afterEach, describe, expect, it, vi } from 'vitest';
import { SwitchEventStream, type SwitchEventStreamDeps } from './event-stream';

/**
 * A client retrying something that can never succeed.
 *
 * Measured on a live deployment: a stream re-declaring a room that had been
 * deleted, refused on every open, reopening at once, for over a day. It could
 * not self-heal, and it produced most of the error volume on that deployment.
 */

const creds = { agentId: 'agent-1', apiEndpoint: 'https://switch.test', token: 'tok' };

function silentLog() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A stream body that stays open, so the loop neither reconnects nor spins. */
function openForever(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start() {} });
}

function urlsFor(fetchMock: { mock: { calls: unknown[][] } }, fragment: string): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(fragment));
}

function makeStream(
  fetchMock: ReturnType<typeof vi.fn>,
  deps: Partial<SwitchEventStreamDeps> & { rooms: string[] }
) {
  vi.stubGlobal('fetch', fetchMock);
  const abort = new AbortController();
  const log = silentLog();
  const stream = new SwitchEventStream({
    creds,
    connectionId: 'conn-1',
    scope: 'single',
    filter: 'all',
    onEvent: () => {},
    onGap: () => {},
    onEvicted: () => {},
    log,
    signal: abort.signal,
    ...deps,
  });
  stream.start();
  return { stream, abort, log };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a room the server refuses', () => {
  /** The refusal switch-core returns when a declared room no longer exists. */
  function roomGone(roomId: string) {
    return {
      ok: false,
      status: 403,
      body: null,
      text: async (): Promise<string> => JSON.stringify({ detail: `Room not found: ${roomId}` }),
    };
  }

  it('is dropped and not declared again', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (!String(url).includes('/events')) {
        return { ok: true, status: 200, text: async (): Promise<string> => '' };
      }
      return String(url).includes('rooms=')
        ? roomGone('room-dead')
        : { ok: true, status: 200, body: openForever(), text: async (): Promise<string> => '' };
    });
    const rejected: { roomId: string; status: number }[] = [];
    const reported: string[][] = [];
    const { abort, log } = makeStream(fetchMock, {
      rooms: ['room-dead'],
      onRooms: (rooms) => reported.push(rooms),
      onRoomRejected: ({ roomId, status }) => rejected.push({ roomId, status }),
    });
    await flush();

    const opens = urlsFor(fetchMock, '/events');
    expect(opens).toHaveLength(2);
    expect(opens[0]).toContain('rooms=room-dead');
    expect(opens[1]).not.toContain('rooms=');
    expect(rejected).toEqual([{ roomId: 'room-dead', status: 403 }]);
    expect(reported).toEqual([[]]);
    expect(log.error).toHaveBeenCalled();
    abort.abort();
  });

  it('keeps the rooms the refusal does not name', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (!u.includes('/events'))
        return { ok: true, status: 200, text: async (): Promise<string> => '' };
      return u.includes('room-dead')
        ? roomGone('room-dead')
        : { ok: true, status: 200, body: openForever(), text: async (): Promise<string> => '' };
    });
    const { abort } = makeStream(fetchMock, { rooms: ['room-dead', 'room-live'] });
    await flush();

    const opens = urlsFor(fetchMock, '/events');
    expect(opens).toHaveLength(2);
    expect(decodeURIComponent(opens[1])).toContain('rooms=room-live');
    abort.abort();
  });

  it('stays a transport error when the body names no declared room', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) => {
      if (!String(url).includes('/events')) {
        return { ok: true, status: 200, text: async (): Promise<string> => '' };
      }
      return {
        ok: false,
        status: 403,
        body: null,
        text: async (): Promise<string> =>
          JSON.stringify({ detail: 'Agent is not a member of this room' }),
      };
    });
    const rejected: string[] = [];
    const { abort } = makeStream(fetchMock, {
      rooms: ['room-live'],
      onRoomRejected: ({ roomId }) => rejected.push(roomId),
    });
    await vi.advanceTimersByTimeAsync(0);

    // One open, then the backoff — not an immediate retry, and nothing dropped.
    expect(urlsFor(fetchMock, '/events')).toHaveLength(1);
    expect(rejected).toEqual([]);
    abort.abort();
  });
});
