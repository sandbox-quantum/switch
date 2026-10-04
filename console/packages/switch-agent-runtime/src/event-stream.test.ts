import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVICTION_CREDENTIALS_REJECTED,
  EVICTION_TAKEN_OVER,
  SwitchEventStream,
  type Eviction,
  type SwitchEventStreamDeps,
} from './event-stream';

/**
 * The client side of the agent connection, held to what the server does.
 *
 * Much of what is pinned here was measured on a live deployment: a stream
 * re-declaring a room that had been deleted, refused on every open, reopening
 * at once; a client cancelling its own open and then standing down over the
 * incarnation that open made. Neither could self-heal.
 *
 * The server end is a fake WebSocket the test drives by hand: it accepts,
 * sends frames and pings, refuses, and closes, and records what the client
 * sent back. Its events are dispatched on the microtask queue, the way a real
 * socket's arrive as separate tasks, so nothing a test sends is seen before
 * the client has attached its listeners.
 */

const creds = { agentId: 'agent-1', apiEndpoint: 'https://switch.test', token: 'tok' };

type Listener = (event: { data?: string; code?: number; reason?: string }) => void;

/** What the server does with each socket the client opens, and its index. */
type Script = (socket: FakeSocket, index: number) => void;

/** Every socket opened in the current test, and the script that answers them. */
const server: { sockets: FakeSocket[]; script: Script } = {
  sockets: [],
  script: () => {},
};

/** Open and announce incarnation 0: a healthy, attached connection. */
const attach: Script = (socket) => {
  socket.open();
  socket.announce();
};

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = 0;
  readonly url: string;
  readonly headers: Record<string, string>;
  /** Every message the client sent, parsed. */
  readonly sent: unknown[] = [];
  /** The code the client closed with, if it was the one to close. */
  closedByClient: number | null = null;
  private ending = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string, init?: { headers?: Record<string, string> }) {
    this.url = url;
    this.headers = { ...init?.headers };
    server.sockets.push(this);
    server.script(this, server.sockets.length - 1);
  }

  get params(): URLSearchParams {
    return new URL(this.url).searchParams;
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000, reason = ''): void {
    if (this.ending) return;
    this.closedByClient = code;
    this.readyState = this.CLOSING;
    this.end(code, reason);
  }

  // The server's side.

  open(): void {
    this.dispatch(
      'open',
      {},
      () => this.readyState === this.CONNECTING,
      () => {
        this.readyState = this.OPEN;
      }
    );
  }

  frame(event: string, data: unknown, id?: number): void {
    const message = JSON.stringify({ event, data, ...(id === undefined ? {} : { id }) });
    this.dispatch('message', { data: message }, () => this.readyState === this.OPEN);
  }

  /** The frame a server opens every connection with, naming its incarnation.
   * No `rooms`, so it says nothing about the declared set a test may be
   * asserting on. */
  announce(generation = 0): void {
    this.frame('connection_state', { connection_id: 'conn-1', generation });
  }

  ping(): void {
    this.frame('ping', {});
  }

  /** Refuse the open the way the server does: say why, then close with the status. */
  refuse(status: number, detail: unknown): void {
    this.open();
    this.frame('refused', { status, detail });
    this.drop(4000 + status);
  }

  /** The server closes the socket. */
  drop(code = 1000, reason = ''): void {
    this.end(code, reason);
  }

  /** The connection fails underneath both ends, before or after it opened. */
  fail(): void {
    this.dispatch('error', {}, () => this.readyState !== this.CLOSED);
    this.end(1006, '');
  }

  private end(code: number, reason: string): void {
    if (this.ending) return;
    this.ending = true;
    this.dispatch(
      'close',
      { code, reason },
      () => true,
      () => {
        this.readyState = this.CLOSED;
      }
    );
  }

  private dispatch(
    type: string,
    event: { data?: string; code?: number; reason?: string },
    live: () => boolean,
    apply?: () => void
  ): void {
    queueMicrotask(() => {
      if (!live()) return;
      apply?.();
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    });
  }
}

function serve(script: Script): void {
  server.script = script;
}

function urls(): string[] {
  return server.sockets.map((socket) => socket.url);
}

function silentLog() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A request on the side that the server answered. */
function answer(status = 200, body = '') {
  return { ok: status >= 200 && status < 300, status, text: async (): Promise<string> => body };
}

function takenOver(message: string) {
  return answer(409, JSON.stringify({ detail: { code: 'taken_over', message } }));
}

function okFetch() {
  return vi.fn(async (_url: string, _init?: { body?: string }) => answer());
}

function postsTo(fetchMock: { mock: { calls: unknown[][] } }, fragment: string): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(fragment));
}

function makeStream(
  deps: Partial<SwitchEventStreamDeps> & { rooms: string[] },
  fetchMock: ReturnType<typeof vi.fn> = okFetch()
) {
  vi.stubGlobal('WebSocket', FakeSocket);
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
  return { stream, abort, log, fetchMock };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  server.sockets = [];
  server.script = attach;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the socket', () => {
  it('carries the token as a bearer header', async () => {
    const { abort } = makeStream({ rooms: [] });
    await flush();

    expect(server.sockets).toHaveLength(1);
    expect(server.sockets[0]?.headers).toEqual({ Authorization: 'Bearer tok' });
    abort.abort();
  });

  it('opens over wss for an https endpoint and ws for an http one', async () => {
    const secure = makeStream({ rooms: [] });
    await flush();
    secure.abort.abort();
    const plain = makeStream({
      rooms: [],
      creds: { ...creds, apiEndpoint: 'http://localhost:8000' },
    });
    await flush();
    plain.abort.abort();

    const [first, second] = urls();
    expect(first).toMatch(/^wss:\/\/switch\.test\/agents\/agent-1\/connection\/ws\?/);
    expect(second).toMatch(/^ws:\/\/localhost:8000\/agents\/agent-1\/connection\/ws\?/);
    expect(new URL(first!).searchParams.get('connection_id')).toBe('conn-1');
  });
});

describe('the heartbeat', () => {
  it('answers a ping at once with a pong carrying the cursor', async () => {
    serve((socket) => {
      attach(socket, 0);
      socket.frame('message', { type: 'message', room_id: 'room', sequence: 3 }, 3);
    });
    const { abort } = makeStream({ rooms: ['room'] });
    await flush();

    server.sockets[0]!.ping();
    await flush();

    expect(server.sockets[0]!.sent).toEqual([{ type: 'pong', cursor: 3 }]);
    abort.abort();
  });

  it('answers a ping while a slow handler is still running, without waiting for it', async () => {
    // Handling an event can take as long as the agent likes. A pong queued
    // behind it would have the server sweep a connection that is busy, not gone.
    let finish: () => void = () => {};
    const onEvent = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    serve((socket) => {
      attach(socket, 0);
      socket.frame('message', { type: 'message', room_id: 'room', sequence: 7 }, 7);
    });
    const { abort } = makeStream({ rooms: ['room'], startCursor: 6, onEvent });
    await flush();
    expect(onEvent).toHaveBeenCalledOnce();

    server.sockets[0]!.ping();
    await flush();
    // The cursor it names is the last event fully handled, not the one in hand.
    expect(server.sockets[0]!.sent).toEqual([{ type: 'pong', cursor: 6 }]);

    finish();
    await flush();
    server.sockets[0]!.ping();
    await flush();
    expect(server.sockets[0]!.sent).toEqual([
      { type: 'pong', cursor: 6 },
      { type: 'pong', cursor: 7 },
    ]);
    abort.abort();
  });

  it('makes no requests on the side to stay alive', async () => {
    vi.useFakeTimers();
    const { abort, fetchMock } = makeStream({ rooms: [] });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(server.sockets).toHaveLength(1);
    abort.abort();
  });
});

describe('a room the server refuses', () => {
  /** The refusal switch-core sends when a declared room no longer exists. */
  const roomGone = (socket: FakeSocket, roomId: string): void =>
    socket.refuse(403, `Room not found: ${roomId}`);

  it('is dropped and not declared again', async () => {
    serve((socket) =>
      socket.params.has('rooms') ? roomGone(socket, 'room-dead') : attach(socket, 0)
    );
    const rejected: { roomId: string; status: number }[] = [];
    const reported: string[][] = [];
    const { abort, log } = makeStream({
      rooms: ['room-dead'],
      onRooms: (rooms) => reported.push(rooms),
      onRoomRejected: ({ roomId, status }) => rejected.push({ roomId, status }),
    });
    await flush();

    const opens = server.sockets.map((socket) => socket.params);
    expect(opens).toHaveLength(2);
    expect(opens[0]?.get('rooms')).toBe('room-dead');
    expect(opens[1]?.has('rooms')).toBe(false);
    expect(rejected).toEqual([{ roomId: 'room-dead', status: 403 }]);
    expect(reported).toEqual([[]]);
    expect(log.error).toHaveBeenCalled();
    abort.abort();
  });

  it('keeps the rooms the refusal does not name', async () => {
    serve((socket) =>
      socket.params.get('rooms')?.includes('room-dead')
        ? roomGone(socket, 'room-dead')
        : attach(socket, 0)
    );
    const { abort } = makeStream({ rooms: ['room-dead', 'room-live'] });
    await flush();

    expect(server.sockets).toHaveLength(2);
    expect(server.sockets[1]?.params.get('rooms')).toBe('room-live');
    abort.abort();
  });

  it('stays a transport error when the refusal names no declared room', async () => {
    vi.useFakeTimers();
    serve((socket) => socket.refuse(404, 'No such connection'));
    const rejected: string[] = [];
    const { abort } = makeStream({
      rooms: ['room-live'],
      onRoomRejected: ({ roomId }) => rejected.push(roomId),
    });
    await vi.advanceTimersByTimeAsync(0);

    // One open, then the backoff: not an immediate retry, and nothing dropped.
    expect(server.sockets).toHaveLength(1);
    expect(rejected).toEqual([]);
    abort.abort();
  });
});

describe('credentials the server rejects', () => {
  /** Open once, be refused, and let a long while pass. */
  async function afterRefusal(refuse: Script) {
    vi.useFakeTimers();
    serve(refuse);
    const evicted: Eviction[] = [];
    const { abort, log, fetchMock } = makeStream({
      rooms: ['room-live'],
      onEvicted: (eviction) => evicted.push(eviction),
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    abort.abort();
    return { evicted, log, fetchMock };
  }

  it('ends the stream when the socket is closed for its token, and says so once', async () => {
    // An auth failure closes with 4401 and no `refused` frame before it.
    const { evicted, log, fetchMock } = await afterRefusal((socket) => {
      socket.open();
      socket.drop(4401, 'Invalid agent token');
    });

    expect(server.sockets).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(evicted).toHaveLength(1);
    expect(evicted[0]?.code).toBe(EVICTION_CREDENTIALS_REJECTED);
    expect(evicted[0]?.reason).toContain('credentials');
    expect(evicted[0]?.reason).toContain('401');
    expect(evicted[0]?.reason).toContain('Invalid agent token');
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('ends the stream on a 403 that names no declared room', async () => {
    const { evicted } = await afterRefusal((socket) =>
      socket.refuse(403, 'Agent is not a member of this room')
    );

    expect(server.sockets).toHaveLength(1);
    expect(evicted).toHaveLength(1);
    expect(evicted[0]?.code).toBe(EVICTION_CREDENTIALS_REJECTED);
    expect(evicted[0]?.reason).toContain('credentials');
    expect(evicted[0]?.reason).toContain('403');
  });

  it.each([503, 429])('keeps reconnecting after a refusal with status %i', async (status) => {
    vi.useFakeTimers();
    serve((socket, index) =>
      index === 0 ? socket.refuse(status, 'try later') : attach(socket, 0)
    );
    const evicted: Eviction[] = [];
    const { abort } = makeStream({
      rooms: [],
      onEvicted: (eviction) => evicted.push(eviction),
    });

    await vi.advanceTimersByTimeAsync(2000);

    expect(server.sockets).toHaveLength(2);
    expect(evicted).toEqual([]);
    abort.abort();
  });

  it('keeps reconnecting after a network error', async () => {
    vi.useFakeTimers();
    serve((socket, index) => (index === 0 ? socket.fail() : attach(socket, 0)));
    const evicted: Eviction[] = [];
    const disconnected: string[] = [];
    const { abort } = makeStream({
      rooms: [],
      onEvicted: (eviction) => evicted.push(eviction),
      onDisconnected: ({ error }) => disconnected.push(error),
    });

    await vi.advanceTimersByTimeAsync(2000);

    expect(server.sockets).toHaveLength(2);
    expect(evicted).toEqual([]);
    expect(disconnected).toHaveLength(1);
    expect(disconnected[0]).toContain('could not connect');
    abort.abort();
  });
});

describe('a server restart', () => {
  it('comes back within a second of the server, not on the doubling backoff', async () => {
    vi.useFakeTimers();
    // Open, then the server restarts: it closes with 1012, refuses three
    // attempts while it is down, then takes the fifth.
    serve((socket, index) => {
      if (index === 0) {
        attach(socket, 0);
        queueMicrotask(() => socket.drop(1012, 'service restart'));
      } else if (index < 4) {
        socket.fail();
      } else {
        attach(socket, 0);
      }
    });
    const { abort } = makeStream({ rooms: [] });

    await vi.advanceTimersByTimeAsync(4000);

    // On the doubling backoff the fifth attempt would come after 1+2+4+8 s.
    expect(server.sockets).toHaveLength(5);
    abort.abort();
  });

  it('keeps the doubling backoff for an ending that is not a restart', async () => {
    vi.useFakeTimers();
    serve((socket, index) => {
      if (index === 0) {
        attach(socket, 0);
        queueMicrotask(() => socket.drop(1006));
      } else {
        socket.fail();
      }
    });
    const { abort } = makeStream({ rooms: [] });

    await vi.advanceTimersByTimeAsync(4000);

    // Attempts at 1 s and 3 s: the next is not due until 7 s.
    expect(server.sockets).toHaveLength(3);
    abort.abort();
  });
});

describe('reopening while an open is still in flight', () => {
  /**
   * A server that keeps the incarnation the way the real one does: every open
   * it receives makes a new one, whether or not the client stays to read the
   * answer, and a reattach claiming an older one is refused as a takeover.
   * The next open can be held unanswered, the way a slow connection holds it.
   */
  function incarnationServer() {
    const state = { generation: 0, holdNext: false, release: (): void => {} };
    serve((socket) => {
      const claimed = socket.params.get('expected_generation');
      if (claimed !== null && Number(claimed) < state.generation) {
        socket.refuse(409, { code: 'taken_over', message: 'reattach refused' });
        return;
      }
      // The server acts on the open the moment it arrives.
      state.generation += 1;
      const generation = state.generation;
      const accept = (): void => {
        socket.open();
        socket.announce(generation);
      };
      if (!state.holdNext) return accept();
      state.holdNext = false;
      state.release = accept;
    });
    return state;
  }

  it('does not cancel an open the server has already acted on, and so does not stand down', async () => {
    // The self-takeover seen on the pilot. The server closes the stream, the
    // client starts reopening, and something asks for another reopen while
    // that open is unanswered. Cancelling the open in flight does not undo it
    // server-side: the client never reads the incarnation it made, reattaches
    // claiming the old one, is refused as a takeover, and stands down for
    // good. The "other client" was its own cancelled request.
    vi.useFakeTimers();
    const state = incarnationServer();
    const onEvicted = vi.fn();
    const { stream, abort } = makeStream({ rooms: [], spawnCapable: true, onEvicted });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.generation).toBe(1);

    state.holdNext = true;
    server.sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.sockets).toHaveLength(2);

    stream.setSpawnCapable(false);
    await vi.advanceTimersByTimeAsync(12_000);
    // Left to be answered rather than cancelled.
    expect(server.sockets).toHaveLength(2);
    expect(server.sockets[1]!.closedByClient).toBeNull();

    state.release();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onEvicted).not.toHaveBeenCalled();
    expect(server.sockets).toHaveLength(3);
    const carried = server.sockets[2]!.params;
    expect(carried.get('expected_generation')).toBe('2');
    expect(carried.has('spawn_capable')).toBe(false);
    expect(state.generation).toBe(3);
    abort.abort();
  });

  it('carries out a repoint asked for mid-open once that open is answered', async () => {
    // The other way into the same hole: a room change reopens to include the
    // new room. Mid-open, it must wait for the answer rather than cancel it,
    // and must still happen, since the open in flight may have been built
    // without it.
    vi.useFakeTimers();
    const state = incarnationServer();
    let subscribeDrops = true;
    const fetchMock = vi.fn(async (url: string, _init?: { body?: string }) => {
      if (url.includes('connection/subscribe') && subscribeDrops) {
        subscribeDrops = false;
        // The stream ends while the claim is still in flight.
        state.holdNext = true;
        server.sockets.at(-1)!.drop();
        await new Promise((r) => setTimeout(r, 3_000));
      }
      return answer();
    });
    const onEvicted = vi.fn();
    const { stream, abort } = makeStream({ rooms: ['room-a'], onEvicted }, fetchMock);
    await vi.advanceTimersByTimeAsync(0);

    const repointing = stream.repoint('room-b');
    // The claim returns while the stream's reopen is held unanswered.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.sockets).toHaveLength(2);
    expect(server.sockets[1]!.closedByClient).toBeNull();
    state.release();
    await vi.advanceTimersByTimeAsync(5_000);
    await repointing;

    expect(onEvicted).not.toHaveBeenCalled();
    expect(server.sockets.at(-1)!.params.get('rooms')).toBe('room-b');
    expect(server.sockets.at(-1)!.params.get('expected_generation')).toBe('2');
    abort.abort();
  });
});

describe('a connection another client takes over', () => {
  it('stands down when the room it repoints to is refused, without reopening', async () => {
    // `repoint` claims the room *before* it reopens, so the open's own fence
    // is too late to protect the winner: by the time it refuses, a displaced
    // client has already rewritten the winner's rooms. The claim carries the
    // incarnation for that reason, and a refusal ends this client.
    const subscribes: (number | null)[] = [];
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      if (!url.includes('connection/subscribe')) return answer();
      subscribes.push((JSON.parse(init?.body ?? '{}') as { generation: number | null }).generation);
      return takenOver('not your connection');
    });
    const evicted: Eviction[] = [];
    const { stream, abort } = makeStream(
      { rooms: ['!old'], onEvicted: (e) => evicted.push(e) },
      fetchMock
    );
    await flush();
    const opensBefore = server.sockets.length;

    await stream.repoint('!new');
    await flush();

    // The claim named the incarnation the frame gave us, not nothing.
    expect(subscribes).toEqual([0]);
    expect(evicted.map((e) => e.code)).toEqual([EVICTION_TAKEN_OVER]);
    // No reopen: coming back would be the takeover the refusal just denied.
    expect(server.sockets).toHaveLength(opensBefore);
    abort.abort();
  });

  it('does not claim a room before the frame that names its incarnation', async () => {
    // Claiming nothing is how a client too old to have an incarnation gets
    // through, so a claim sent in the window before the first frame would go
    // through the same door, and that window is exactly when this client may
    // already have been displaced without knowing it.
    serve((socket) => socket.open());
    const subscribes: (number | null)[] = [];
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.includes('connection/subscribe'))
        subscribes.push(
          (JSON.parse(init?.body ?? '{}') as { generation: number | null }).generation
        );
      return answer();
    });
    const { stream, abort } = makeStream({ rooms: ['!old'] }, fetchMock);
    await flush();

    const repointed = stream.repoint('!new');
    await flush();

    expect(subscribes).toEqual([]);

    server.sockets[0]!.announce();
    await repointed;

    expect(subscribes).toEqual([0]);
    abort.abort();
  });

  it('halts instead of reopening, because reopening would be a takeover back', async () => {
    vi.useFakeTimers();
    serve((socket) => {
      socket.open();
      socket.frame('evicted', {
        code: 'taken_over',
        reason: 'another stream attached to this connection',
        room_id: null,
      });
      socket.drop();
    });
    const evicted: Eviction[] = [];
    const { abort } = makeStream({
      rooms: [],
      onEvicted: (eviction) => evicted.push(eviction),
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    // Two clients reopening each other's connection is the loop this prevents:
    // whoever reopens wins, so a displaced client that reopens starts it again.
    expect(server.sockets).toHaveLength(1);
    expect(evicted).toEqual([
      {
        code: EVICTION_TAKEN_OVER,
        reason: 'another stream attached to this connection',
        roomId: null,
      },
    ]);
    abort.abort();
  });

  it('stands down when its reattach is refused, rather than trying again', async () => {
    // A client that missed its eviction and comes back. The server refuses
    // the reattach without disturbing the holder, and this is the only thing
    // left that can tell the loser it lost.
    vi.useFakeTimers();
    let generation = 0;
    serve((socket) => {
      if (socket.params.has('expected_generation')) {
        // Someone else attached while we were away, so our claim is stale.
        socket.refuse(409, { code: 'taken_over', message: 'reattach refused' });
        return;
      }
      generation += 1;
      socket.open();
      socket.announce(generation);
    });
    const evicted: Eviction[] = [];
    const { abort } = makeStream({ rooms: [], onEvicted: (e) => evicted.push(e) });

    await vi.advanceTimersByTimeAsync(0);
    server.sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(evicted.map((e) => e.code)).toEqual([EVICTION_TAKEN_OVER]);
    expect(server.sockets).toHaveLength(2);
    expect(server.sockets[1]!.params.get('expected_generation')).toBe('1');
    // And it stopped asking: retrying is how the pair trade the connection.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(server.sockets).toHaveLength(2);
    abort.abort();
  });

  it('still reopens on a refusal that names no code, the way an old server sends it', async () => {
    vi.useFakeTimers();
    serve((socket) => socket.refuse(409, 'connection conn-1 has no stream attached'));
    const evicted: Eviction[] = [];
    const { abort } = makeStream({
      rooms: [],
      onEvicted: (eviction) => evicted.push(eviction),
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    // Only the takeover is terminal. Everything else a 409 can mean is still
    // something a reopen fixes, and a server too old to say which is one of them.
    expect(server.sockets.length).toBeGreaterThan(1);
    expect(evicted).toEqual([]);
    abort.abort();
  });

  it('reads an old server’s wording as a takeover when it sends no code', async () => {
    vi.useFakeTimers();
    serve((socket) => {
      socket.open();
      socket.frame('evicted', { reason: 'another stream attached to this connection' });
      socket.drop();
    });
    const evicted: Eviction[] = [];
    const { abort } = makeStream({
      rooms: [],
      onEvicted: (eviction) => evicted.push(eviction),
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(evicted[0]?.code).toBe(EVICTION_TAKEN_OVER);
    expect(server.sockets).toHaveLength(1);
    abort.abort();
  });
});

describe('a stream the server closes cleanly', () => {
  /** Opens, closes at once, forever: the shape of a contested connection. */
  const closesAtOnce: Script = (socket) => {
    socket.open();
    socket.drop();
  };

  it('waits before reopening rather than reconnecting at full rate', async () => {
    vi.useFakeTimers();
    serve(closesAtOnce);
    const { abort } = makeStream({ rooms: [] });

    // A minute of 1s, 2s, 4s… is seven opens. Without pacing a clean close it
    // is an unbounded spin, limited only by how fast the server can answer.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(server.sockets.length).toBeLessThanOrEqual(8);
    abort.abort();
  });

  it('keeps backing off rather than resetting on every handshake', async () => {
    vi.useFakeTimers();
    serve(closesAtOnce);
    const { abort } = makeStream({ rooms: [] });

    await vi.advanceTimersByTimeAsync(60_000);
    const early = server.sockets.length;
    await vi.advanceTimersByTimeAsync(60_000);
    const late = server.sockets.length - early;

    // An open is not evidence of a working stream. Resetting the curve on the
    // handshake held two contending clients at a reconnect a second forever.
    expect(late).toBeLessThan(early);
    abort.abort();
  });

  it('starts the backoff over once a stream has lasted', async () => {
    vi.useFakeTimers();
    const openedAt: number[] = [];
    serve((socket, index) => {
      openedAt.push(Date.now());
      // Four that close at once climb the curve; the fifth stays up.
      if (index < 4) closesAtOnce(socket, index);
      else attach(socket, index);
    });
    const { abort } = makeStream({ rooms: [] });

    // Opens at 0, 1, 3, 7 and 15 seconds.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(server.sockets).toHaveLength(5);

    // Long enough to count as a working stream, then the server ends it.
    await vi.advanceTimersByTimeAsync(31_000);
    const closedAt = Date.now();
    server.sockets[4]!.drop();
    await vi.advanceTimersByTimeAsync(2_000);

    // Back at the first step of the curve, not the 16 seconds it had reached.
    expect(server.sockets).toHaveLength(6);
    expect(openedAt[5]! - closedAt).toBeLessThanOrEqual(1_000);
    abort.abort();
  });
});

describe('the cursor', () => {
  it('does not acknowledge a delivery before the consumer has saved it', async () => {
    let finish: () => void = () => {};
    const saved = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onEvent = vi.fn(() => saved);
    serve((socket) => {
      socket.open();
      socket.frame('message', { type: 'message', room_id: 'room', sequence: 7 }, 7);
    });
    const { stream, abort } = makeStream({ rooms: ['room'], startCursor: 6, onEvent });
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
    expect(stream.position).toBe(6);
    finish();
    await vi.waitFor(() => expect(stream.position).toBe(7));
    abort.abort();
  });

  it('replays from an explicitly saved zero cursor instead of starting at head', async () => {
    const { abort } = makeStream({ rooms: [], startCursor: 0 });
    try {
      await flush();
      expect(server.sockets[0]?.params.get('start_from')).toBe('0');
    } finally {
      abort.abort();
    }
  });

  it('starts at head when it has nothing saved, and resumes from its cursor on reconnect', async () => {
    vi.useFakeTimers();
    serve((socket, index) => {
      attach(socket, index);
      if (index === 0) {
        socket.frame('message', { type: 'message', room_id: 'room', sequence: 12 }, 12);
        socket.drop();
      }
    });
    const { abort } = makeStream({ rooms: ['room'] });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(server.sockets.map((socket) => socket.params.get('start_from'))).toEqual(['head', '12']);
    abort.abort();
  });

  /** A buffer reset, then the first event after it. */
  const reset: Script = (socket) => {
    socket.open();
    socket.frame('gap', { from_sequence: 0, resumed_at: 0, reason: 'buffer reset' });
    socket.frame('message', { type: 'message', room_id: 'room', sequence: 1 }, 1);
  };

  it('waits for durable reset checkpoint before advancing the cursor or delivering', async () => {
    let finish!: () => void;
    const saved = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onGap = vi.fn(() => saved);
    const onEvent = vi.fn();
    serve(reset);
    const { stream, abort } = makeStream({ rooms: ['room'], startCursor: 4, onGap, onEvent });
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
    serve(reset);
    const { stream, abort } = makeStream({ rooms: ['room'], startCursor: 4, onGap, onEvent });
    try {
      await vi.waitFor(() => expect(onGap).toHaveBeenCalledOnce());
      expect(stream.position).toBe(4);
      expect(onEvent).not.toHaveBeenCalled();
    } finally {
      abort.abort();
    }
  });
});

describe('the permission to start a session', () => {
  it('is redeclared on the wire when it changes under a live connection', async () => {
    // Turning automatic sessions off while the controller is connected has to
    // reach the server, or it goes on promising a session nothing will start.
    const { stream, abort } = makeStream({ rooms: [], spawnCapable: true });
    await flush();
    expect(server.sockets).toHaveLength(1);
    expect(server.sockets[0]?.params.get('spawn_capable')).toBe('true');

    stream.setSpawnCapable(false);
    await flush();

    expect(server.sockets).toHaveLength(2);
    expect(server.sockets[0]?.closedByClient).toBe(1000);
    expect(server.sockets[1]?.params.has('spawn_capable')).toBe(false);
    // A reattach, not a takeover: the incarnation goes with it, so the server
    // recognises the same client rather than evicting it in favour of itself.
    expect(server.sockets[1]?.params.get('expected_generation')).toBe('0');
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
    serve((socket) => {
      const claimed = socket.params.get('expected_generation');
      if (claimed !== null && Number(claimed) !== generation) {
        socket.refuse(409, { code: EVICTION_TAKEN_OVER });
        return;
      }
      opens += 1;
      generation += 1;
      const named = generation;
      socket.open();
      if (opens === holdStateOn) announce.push(() => socket.announce(named));
      else socket.announce(named);
    });
    return { announce };
  }

  it('holds a second change until the server has answered the first', async () => {
    // Redeclaring reattaches, which claims the incarnation this client believes
    // it holds. A second change sent before the first open was answered claims
    // the one before it, which the server has moved past and refuses as a
    // takeover. That would take the agent's only connection off the air over
    // two clicks in a row.
    const onEvicted = vi.fn();
    const { announce } = fencingServer(2);
    const { stream, abort } = makeStream({ rooms: [], spawnCapable: true, onEvicted });
    try {
      await flush();
      stream.setSpawnCapable(false);
      await flush();
      expect(server.sockets).toHaveLength(2);

      // The reopen is out but unanswered, so this one has nothing safe to claim.
      stream.setSpawnCapable(true);
      await flush();
      expect(server.sockets).toHaveLength(2);

      announce[0]!();
      await flush();

      // Without the hold, this is where the connection has already gone: the
      // third open claims the incarnation the second one replaced.
      expect(onEvicted).not.toHaveBeenCalled();
      expect(server.sockets).toHaveLength(3);
      expect(server.sockets[2]?.params.get('spawn_capable')).toBe('true');
      expect(server.sockets[2]?.params.get('expected_generation')).toBe('2');
    } finally {
      abort.abort();
    }
  });

  it('carries nothing when a change made in that window is taken back', async () => {
    const { announce } = fencingServer(2);
    const { stream, abort } = makeStream({ rooms: [], spawnCapable: true });
    try {
      await flush();
      stream.setSpawnCapable(false);
      await flush();
      stream.setSpawnCapable(true);
      stream.setSpawnCapable(false);
      await flush();

      announce[0]!();
      await flush();

      // The held open already declares what the setting settled back to.
      expect(server.sockets).toHaveLength(2);
    } finally {
      abort.abort();
    }
  });

  it('does not reopen the socket when it is set to what it already is', async () => {
    const { stream, abort } = makeStream({ rooms: [], spawnCapable: true });
    await flush();

    stream.setSpawnCapable(true);
    await flush();

    expect(server.sockets).toHaveLength(1);
    abort.abort();
  });
});

describe('frames that are not room events', () => {
  /** An attached connection that then sends these frames. */
  function streaming(...frames: [string, unknown][]): void {
    serve((socket) => {
      attach(socket, 0);
      for (const [event, data] of frames) socket.frame(event, data);
    });
  }

  it('routes command wakeups separately from room events and their cursor', async () => {
    const onCommands = vi.fn();
    const onEvent = vi.fn();
    streaming(['session_commands', { session_ids: ['session'] }]);
    const { stream, abort } = makeStream({ rooms: [], scope: 'all', onCommands, onEvent });
    try {
      await vi.waitFor(() => expect(onCommands).toHaveBeenCalledWith(['session']));
      expect(onEvent).not.toHaveBeenCalled();
      expect(stream.position).toBe(0);
    } finally {
      abort.abort();
    }
  });

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
    streaming(['approval_outcome', outcome]);
    const { abort } = makeStream({ rooms: [], scope: 'all', onApprovalOutcome, onEvent });
    try {
      await vi.waitFor(() => expect(onApprovalOutcome).toHaveBeenCalledWith(outcome));
      expect(onEvent).not.toHaveBeenCalled();
    } finally {
      abort.abort();
    }
  });

  it('drops a frame it does not know that is not a room event', async () => {
    const onEvent = vi.fn();
    streaming(
      ['something_new', { detail: 'from a later server' }],
      ['approval_outcome', { session_id: 'session' }],
      ['message', { type: 'message', room_id: 'room', payload: {} }]
    );
    const { abort } = makeStream({ rooms: [], scope: 'all', onEvent });
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
      origin: {
        surface: 'console',
        actorId: 'owner',
        roomId: null,
        threadId: null,
        messageId: null,
      },
      body: { type: 'turn.interrupt', turnId: 'turn' },
    };
    streaming(['session_command', { commandId: 'no-session' }], ['session_command', command]);
    const { abort } = makeStream({ rooms: [], scope: 'all', onSessionCommand, onEvent });
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
    streaming(
      ['room_released', { session_id: 'no-room' }],
      ['room_released', { room_id: 'room', session_id: 'session' }],
      ['room_released', { room_id: 'other', session_id: null }]
    );
    const { abort } = makeStream({ rooms: [], scope: 'all', onRoomReleased, onEvent });
    try {
      await vi.waitFor(() => expect(onRoomReleased).toHaveBeenCalledTimes(2));
      expect(onRoomReleased).toHaveBeenNthCalledWith(1, { roomId: 'room', sessionId: 'session' });
      expect(onRoomReleased).toHaveBeenNthCalledWith(2, { roomId: 'other', sessionId: null });
      expect(onEvent).not.toHaveBeenCalled();
    } finally {
      abort.abort();
    }
  });
});

describe('the connection’s lifecycle', () => {
  it('says when the server has confirmed an open', async () => {
    const onConnected = vi.fn();
    const { abort } = makeStream({ rooms: [], scope: 'all', onConnected });
    try {
      await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    } finally {
      abort.abort();
    }
  });

  it('says when an open stream ended and it is trying again', async () => {
    vi.useFakeTimers();
    serve((socket, index) => {
      attach(socket, index);
      if (index === 0) socket.drop();
    });
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();
    const { abort } = makeStream({ rooms: [], scope: 'all', onConnected, onDisconnected });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(onDisconnected).toHaveBeenCalledTimes(1);
      expect(onDisconnected).toHaveBeenCalledWith({ error: 'the server closed the stream' });
      expect(onConnected).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(onConnected).toHaveBeenCalledTimes(2);
      expect(onDisconnected).toHaveBeenCalledTimes(1);
    } finally {
      abort.abort();
    }
  });
});

describe('placements', () => {
  it('states placements on the attached incarnation, and raises on a refusal', async () => {
    serve((socket) => {
      socket.open();
      socket.announce(4);
    });
    const bodies: unknown[] = [];
    let refuse = false;
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      if (!url.includes('connection/placements')) return answer();
      bodies.push(JSON.parse(init!.body!));
      return refuse ? answer(403, 'not a member') : answer(200, '{"ok":true}');
    });
    const { stream, abort } = makeStream({ rooms: [], scope: 'all' }, fetchMock);
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

  it('does not give its connection up to itself over a request answered across its own reopen', async () => {
    // Seen on a real host: placements stated under incarnation 4, the stream
    // reopened (to 5) before the answer came, and the answer, "taken over:
    // reopened since 4, now at 5", named this very client as the new holder.
    // It stood down for good, with nobody else anywhere near the connection.
    vi.useFakeTimers();
    serve((socket, index) => {
      socket.open();
      socket.announce(4 + index);
    });
    let answerPlacements: (response: ReturnType<typeof answer>) => void = () => {};
    const fetchMock = vi.fn(async (url: string, _init?: { body?: string }) =>
      url.includes('connection/placements')
        ? new Promise<ReturnType<typeof answer>>((resolve) => {
            answerPlacements = resolve;
          })
        : answer()
    );
    const evicted: Eviction[] = [];
    const onConnected = vi.fn();
    const { stream, abort } = makeStream(
      {
        rooms: [],
        scope: 'all',
        onConnected,
        onEvicted: (eviction) => evicted.push(eviction),
      },
      fetchMock
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(onConnected).toHaveBeenCalledTimes(1);
      const stating = stream.replacePlacements({ session: 'room' });
      const settled = expect(stating).rejects.toThrow('409');
      await vi.advanceTimersByTimeAsync(0);
      expect(postsTo(fetchMock, 'connection/placements')).toHaveLength(1);

      server.sockets[0]!.drop();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onConnected).toHaveBeenCalledTimes(2);
      answerPlacements(
        takenOver('connection conn-1 has been reopened since incarnation 4 and is now at 5')
      );

      await settled;
      expect(evicted).toEqual([]);
    } finally {
      abort.abort();
    }
  });

  it('still stands down when a request is refused as taken over on the incarnation it holds', async () => {
    serve((socket) => {
      socket.open();
      socket.announce(4);
    });
    const fetchMock = vi.fn(async (url: string, _init?: { body?: string }) =>
      url.includes('connection/placements') ? takenOver('another client holds it') : answer()
    );
    const evicted: Eviction[] = [];
    const { stream, abort } = makeStream(
      { rooms: [], scope: 'all', onEvicted: (eviction) => evicted.push(eviction) },
      fetchMock
    );
    try {
      await expect(stream.replacePlacements({ session: 'room' })).rejects.toThrow('409');
      expect(evicted.map((eviction) => eviction.code)).toEqual([EVICTION_TAKEN_OVER]);
    } finally {
      abort.abort();
    }
  });
});
