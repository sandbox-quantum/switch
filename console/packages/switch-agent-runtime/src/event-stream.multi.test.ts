import { afterEach, describe, expect, it, vi } from 'vitest';
import { type StreamScope, SwitchEventStream } from './event-stream';

/**
 * A connection that covers several rooms at once.
 *
 * `single` is a session in one room and `all` is a supervisor watching
 * everything it has not been shut out of. An agent reachable on a Slack channel
 * and at an email address is neither: it works in a declared set of rooms, and
 * one context has to cover all of them.
 *
 * The declaration has to survive a reconnect. Rooms go on the URL at open
 * rather than being subscribed afterwards because catch-up runs immediately —
 * a room claimed a moment later arrives too late for the buffered events a
 * resume exists to recover, and they are skipped as "not covered" *and* the
 * cursor advanced past them. That reasoning already governs one room; with
 * several, dropping any of them on reconnect silently loses that surface.
 */

const CREDS = {
  agentId: 'agent-1',
  apiEndpoint: 'https://switch.test/api',
  token: 'tok',
};

const SILENT = { debug() {}, warn() {}, error() {} };

type Harness = {
  urls: string[];
  waitForCalls(n: number): Promise<void>;
};

/** Records every stream URL and answers with a body that closes at once, so
 * the loop reconnects without waiting on a live socket. */
function stubFetch(): Harness {
  const urls: string[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];

  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/events?')) {
      urls.push(url);
      for (const w of [...waiters]) {
        if (urls.length >= w.n) {
          w.resolve();
          waiters.splice(waiters.indexOf(w), 1);
        }
      }
      return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
    }
    // Heartbeats and claims: acknowledged, uninteresting here.
    return new Response('{}', { status: 200 });
  });

  return {
    urls,
    waitForCalls(n: number) {
      if (urls.length >= n) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push({ n, resolve }));
    },
  };
}

/** `scope` is typed, not cast: until `StreamScope` admits `'multi'` this file
 * fails typecheck, which is the honest red. A cast would let the runtime test
 * pass over a scope no client can legally ask for. */
function open(rooms: string[], abort: AbortController, scope: StreamScope = 'multi') {
  const stream = new SwitchEventStream({
    creds: CREDS,
    connectionId: 'conn-1',
    scope,
    filter: 'all',
    rooms,
    onEvent() {},
    onGap() {},
    onEvicted() {},
    log: SILENT,
    signal: abort.signal,
  });
  stream.start();
  return stream;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('multi-scope stream', () => {
  it('declares the scope and every room on the opening request', async () => {
    const harness = stubFetch();
    const abort = new AbortController();
    open(['room-a', 'room-b'], abort);

    await harness.waitForCalls(1);
    abort.abort();

    const params = new URL(harness.urls[0]).searchParams;
    expect(params.get('scope')).toBe('multi');
    expect(params.get('rooms')?.split(',').sort()).toEqual(['room-a', 'room-b']);
  });

  it('re-declares every room on reconnect, not just one', async () => {
    /** Dropping a room here loses that surface silently: the socket is up, the
     * agent looks connected, and one of its two inboxes has simply gone quiet. */
    const harness = stubFetch();
    const abort = new AbortController();
    open(['room-a', 'room-b'], abort);

    await harness.waitForCalls(2);
    abort.abort();

    const params = new URL(harness.urls[1]).searchParams;
    expect(params.get('rooms')?.split(',').sort()).toEqual(['room-a', 'room-b']);
  }, 15_000);

  it('adds a room without dropping the ones already held', async () => {
    /**
     * `repoint` replaces the room set — right for a session moving between
     * rooms, wrong for an agent gaining a surface. Claiming has to be additive
     * under `multi` or acquiring an email room silences the Slack one.
     */
    const harness = stubFetch();
    const abort = new AbortController();
    const stream = open(['room-a'], abort);

    await harness.waitForCalls(1);
    await stream.claim('room-b');
    await harness.waitForCalls(2);
    abort.abort();

    const latest = new URL(harness.urls[harness.urls.length - 1]).searchParams;
    expect(latest.get('rooms')?.split(',').sort()).toEqual(['room-a', 'room-b']);
  }, 15_000);

  it('still replaces the room set when a single-scope stream repoints', async () => {
    /** Regression guard: the watcher path depends on `repoint` being a move. */
    const harness = stubFetch();
    const abort = new AbortController();
    const stream = open(['room-a'], abort, 'single');

    await harness.waitForCalls(1);
    await stream.repoint('room-b');
    await harness.waitForCalls(2);
    abort.abort();

    const latest = new URL(harness.urls[harness.urls.length - 1]).searchParams;
    expect(latest.get('rooms')).toBe('room-b');
  }, 15_000);

  it('takes the server as the authority on which rooms it covers', async () => {
    /**
     * A room can go dark because another connection claimed it. The server says
     * so on `subscription_changed`; a client that kept its own list would keep
     * re-declaring a room it no longer holds on every reconnect.
     */
    const harness = stubFetch();
    const abort = new AbortController();
    const stream = open(['room-a', 'room-b'], abort);

    await harness.waitForCalls(1);
    stream.acceptRooms(['room-a']);
    await harness.waitForCalls(2);
    abort.abort();

    const latest = new URL(harness.urls[harness.urls.length - 1]).searchParams;
    expect(latest.get('rooms')).toBe('room-a');
  }, 15_000);
});
