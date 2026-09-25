import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BEAT_INTERVAL_MS,
  BEAT_SETTLE_LIMIT_MS,
  EVICTION_CREDENTIALS_REJECTED,
  EVICTION_TAKEN_OVER,
  SwitchEventStream,
  type Eviction,
  type SwitchEventStreamDeps,
} from './event-stream';

/**
 * Two ways a client can retry something that can never succeed.
 *
 * Both were measured on a live deployment: a stream re-declaring a room that
 * had been deleted, refused on every open, reopening at once; and a heartbeat
 * treating "your connection is gone" as a normal answer and beating on at full
 * cadence. Neither could self-heal, and between them they produced most of the
 * error volume on that deployment.
 */

const creds = { agentId: 'agent-1', apiEndpoint: 'https://switch.test', token: 'tok' };

function silentLog() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function encodeFrame(name: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** The frame a server opens every stream with, naming the incarnation this
 * client is attached to. No `rooms`, so it says nothing about the declared set
 * a test may be asserting on. */
function connected(generation = 0): Uint8Array {
  return encodeFrame('connection_state', { connection_id: 'conn-1', generation });
}

/** A stream body carrying one frame and then closing, the way the server ends
 * a displaced stream. */
function frameThenClose(name: string, data: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeFrame(name, data));
      controller.close();
    },
  });
}

/**
 * A connected stream body that stays open, so the loop neither reconnects nor
 * spins.
 *
 * It announces the connection first because the heartbeat waits for that: a
 * client that has not been told which incarnation it is cannot fence its own
 * tick, and a body that never announces is a connection that never beats.
 */
function openForever(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(connected());
    },
  });
}

/**
 * A connected stream body that ends when the client drops the socket.
 *
 * `openForever` cannot: its reader is parked on a read that never returns, so
 * a reopen is invisible to the test rather than absent. A body that honours
 * the request's signal is what a real socket does, and what a test asserting
 * on reopens needs.
 */
function openUntilAborted(init: { signal: AbortSignal }): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(connected());
      init.signal.addEventListener('abort', () => controller.close(), { once: true });
    },
  });
}

/** The incarnation each beat carried, in order. */
function beatGenerations(fetchMock: { mock: { calls: unknown[][] } }): (number | null)[] {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).includes('connection/beat'))
    .map(
      (call) =>
        (JSON.parse((call[1] as { body: string }).body) as { generation: number | null }).generation
    );
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
        status: 404,
        body: null,
        text: async (): Promise<string> => JSON.stringify({ detail: 'No such connection' }),
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

describe('credentials the server rejects', () => {
  function refusal(status: number, detail: string) {
    return {
      ok: false,
      status,
      body: null,
      text: async (): Promise<string> => JSON.stringify({ detail }),
    };
  }

  /** Open once, be refused, and let a long while pass. */
  async function afterRefusal(status: number, detail: string) {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes('/events')
        ? refusal(status, detail)
        : { ok: true, status: 200, text: async (): Promise<string> => '' }
    );
    const evicted: Eviction[] = [];
    const { abort, log } = makeStream(fetchMock, {
      rooms: ['room-live'],
      onEvicted: (eviction) => evicted.push(eviction),
    });
    await vi.advanceTimersByTimeAsync(0);
    const settled = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    abort.abort();
    return { fetchMock, evicted, log, settled };
  }

  it('ends the stream and the heartbeat on a 401, and says so once', async () => {
    const { fetchMock, evicted, log, settled } = await afterRefusal(401, 'Invalid agent token');

    expect(urlsFor(fetchMock, '/events')).toHaveLength(1);
    // Nothing beyond the beat already in flight when the refusal landed.
    expect(fetchMock.mock.calls).toHaveLength(settled);
    expect(evicted).toHaveLength(1);
    expect(evicted[0]?.code).toBe(EVICTION_CREDENTIALS_REJECTED);
    expect(evicted[0]?.reason).toContain('credentials');
    expect(evicted[0]?.reason).toContain('401');
    expect(log.error).toHaveBeenCalled();
  });

  it('ends the stream on a 403 that names no declared room', async () => {
    const { fetchMock, evicted, settled } = await afterRefusal(
      403,
      'Agent is not a member of this room'
    );

    expect(urlsFor(fetchMock, '/events')).toHaveLength(1);
    expect(fetchMock.mock.calls).toHaveLength(settled);
    expect(evicted).toHaveLength(1);
    expect(evicted[0]?.code).toBe(EVICTION_CREDENTIALS_REJECTED);
    expect(evicted[0]?.reason).toContain('credentials');
    expect(evicted[0]?.reason).toContain('403');
  });

  it('ends the stream and the heartbeat on a 401 heartbeat, and says so once', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes('/events')
        ? { ok: true, status: 200, body: openForever(), text: async (): Promise<string> => '' }
        : refusal(401, 'Invalid agent token')
    );
    const evicted: Eviction[] = [];
    const { abort, log } = makeStream(fetchMock, {
      rooms: ['room-live'],
      onEvicted: (eviction) => evicted.push(eviction),
    });
    await vi.advanceTimersByTimeAsync(BEAT_INTERVAL_MS + 1);
    const settled = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    abort.abort();

    expect(urlsFor(fetchMock, 'connection/beat')).toHaveLength(1);
    expect(fetchMock.mock.calls).toHaveLength(settled);
    expect(evicted).toHaveLength(1);
    expect(evicted[0]?.code).toBe(EVICTION_CREDENTIALS_REJECTED);
    expect(evicted[0]?.reason).toContain('credentials');
    expect(evicted[0]?.reason).toContain('401');
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('tells the owner once when the stream and the heartbeat are refused together', async () => {
    vi.useFakeTimers();
    let opens = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/events')) {
        // Connected once — the heartbeat has nothing to beat for until then —
        // and refused on every reopen after that.
        opens += 1;
        if (opens === 1) {
          return {
            ok: true,
            status: 200,
            body: frameThenClose('connection_state', { connection_id: 'conn-1', generation: 0 }),
            text: async (): Promise<string> => '',
          };
        }
        await new Promise((r) => setTimeout(r, BEAT_INTERVAL_MS));
        return refusal(401, 'Invalid agent token');
      }
      // Slow enough to still be in flight when the reopen is refused: both
      // doors closing at once is the case this test is about.
      await new Promise((r) => setTimeout(r, 2 * BEAT_INTERVAL_MS));
      return refusal(401, 'Invalid agent token');
    });
    const evicted: Eviction[] = [];
    const { abort, log } = makeStream(fetchMock, {
      rooms: ['room-live'],
      onEvicted: (eviction) => evicted.push(eviction),
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    abort.abort();

    expect(urlsFor(fetchMock, '/events')).toHaveLength(2);
    expect(urlsFor(fetchMock, 'connection/beat')).toHaveLength(1);
    expect(evicted).toHaveLength(1);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it.each([503, 429])('keeps reconnecting after HTTP %i', async (status) => {
    vi.useFakeTimers();
    let opens = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (!String(url).includes('/events'))
        return { ok: true, status: 200, text: async (): Promise<string> => '' };
      opens += 1;
      return opens === 1
        ? { ok: false, status, body: null, text: async (): Promise<string> => 'try later' }
        : { ok: true, status: 200, body: openForever(), text: async (): Promise<string> => '' };
    });
    const evicted: Eviction[] = [];
    const { abort } = makeStream(fetchMock, {
      rooms: [],
      onEvicted: (eviction) => evicted.push(eviction),
    });

    await vi.advanceTimersByTimeAsync(2000);

    expect(urlsFor(fetchMock, '/events')).toHaveLength(2);
    expect(evicted).toEqual([]);
    abort.abort();
  });

  it('keeps reconnecting after a network error', async () => {
    vi.useFakeTimers();
    let opens = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (!String(url).includes('/events'))
        return { ok: true, status: 200, text: async (): Promise<string> => '' };
      opens += 1;
      if (opens === 1) throw new TypeError('fetch failed');
      return { ok: true, status: 200, body: openForever(), text: async (): Promise<string> => '' };
    });
    const evicted: Eviction[] = [];
    const { abort } = makeStream(fetchMock, {
      rooms: [],
      onEvicted: (eviction) => evicted.push(eviction),
    });

    await vi.advanceTimersByTimeAsync(2000);

    expect(urlsFor(fetchMock, '/events')).toHaveLength(2);
    expect(evicted).toEqual([]);
    abort.abort();
  });
});

describe('the heartbeat', () => {
  /** Beat requests made in `windowMs` of (fake) time, all of them rejected. */
  async function beatsWhileRejected(status: number, windowMs: number): Promise<number> {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/events'))
        return {
          ok: true,
          status: 200,
          body: openForever(),
          text: async (): Promise<string> => '',
        };
      return { ok: false, status, text: async (): Promise<string> => '' };
    });
    const { abort } = makeStream(fetchMock, { rooms: [] });
    await vi.advanceTimersByTimeAsync(windowMs);
    const beats = urlsFor(fetchMock, 'connection/beat').length;
    abort.abort();
    return beats;
  }

  it('backs off when the connection is rejected, instead of beating at full rate', async () => {
    const windowMs = 20 * BEAT_INTERVAL_MS;
    // At the base cadence this window holds ~20 beats. Doubling from the base
    // gives 4s, 8s, 16s… — four requests in the same window.
    expect(await beatsWhileRejected(404, windowMs)).toBeLessThanOrEqual(5);
    expect(await beatsWhileRejected(409, windowMs)).toBeLessThanOrEqual(5);
  });

  it('keeps backing off the longer the rejection lasts', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/events'))
        return {
          ok: true,
          status: 200,
          body: openForever(),
          text: async (): Promise<string> => '',
        };
      return { ok: false, status: 404, text: async (): Promise<string> => '' };
    });
    const { abort } = makeStream(fetchMock, { rooms: [] });

    await vi.advanceTimersByTimeAsync(30_000);
    const early = urlsFor(fetchMock, 'connection/beat').length;
    await vi.advanceTimersByTimeAsync(30_000);
    const late = urlsFor(fetchMock, 'connection/beat').length - early;

    expect(late).toBeLessThan(early);
    abort.abort();
  });

  it('sends nothing until the server has said which incarnation it is', async () => {
    vi.useFakeTimers();
    const server = { announce: (): void => {} };
    const fetchMock = vi.fn(async (url: string) => {
      if (!String(url).includes('/events'))
        return { ok: true, status: 200, text: async (): Promise<string> => '' };
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            server.announce = () => controller.enqueue(connected(7));
          },
        }),
        text: async (): Promise<string> => '',
      };
    });
    const { abort } = makeStream(fetchMock, { rooms: [] });

    await vi.advanceTimersByTimeAsync(10 * BEAT_INTERVAL_MS);
    // An unfenced tick is what a displaced client sends, and the server refuses
    // it. Beating before the first frame would make every healthy connection
    // open with one.
    expect(urlsFor(fetchMock, 'connection/beat')).toHaveLength(0);

    server.announce();
    await vi.advanceTimersByTimeAsync(BEAT_INTERVAL_MS);

    const beats = fetchMock.mock.calls.filter((c) => String(c[0]).includes('connection/beat'));
    expect(beats.length).toBeGreaterThan(0);
    // And it carries the incarnation that frame named, so the server can fence it.
    const [, sent] = beats[0] as unknown as [string, { body: string }];
    expect(JSON.parse(sent.body).generation).toBe(7);
    abort.abort();
  });

  it('waits for the new incarnation after its own reconnect, instead of standing down', async () => {
    vi.useFakeTimers();
    // A server that fences: every attach is a new incarnation, and a tick
    // naming an older one is refused the way a displaced client's is.
    const server = { generation: 0, announce: (): void => {}, drop: (): void => {} };
    const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
      if (String(url).includes('/events')) {
        server.generation += 1;
        const attached = server.generation;
        return {
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              const announce = (): void => controller.enqueue(connected(attached));
              // The first attach is announced at once; the second is held, so
              // the beat falls due inside the window this test is about.
              if (attached === 1) announce();
              else server.announce = announce;
              server.drop = () => controller.close();
            },
          }),
          text: async (): Promise<string> => '',
        };
      }
      const sent = (JSON.parse(init.body) as { generation: number | null }).generation;
      if (sent === server.generation)
        return { ok: true, status: 200, text: async (): Promise<string> => '' };
      return {
        ok: false,
        status: 409,
        text: async (): Promise<string> =>
          JSON.stringify({ detail: { code: 'taken_over', message: 'another stream attached' } }),
      };
    });
    const evicted: Eviction[] = [];
    const { abort } = makeStream(fetchMock, { rooms: [], onEvicted: (e) => evicted.push(e) });

    await vi.advanceTimersByTimeAsync(2 * BEAT_INTERVAL_MS);
    const first = beatGenerations(fetchMock);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((generation) => generation === 1)).toBe(true);

    server.drop();
    await vi.advanceTimersByTimeAsync(10 * BEAT_INTERVAL_MS);
    // Nothing went out while the reopen was in flight: the incarnation we hold
    // is the one before it, and a tick carrying that is a stand-down.
    expect(beatGenerations(fetchMock)).toHaveLength(first.length);
    expect(evicted).toEqual([]);

    server.announce();
    await vi.advanceTimersByTimeAsync(BEAT_INTERVAL_MS);
    const resumed = beatGenerations(fetchMock).slice(first.length);
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed.every((generation) => generation === 2)).toBe(true);
    expect(evicted).toEqual([]);
    abort.abort();
  });

  it('does not stand down over a beat that was already in flight when it reopened', async () => {
    vi.useFakeTimers();
    // The gate stops a beat *starting* inside the reattach window. It cannot
    // recall one that left before the gate shut, and that beat is answered
    // against the incarnation the reopen replaced — a truthful `taken_over`
    // about a takeover this client performed on itself.
    const server = {
      generation: 0,
      announce: (): void => {},
      drop: (): void => {},
      answerBeat: (): void => {},
      beatsHeld: 0,
    };
    const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
      if (String(url).includes('/events')) {
        const claimed = new URL(String(url)).searchParams.get('expected_generation');
        if (claimed !== null && Number(claimed) !== server.generation) {
          return {
            ok: false,
            status: 409,
            text: async (): Promise<string> =>
              JSON.stringify({ detail: { code: 'taken_over', message: 'reattach refused' } }),
          };
        }
        server.generation += 1;
        const attached = server.generation;
        return {
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(connected(attached));
              server.drop = () => controller.close();
            },
          }),
          text: async (): Promise<string> => '',
        };
      }
      const sent = (JSON.parse(init.body) as { generation: number | null }).generation;
      // Held rather than answered: the point of the test is an answer that
      // arrives after the connection has moved on beneath it.
      server.beatsHeld += 1;
      await new Promise<void>((resolve) => {
        server.answerBeat = resolve;
      });
      if (sent === server.generation)
        return { ok: true, status: 200, text: async (): Promise<string> => '' };
      return {
        ok: false,
        status: 409,
        text: async (): Promise<string> =>
          JSON.stringify({ detail: { code: 'taken_over', message: 'another stream attached' } }),
      };
    });
    const evicted: Eviction[] = [];
    const { abort } = makeStream(fetchMock, { rooms: [], onEvicted: (e) => evicted.push(e) });

    await vi.advanceTimersByTimeAsync(BEAT_INTERVAL_MS);
    expect(server.beatsHeld).toBe(1);
    expect(beatGenerations(fetchMock)).toEqual([1]);

    // Reopen with that beat still outstanding. The bound expires, the open goes
    // ahead, and the server is at 2 by the time the old beat is answered.
    server.drop();
    await vi.advanceTimersByTimeAsync(BEAT_SETTLE_LIMIT_MS + 10 * BEAT_INTERVAL_MS);
    expect(urlsFor(fetchMock, 'expected_generation=1')).toHaveLength(1);

    server.answerBeat();
    await vi.advanceTimersByTimeAsync(BEAT_INTERVAL_MS);

    // Undecidable, so inert. Standing down here stops a client that nothing
    // has taken anything from.
    expect(evicted).toEqual([]);
    const resumed = beatGenerations(fetchMock).slice(1);
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed.every((generation) => generation === 2)).toBe(true);
    abort.abort();
  });

  it('stands down when its reattach is refused, rather than trying again', async () => {
    vi.useFakeTimers();
    // The other half: a client that missed its eviction and comes back. The
    // server refuses the reattach without disturbing the holder, and this is
    // the only thing left that can tell the loser it lost.
    const server = { generation: 0, drop: (): void => {} };
    const fetchMock = vi.fn(async (url: string) => {
      if (!String(url).includes('/events'))
        return { ok: true, status: 200, text: async (): Promise<string> => '' };
      const claimed = new URL(String(url)).searchParams.get('expected_generation');
      if (claimed !== null) {
        // Someone else attached while we were away, so our claim is stale.
        return {
          ok: false,
          status: 409,
          text: async (): Promise<string> =>
            JSON.stringify({ detail: { code: 'taken_over', message: 'reattach refused' } }),
        };
      }
      server.generation += 1;
      const attached = server.generation;
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(connected(attached));
            server.drop = () => controller.close();
          },
        }),
        text: async (): Promise<string> => '',
      };
    });
    const evicted: Eviction[] = [];
    const { abort } = makeStream(fetchMock, { rooms: [], onEvicted: (e) => evicted.push(e) });

    await vi.advanceTimersByTimeAsync(BEAT_INTERVAL_MS);
    server.drop();
    await vi.advanceTimersByTimeAsync(20 * BEAT_INTERVAL_MS);

    expect(evicted.map((e) => e.code)).toEqual([EVICTION_TAKEN_OVER]);
    // And it stopped asking: retrying is how the pair trade the connection.
    const attempts = urlsFor(fetchMock, 'expected_generation=1').length;
    await vi.advanceTimersByTimeAsync(20 * BEAT_INTERVAL_MS);
    expect(urlsFor(fetchMock, 'expected_generation=1')).toHaveLength(attempts);
    abort.abort();
  });

  it('returns to the base cadence once a beat lands', async () => {
    vi.useFakeTimers();
    let reject = true;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/events'))
        return {
          ok: true,
          status: 200,
          body: openForever(),
          text: async (): Promise<string> => '',
        };
      if (reject) return { ok: false, status: 404, text: async (): Promise<string> => '' };
      return { ok: true, status: 200, text: async (): Promise<string> => '' };
    });
    const { abort } = makeStream(fetchMock, { rooms: [] });

    await vi.advanceTimersByTimeAsync(30_000);
    reject = false;
    await vi.advanceTimersByTimeAsync(30_000);
    const recovered = urlsFor(fetchMock, 'connection/beat').length;
    await vi.advanceTimersByTimeAsync(10 * BEAT_INTERVAL_MS);

    expect(urlsFor(fetchMock, 'connection/beat').length - recovered).toBeGreaterThanOrEqual(9);
    abort.abort();
  });
});

describe('a connection another client takes over', () => {
  it('stands down when the room it repoints to is refused, without reopening', async () => {
    // `repoint` claims the room *before* it reopens, so the open's own fence
    // is too late to protect the winner: by the time it refuses, a displaced
    // client has already rewritten the winner's rooms. The claim carries the
    // incarnation for that reason, and a refusal ends this client.
    const opens: string[] = [];
    const subscribes: (number | null)[] = [];
    const fetchMock = vi.fn(async (url: string, init: { body?: string }) => {
      if (String(url).includes('/events')) {
        opens.push(String(url));
        return {
          ok: true,
          status: 200,
          body: openForever(),
          text: async (): Promise<string> => '',
        };
      }
      if (String(url).includes('connection/subscribe')) {
        const sent = JSON.parse(init.body ?? '{}') as { generation: number | null };
        subscribes.push(sent.generation);
        return {
          ok: false,
          status: 409,
          text: async (): Promise<string> =>
            JSON.stringify({ detail: { code: 'taken_over', message: 'not your connection' } }),
        };
      }
      return { ok: true, status: 200, text: async (): Promise<string> => '' };
    });
    const evicted: Eviction[] = [];
    const { stream, abort } = makeStream(fetchMock, {
      rooms: ['!old'],
      onEvicted: (e) => evicted.push(e),
    });
    await flush();
    const opensBefore = opens.length;

    await stream.repoint('!new');
    await flush();

    // The claim named the incarnation the frame gave us, not nothing.
    expect(subscribes).toEqual([0]);
    expect(evicted.map((e) => e.code)).toEqual([EVICTION_TAKEN_OVER]);
    // No reopen: coming back would be the takeover the refusal just denied.
    expect(opens.length).toBe(opensBefore);
    abort.abort();
  });

  it('does not claim a room before the frame that names its incarnation', async () => {
    // Claiming nothing is how a client too old to have an incarnation gets
    // through, so a claim sent in the window before the first frame would go
    // through the same door — and that window is exactly when this client may
    // already have been displaced without knowing it.
    let announce: () => void = () => {};
    const subscribes: (number | null)[] = [];
    const fetchMock = vi.fn(async (url: string, init: { body?: string }) => {
      if (String(url).includes('/events'))
        return {
          ok: true,
          status: 200,
          // Attached, but silent: the server has not said which incarnation
          // this socket is yet.
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              announce = () => controller.enqueue(connected());
            },
          }),
          text: async (): Promise<string> => '',
        };
      if (String(url).includes('connection/subscribe')) {
        const sent = JSON.parse(init.body ?? '{}') as { generation: number | null };
        subscribes.push(sent.generation);
      }
      return { ok: true, status: 200, text: async (): Promise<string> => '' };
    });
    const { stream, abort } = makeStream(fetchMock, { rooms: ['!old'] });
    await flush();

    const repointed = stream.repoint('!new');
    await flush();

    expect(subscribes).toEqual([]);

    announce();
    await repointed;

    expect(subscribes).toEqual([0]);
    abort.abort();
  });

  it('halts instead of reopening, because reopening would be a takeover back', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes('/events')
        ? {
            ok: true,
            status: 200,
            body: frameThenClose('evicted', {
              code: 'taken_over',
              reason: 'another stream attached to this connection',
              room_id: null,
            }),
            text: async (): Promise<string> => '',
          }
        : { ok: true, status: 200, text: async (): Promise<string> => '' }
    );
    const evicted: Eviction[] = [];
    const { abort } = makeStream(fetchMock, {
      rooms: [],
      onEvicted: (eviction) => evicted.push(eviction),
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    // Two clients reopening each other's connection is the loop this prevents:
    // whoever reopens wins, so a displaced client that reopens starts it again.
    expect(urlsFor(fetchMock, '/events')).toHaveLength(1);
    expect(evicted).toEqual([
      {
        code: EVICTION_TAKEN_OVER,
        reason: 'another stream attached to this connection',
        roomId: null,
      },
    ]);
    abort.abort();
  });

  it('stands down when its heartbeat is refused, rather than taking the connection back', async () => {
    vi.useFakeTimers();
    // The case the SSE frame cannot cover: this client's socket dropped before
    // the eviction reached it, so the refused heartbeat is the only way it ever
    // hears that it lost.
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes('/events')
        ? { ok: true, status: 200, body: openForever(), text: async (): Promise<string> => '' }
        : {
            ok: false,
            status: 409,
            text: async (): Promise<string> =>
              JSON.stringify({
                detail: {
                  code: 'taken_over',
                  message: 'connection conn-1 was reopened since incarnation 0',
                },
              }),
          }
    );
    const evicted: Eviction[] = [];
    const { abort } = makeStream(fetchMock, {
      rooms: [],
      onEvicted: (eviction) => evicted.push(eviction),
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    // One beat and no second open: reopening is a takeover, so a loser that
    // reopens pulls the connection straight back off the client that won it.
    expect(urlsFor(fetchMock, 'connection/beat')).toHaveLength(1);
    expect(urlsFor(fetchMock, '/events')).toHaveLength(1);
    expect(evicted.map((e) => e.code)).toEqual([EVICTION_TAKEN_OVER]);
    abort.abort();
  });

  it('still reopens on a refusal that names no code, the way an old server sends it', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string, init: { signal: AbortSignal }) =>
      String(url).includes('/events')
        ? {
            ok: true,
            status: 200,
            body: openUntilAborted(init),
            text: async (): Promise<string> => '',
          }
        : {
            ok: false,
            status: 409,
            text: async (): Promise<string> =>
              JSON.stringify({ detail: 'connection conn-1 has no stream attached' }),
          }
    );
    const evicted: Eviction[] = [];
    const { abort } = makeStream(fetchMock, {
      rooms: [],
      onEvicted: (eviction) => evicted.push(eviction),
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    // Only the takeover is terminal. Everything else a 409 can mean is still
    // something a reopen fixes, and a server too old to say which is one of them.
    expect(urlsFor(fetchMock, '/events').length).toBeGreaterThan(1);
    expect(evicted).toEqual([]);
    abort.abort();
  });

  it('reads an old server’s wording as a takeover when it sends no code', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes('/events')
        ? {
            ok: true,
            status: 200,
            body: frameThenClose('evicted', {
              reason: 'another stream attached to this connection',
            }),
            text: async (): Promise<string> => '',
          }
        : { ok: true, status: 200, text: async (): Promise<string> => '' }
    );
    const evicted: Eviction[] = [];
    const { abort } = makeStream(fetchMock, {
      rooms: [],
      onEvicted: (eviction) => evicted.push(eviction),
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(evicted[0]?.code).toBe(EVICTION_TAKEN_OVER);
    expect(urlsFor(fetchMock, '/events')).toHaveLength(1);
    abort.abort();
  });
});

describe('a stream the server closes cleanly', () => {
  /** Opens, closes at once, forever — the shape of a contested connection. */
  function closesAtOnce() {
    return vi.fn(async (url: string) =>
      String(url).includes('/events')
        ? {
            ok: true,
            status: 200,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.close();
              },
            }),
            text: async (): Promise<string> => '',
          }
        : { ok: true, status: 200, text: async (): Promise<string> => '' }
    );
  }

  it('waits before reopening rather than reconnecting at full rate', async () => {
    vi.useFakeTimers();
    const fetchMock = closesAtOnce();
    const { abort } = makeStream(fetchMock, { rooms: [] });

    // A minute of 1s, 2s, 4s… is seven opens. Without pacing a clean close it
    // is an unbounded spin, limited only by how fast the server can answer.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(urlsFor(fetchMock, '/events').length).toBeLessThanOrEqual(8);
    abort.abort();
  });

  it('keeps backing off rather than resetting on every handshake', async () => {
    vi.useFakeTimers();
    const fetchMock = closesAtOnce();
    const { abort } = makeStream(fetchMock, { rooms: [] });

    await vi.advanceTimersByTimeAsync(60_000);
    const early = urlsFor(fetchMock, '/events').length;
    await vi.advanceTimersByTimeAsync(60_000);
    const late = urlsFor(fetchMock, '/events').length - early;

    // An open is not evidence of a working stream. Resetting the curve on the
    // handshake held two contending clients at a reconnect a second forever.
    expect(late).toBeLessThan(early);
    abort.abort();
  });
});

it('does not acknowledge a delivery before the consumer has saved it', async () => {
  let finish: () => void = () => {};
  const saved = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onEvent = vi.fn(() => saved);
  const fetchMock = vi.fn(async (url: string) => {
    if (!url.includes('/events')) return Response.json({});
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'id: 7\nevent: message\ndata: {"type":"message","room_id":"room","sequence":7}\n\n'
            )
          );
        },
      })
    );
  });
  const { stream, abort } = makeStream(fetchMock, { rooms: ['room'], startCursor: 6, onEvent });
  await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
  expect(stream.position).toBe(6);
  finish();
  await vi.waitFor(() => expect(stream.position).toBe(7));
  abort.abort();
});

it('replays from an explicitly saved zero cursor instead of starting at head', async () => {
  const fetchMock = vi
    .fn()
    .mockImplementation(async (url: string) =>
      url.includes('/events?')
        ? { ok: true, body: openForever() }
        : { ok: true, json: async () => ({ rooms: [] }) }
    );
  const { abort } = makeStream(fetchMock, { rooms: [], startCursor: 0 });
  try {
    await flush();
    expect(new URL(urlsFor(fetchMock, '/events?')[0]).searchParams.get('start_from')).toBe('0');
  } finally {
    abort.abort();
  }
});

function resetFrames(url: string): Response {
  if (!url.includes('/events')) return Response.json({});
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: gap\ndata: {"from_sequence":0,"resumed_at":0,"reason":"buffer reset"}\n\n' +
              'id: 1\nevent: message\ndata: {"type":"message","room_id":"room","sequence":1}\n\n'
          )
        );
      },
    })
  );
}

it('waits for durable reset checkpoint before advancing the cursor or delivering', async () => {
  let finish!: () => void;
  const saved = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onGap = vi.fn(() => saved);
  const onEvent = vi.fn();
  const { stream, abort } = makeStream(
    vi.fn(async (url: string) => resetFrames(url)),
    { rooms: ['room'], startCursor: 4, onGap, onEvent }
  );
  try {
    await vi.waitFor(() => expect(onGap).toHaveBeenCalledOnce());
    expect(onGap).toHaveBeenCalledWith({
      fromSequence: 0,
      resumedAt: 0,
      cursorReset: true,
      reason: 'buffer reset',
    });
    expect(stream.position).toBe(4);
    expect(onEvent).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(stream.position).toBe(1));
    expect(onEvent).toHaveBeenCalledOnce();
  } finally {
    abort.abort();
  }
});

it('does not advance or deliver when persisting the reset checkpoint fails', async () => {
  const onGap = vi.fn(async () => {
    throw new Error('journal unavailable');
  });
  const onEvent = vi.fn();
  const { stream, abort } = makeStream(
    vi.fn(async (url: string) => resetFrames(url)),
    { rooms: ['room'], startCursor: 4, onGap, onEvent }
  );
  try {
    await vi.waitFor(() => expect(onGap).toHaveBeenCalledOnce());
    expect(stream.position).toBe(4);
    expect(onEvent).not.toHaveBeenCalled();
  } finally {
    abort.abort();
  }
});

describe('the permission to start a session', () => {
  function reopenable() {
    return vi.fn(async (url: string, init: { signal: AbortSignal }) =>
      String(url).includes('/events')
        ? {
            ok: true,
            status: 200,
            body: openUntilAborted(init),
            text: async (): Promise<string> => '',
          }
        : { ok: true, status: 200, text: async (): Promise<string> => '' }
    );
  }

  it('is redeclared on the wire when it changes under a live connection', async () => {
    // Turning automatic sessions off while the controller is connected has to
    // reach the server, or it goes on promising a session nothing will start.
    const fetchMock = reopenable();
    const { stream, abort } = makeStream(fetchMock, { rooms: [], spawnCapable: true });
    await flush();
    expect(urlsFor(fetchMock, '/events')).toHaveLength(1);
    expect(urlsFor(fetchMock, '/events')[0]).toContain('spawn_capable=true');

    stream.setSpawnCapable(false);
    await flush();

    const opens = urlsFor(fetchMock, '/events');
    expect(opens).toHaveLength(2);
    expect(opens[1]).not.toContain('spawn_capable');
    // A reattach, not a takeover: the incarnation goes with it, so the server
    // recognises the same client rather than evicting it in favour of itself.
    expect(opens[1]).toContain('expected_generation=0');
    abort.abort();
  });

  /**
   * A server that fences reattaches the way the real one does: every accepted
   * open makes a new incarnation, and an open claiming an older one is refused.
   * `holdStateOn` withholds the frame naming the incarnation for one open, so a
   * test can act in the window where the client has not been told yet.
   */
  function fencingServer(holdStateOn: number) {
    let generation = 0;
    let opens = 0;
    const announce: Array<() => void> = [];
    const fetchMock = vi.fn(async (url: string, init: { signal: AbortSignal }) => {
      if (!String(url).includes('/events'))
        return { ok: true, status: 200, text: async (): Promise<string> => '' };
      const claimed = new URL(String(url)).searchParams.get('expected_generation');
      if (claimed !== null && Number(claimed) !== generation)
        return {
          ok: false,
          status: 409,
          text: async (): Promise<string> =>
            JSON.stringify({ detail: { code: EVICTION_TAKEN_OVER } }),
        };
      opens += 1;
      generation += 1;
      const held = opens === holdStateOn;
      const named = generation;
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            let closed = false;
            const send = () => {
              if (!closed) controller.enqueue(connected(named));
            };
            if (held) announce.push(send);
            else send();
            init.signal.addEventListener(
              'abort',
              () => {
                closed = true;
                controller.close();
              },
              { once: true }
            );
          },
        }),
        text: async (): Promise<string> => '',
      };
    });
    return { fetchMock, announce };
  }

  it('holds a second change until the server has answered the first', async () => {
    // Redeclaring reattaches, which claims the incarnation this client believes
    // it holds. A second change sent before the first open was answered claims
    // the one before it — which the server has moved past, and refuses as a
    // takeover. That would take the agent's only connection off the air over
    // two clicks in a row.
    const onEvicted = vi.fn();
    const { fetchMock, announce } = fencingServer(2);
    const { stream, abort } = makeStream(fetchMock, { rooms: [], spawnCapable: true, onEvicted });
    try {
      await flush();
      stream.setSpawnCapable(false);
      await flush();
      expect(urlsFor(fetchMock, '/events')).toHaveLength(2);

      // The reopen is out but unanswered, so this one has nothing safe to claim.
      stream.setSpawnCapable(true);
      await flush();
      expect(urlsFor(fetchMock, '/events')).toHaveLength(2);

      announce[0]();
      await flush();

      // Without the hold, this is where the connection has already gone: the
      // third open claims the incarnation the second one replaced.
      expect(onEvicted).not.toHaveBeenCalled();
      const opens = urlsFor(fetchMock, '/events');
      expect(opens).toHaveLength(3);
      expect(opens[2]).toContain('spawn_capable=true');
      expect(opens[2]).toContain('expected_generation=2');
    } finally {
      abort.abort();
    }
  });

  it('carries nothing when a change made in that window is taken back', async () => {
    const { fetchMock, announce } = fencingServer(2);
    const { stream, abort } = makeStream(fetchMock, { rooms: [], spawnCapable: true });
    try {
      await flush();
      stream.setSpawnCapable(false);
      await flush();
      stream.setSpawnCapable(true);
      stream.setSpawnCapable(false);
      await flush();

      announce[0]();
      await flush();

      // The held open already declares what the setting settled back to.
      expect(urlsFor(fetchMock, '/events')).toHaveLength(2);
    } finally {
      abort.abort();
    }
  });

  it('does not reopen the socket when it is set to what it already is', async () => {
    const fetchMock = reopenable();
    const { stream, abort } = makeStream(fetchMock, { rooms: [], spawnCapable: true });
    await flush();

    stream.setSpawnCapable(true);
    await flush();

    expect(urlsFor(fetchMock, '/events')).toHaveLength(1);
    abort.abort();
  });
});

it('routes command wakeups separately from room events and their cursor', async () => {
  const onCommands = vi.fn();
  const onEvent = vi.fn();
  const fetchMock = vi.fn(async (url: string) =>
    url.includes('/events')
      ? new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(connected());
              controller.enqueue(encodeFrame('session_commands', { session_ids: ['session'] }));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      : Response.json({})
  );
  const { abort } = makeStream(fetchMock, { rooms: [], scope: 'all', onCommands, onEvent });
  try {
    await vi.waitFor(() => expect(onCommands).toHaveBeenCalledWith(['session']));
    expect(onEvent).not.toHaveBeenCalled();
  } finally {
    abort.abort();
  }
});

function streaming(...frames: Uint8Array[]) {
  return vi.fn(async (url: string) =>
    url.includes('/events')
      ? new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(connected());
              for (const frame of frames) controller.enqueue(frame);
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      : Response.json({})
  );
}

it('hands an approval outcome to its own callback, not the room-event path', async () => {
  const onApprovalOutcome = vi.fn();
  const onEvent = vi.fn();
  const outcome = {
    session_id: 'session',
    request_id: 'permission',
    state: 'answered',
    answer: '0',
    answered_by: '@person:test',
    answered_at: '2026-09-24T12:00:00Z',
  };
  const { abort } = makeStream(streaming(encodeFrame('approval_outcome', outcome)), {
    rooms: [],
    scope: 'all',
    onApprovalOutcome,
    onEvent,
  });
  try {
    await vi.waitFor(() => expect(onApprovalOutcome).toHaveBeenCalledWith(outcome));
    expect(onEvent).not.toHaveBeenCalled();
  } finally {
    abort.abort();
  }
});

it('drops a frame it does not know that is not a room event', async () => {
  const onEvent = vi.fn();
  const { abort } = makeStream(
    streaming(
      encodeFrame('something_new', { detail: 'from a later server' }),
      encodeFrame('approval_outcome', { session_id: 'session' }),
      encodeFrame('message', { type: 'message', room_id: 'room', payload: {} })
    ),
    { rooms: [], scope: 'all', onEvent }
  );
  try {
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(onEvent).toHaveBeenCalledWith({ type: 'message', room_id: 'room', payload: {} });
  } finally {
    abort.abort();
  }
});

it('hands a relayed session command to its own callback', async () => {
  const onSessionCommand = vi.fn();
  const onEvent = vi.fn();
  const command = {
    contractVersion: 1,
    commandId: 'command-1',
    sessionId: 'session',
    epoch: 'epoch',
    origin: { surface: 'console', actorId: 'owner', roomId: null, threadId: null, messageId: null },
    body: { type: 'turn.interrupt', turnId: 'turn' },
  };
  const { abort } = makeStream(
    streaming(
      encodeFrame('session_command', { commandId: 'no-session' }),
      encodeFrame('session_command', command)
    ),
    { rooms: [], scope: 'all', onSessionCommand, onEvent }
  );
  try {
    await vi.waitFor(() => expect(onSessionCommand).toHaveBeenCalledWith(command));
    expect(onSessionCommand).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
  } finally {
    abort.abort();
  }
});

it('hands a room another connection took over to its own callback', async () => {
  const onRoomReleased = vi.fn();
  const onEvent = vi.fn();
  const { abort } = makeStream(
    streaming(
      encodeFrame('room_released', { session_id: 'no-room' }),
      encodeFrame('room_released', { room_id: 'room', session_id: 'session' }),
      encodeFrame('room_released', { room_id: 'other', session_id: null })
    ),
    { rooms: [], scope: 'all', onRoomReleased, onEvent }
  );
  try {
    await vi.waitFor(() => expect(onRoomReleased).toHaveBeenCalledTimes(2));
    expect(onRoomReleased).toHaveBeenNthCalledWith(1, { roomId: 'room', sessionId: 'session' });
    expect(onRoomReleased).toHaveBeenNthCalledWith(2, { roomId: 'other', sessionId: null });
    expect(onEvent).not.toHaveBeenCalled();
  } finally {
    abort.abort();
  }
});

it('says when the server has confirmed an open', async () => {
  const onConnected = vi.fn();
  const { abort } = makeStream(streaming(), { rooms: [], scope: 'all', onConnected });
  try {
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
  } finally {
    abort.abort();
  }
});

it('says when an open stream ended and it is trying again', async () => {
  const onConnected = vi.fn();
  const onDisconnected = vi.fn();
  let opens = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (!url.includes('/events')) return Response.json({});
    opens += 1;
    if (opens === 1)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(connected());
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      );
    return new Response(openForever(), { headers: { 'content-type': 'text/event-stream' } });
  });
  const { abort } = makeStream(fetchMock, {
    rooms: [],
    scope: 'all',
    onConnected,
    onDisconnected,
  });
  try {
    await vi.waitFor(() => expect(onDisconnected).toHaveBeenCalledTimes(1));
    expect(onDisconnected).toHaveBeenCalledWith({ error: 'the server closed the stream' });
    expect(onConnected).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  } finally {
    abort.abort();
  }
});

it('states placements on the attached incarnation, and raises on a refusal', async () => {
  const bodies: unknown[] = [];
  let refuse = false;
  const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.includes('/events'))
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(connected(4));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      );
    if (url.includes('connection/placements')) {
      bodies.push(JSON.parse(init!.body!));
      return refuse ? new Response('not a member', { status: 403 }) : Response.json({ ok: true });
    }
    return Response.json({});
  });
  const { stream, abort } = makeStream(fetchMock, { rooms: [], scope: 'all' });
  try {
    await stream.replacePlacements({ session: 'room' });
    expect(bodies).toEqual([
      { connection_id: 'conn-1', placements: { session: 'room' }, generation: 4 },
    ]);
    refuse = true;
    await expect(stream.replacePlacements({ session: 'elsewhere' })).rejects.toThrow('HTTP 403');
  } finally {
    abort.abort();
  }
});
