import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InjectionTarget } from './injection-sink';
import { type PromptInjector, RoomConnection } from './room-connection';
import { resolveSessionControl } from './session-control';
import type { AgentBridgeEvent } from './switch-event-format';

/**
 * One managed session in more than one room.
 *
 * Switch Console opened every connection with `scope: 'single'` and held
 * `roomId: string | null`, which was right while a session was one room. The
 * server and the agent runtime both learned to span several surfaces; this side
 * did not, so a Switch Console-managed session could be woken in one room and
 * only one — and connecting it to a second silently released the first.
 *
 * What is deliberately NOT changed here: the app's own bookkeeping is still one
 * room per session (`session_room_connections.sessionId` is a primary key), so
 * `onRoomsChanged` still reports a primary room to everything downstream and
 * the UI still shows one. The connection serves both; the badge is behind. That
 * is a real gap, and a smaller one than a schema migration.
 *
 * The failures these guard against are all silent: a room whose events stop
 * arriving with the socket up, a reply routed to the wrong surface, a "working
 * on it" indicator that appears in a room nobody asked in.
 */

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const creds = { agentId: 'agent-1', apiEndpoint: 'https://switch.test', token: 'tok' };
const mediaDir = path.join(os.tmpdir(), 'switchdash-multi-room-test');
const injector: PromptInjector = {
  build: (text) => ({ payload: `<<${text}>>`, submitSequence: '\r', submitDelayMs: 0 }),
};
const control = resolveSessionControl('claude');

const ROOM_A = 'room-a';
const ROOM_B = 'room-b';

function addressed(roomId: string, body: string, messageId: string): AgentBridgeEvent {
  return {
    type: 'message',
    room_id: roomId,
    payload: {
      addressed: true,
      sender: '@someone:switch',
      sender_name: 'Someone',
      message_id: messageId,
      body,
      timestamp: 1,
      thread_id: null,
      attachments: [],
    },
  };
}

/** SSE framing, with the server declaring which rooms the connection covers. */
function sseBody(events: AgentBridgeEvent[], rooms: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'event: connection_state\n' +
            `data: ${JSON.stringify({ connection_id: 'c1', rooms, cursor: 0 })}\n\n`
        )
      );
      events.forEach((event, i) => {
        controller.enqueue(
          encoder.encode(
            `id: ${i + 1}\nevent: ${event.type}\n` +
              `data: ${JSON.stringify({ ...event, sequence: i + 1 })}\n\n`
          )
        );
      });
      // Left open: closing reads as a dropped stream and triggers a reconnect.
    },
  });
}

function makeFetch(events: AgentBridgeEvent[], declared: string[]) {
  let served = false;
  return vi.fn(async (url: string, _opts?: RequestInit) => {
    const u = String(url);
    if (u.includes('/media')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        text: async () => '',
      };
    }
    if (u.includes('/events')) {
      if (!served) {
        served = true;
        return { ok: true, status: 200, body: sseBody(events, declared), text: async () => '' };
      }
      return new Promise(() => {});
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  });
}

function runtimeStatePosts(fetchMock: ReturnType<typeof makeFetch>) {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/runtime-state'))
    .map((c) => JSON.parse((c[1] as RequestInit).body as string));
}

function streamUrl(fetchMock: ReturnType<typeof makeFetch>): URL {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/events'));
  return new URL(String(call?.[0]));
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
}

function collectingSink() {
  const written: string[] = [];
  const target: InjectionTarget = {
    write: (s: string) => {
      written.push(s);
    },
  } as unknown as InjectionTarget;
  return { written, acquire: () => target };
}

describe('a managed session spanning several rooms', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function connect(options: { rooms: string[]; declared?: string[]; events?: AgentBridgeEvent[] }) {
    const sink = collectingSink();
    const fetchMock = makeFetch(options.events ?? [], options.declared ?? options.rooms);
    vi.stubGlobal('fetch', fetchMock);
    const seen: string[][] = [];
    const conn = new RoomConnection({
      creds,
      rooms: options.rooms,
      roomName: null,
      connectionId: 'conn-1',
      sessionId: 'session-1',
      sink,
      injector,
      control,
      deeplinkScheme: 'switchdash',
      isHumanTyping: () => false,
      mediaDir,
      spawnTurn: null,
      onRoomsChanged: (rooms) => seen.push(rooms),
      log: silentLog,
    });
    conn.start();
    return { conn, fetchMock, sink, seen };
  }

  it('opens the stream as `multi`, declaring every room', async () => {
    /**
     * Catch-up runs the moment the stream opens. A room left off the URL has
     * its buffered events skipped as "not covered" *and* its cursor advanced
     * past them, so that surface goes quiet with the socket up.
     */
    const { conn, fetchMock } = connect({ rooms: [ROOM_A, ROOM_B] });
    await flush();

    const url = streamUrl(fetchMock);
    expect(url.searchParams.get('scope')).toBe('multi');
    expect(url.searchParams.get('rooms')).toBe(`${ROOM_A},${ROOM_B}`);

    conn.stop();
  });

  it('adopts every room the server reports, not just the first', async () => {
    /** `adoptRoom` took `rooms[0]` and dropped the rest, which under `multi` is
     * the connection forgetting a surface it is actually serving. */
    const { conn } = connect({ rooms: [], declared: [ROOM_A, ROOM_B] });
    await flush();

    expect(conn.rooms).toEqual([ROOM_A, ROOM_B]);

    conn.stop();
  });

  it('keeps the room it had when the server adds a second', async () => {
    const { conn } = connect({ rooms: [ROOM_A], declared: [ROOM_A, ROOM_B] });
    await flush();

    expect(conn.rooms).toContain(ROOM_A);
    expect(conn.rooms).toContain(ROOM_B);

    conn.stop();
  });

  it('injects an event from the second room rather than dropping it', async () => {
    /** The whole point. Under `single` this event was for a room the connection
     * did not think it had. */
    const { conn, sink } = connect({
      rooms: [ROOM_A, ROOM_B],
      events: [addressed(ROOM_B, 'over here', 'm-b')],
    });
    await flush();

    expect(sink.written.join('')).toContain('over here');

    conn.stop();
  });

  it('reports runtime state against the room the message came from', async () => {
    /**
     * `room_id` was `this.roomId` — one fixed value — so a turn started by a
     * message in B raised "working on it" in A. The indicator appears in a room
     * nobody asked in, and never in the one that did.
     */
    const { conn, fetchMock } = connect({
      rooms: [ROOM_A, ROOM_B],
      events: [addressed(ROOM_B, 'over here', 'm-b')],
    });
    await flush();

    const working = runtimeStatePosts(fetchMock).filter((b) => b.state === 'working');
    expect(working.length).toBeGreaterThan(0);
    expect(working.every((b) => b.room_id === ROOM_B)).toBe(true);

    conn.stop();
  });

  it('anchors the turn to the message that started it, in its own room', async () => {
    const { conn, fetchMock } = connect({
      rooms: [ROOM_A, ROOM_B],
      events: [addressed(ROOM_B, 'over here', 'm-b')],
    });
    await flush();

    const working = runtimeStatePosts(fetchMock).filter((b) => b.state === 'working');
    expect(working.at(0)?.anchor_event_id).toBe('m-b');

    conn.stop();
  });

  it('routes two rooms independently within one session', async () => {
    /** Both surfaces, one context window — and each answered where it was
     * asked. Asserts the pairing, not merely that both were seen. */
    const { conn, fetchMock } = connect({
      rooms: [ROOM_A, ROOM_B],
      events: [addressed(ROOM_A, 'first', 'm-a'), addressed(ROOM_B, 'second', 'm-b')],
    });
    await flush(10);

    const working = runtimeStatePosts(fetchMock).filter((b) => b.state === 'working');
    const pairs = working.map((b) => `${b.room_id}:${b.anchor_event_id}`);
    expect(pairs).toContain(`${ROOM_A}:m-a`);
    expect(pairs).toContain(`${ROOM_B}:m-b`);

    conn.stop();
  });

  it('tells the app a primary room, so one-room bookkeeping still works', async () => {
    /**
     * Deliberate: `session_room_connections.sessionId` is a primary key, so the
     * store, the service and the renderer badge all still take one room. The
     * connection serves several and reports the first.
     */
    const { conn, seen } = connect({ rooms: [], declared: [ROOM_A, ROOM_B] });
    await flush();

    expect(seen.at(-1)).toEqual([ROOM_A, ROOM_B]);
    expect(conn.room).toBe(ROOM_A);

    conn.stop();
  });

  it('has no room, and no primary, before the server has said', () => {
    const { conn } = connect({ rooms: [] });

    expect(conn.rooms).toEqual([]);
    expect(conn.room).toBeNull();

    conn.stop();
  });

  it('fetches an attachment from the room its message arrived in', async () => {
    /** The media URL is per room. Built from a fixed room it 404s for one
     * surface, and the agent is told the file could not be retrieved. */
    const event = addressed(ROOM_B, 'see this', 'm-b');
    (event.payload as { attachments: unknown[] }).attachments = [
      { mxc: 'mxc://switch.test/abc', filename: 'note.txt', mimetype: 'text/plain', size: 3 },
    ];
    const { conn, fetchMock } = connect({ rooms: [ROOM_A, ROOM_B], events: [event] });
    await flush(10);

    const media = fetchMock.mock.calls.map(String).filter((u) => u.includes('/media'));
    expect(media.length).toBeGreaterThan(0);
    expect(media.every((u) => u.includes(`/rooms/${ROOM_B}/media`))).toBe(true);

    conn.stop();
  });
});
