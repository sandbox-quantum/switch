import { describe, expect, it } from 'vitest';
import { RoomSet } from './room-set';

/**
 * The rooms one runtime process is acting in.
 *
 * `bin.ts` held this as a single `string | null`, which was right while a
 * session was one room. Every rule here has a failure that is silent — a
 * surface that stops receiving with the socket up, a reply that goes to the
 * wrong room — which is why the set is extracted from a file that cannot be
 * imported and therefore cannot be tested.
 */

const A = '!a:switch.local';
const B = '!b:switch.local';
const C = '!c:switch.local';

describe('single scope', () => {
  it('replaces the room, and says which one to release', () => {
    /** How a session hops rooms: the caller unsubscribes what comes back. */
    const rooms = new RoomSet('single');
    rooms.adopt(A);

    expect(rooms.adopt(B)).toEqual([A]);
    expect(rooms.all).toEqual([B]);
  });

  it('releases nothing when re-adopting the room it already holds', () => {
    /** A reconnect meets its own room. Releasing it would blank the session
     * between the unsubscribe and the re-claim. */
    const rooms = new RoomSet('single');
    rooms.adopt(A);

    expect(rooms.adopt(A)).toEqual([]);
    expect(rooms.all).toEqual([A]);
  });
});

describe('multi scope', () => {
  it('keeps the rooms it already holds', () => {
    /** The whole point of the scope: gaining a surface must not cost the
     * others. Under `single` this is where the Slack room would go quiet the
     * moment an email room arrived. */
    const rooms = new RoomSet('multi');
    rooms.adopt(A);

    expect(rooms.adopt(B)).toEqual([]);
    expect(rooms.all).toEqual([A, B]);
  });

  it('does not hold the same room twice', () => {
    const rooms = new RoomSet('multi');
    rooms.adopt(A);
    rooms.adopt(A);

    expect(rooms.all).toEqual([A]);
  });
});

describe('what goes on the reconnect URL', () => {
  it('declares every room, not the newest', () => {
    /**
     * Catch-up runs the moment the stream opens. A room left off has its
     * buffered events skipped as "not covered" *and* its cursor advanced past
     * them — the surface goes quiet with the socket up and the agent looking
     * healthy.
     */
    const rooms = new RoomSet('multi');
    rooms.adopt(A);
    rooms.adopt(B);
    rooms.adopt(C);

    expect(rooms.declare()).toBe([A, B, C].join(','));
  });

  it('is empty when no room is held, rather than a stray comma', () => {
    expect(new RoomSet('multi').declare()).toBe('');
  });

  it('keeps its order across adopt and release', () => {
    /** Stable, so a reconnect declares the same string twice and a log line
     * reads the same way. */
    const rooms = new RoomSet('multi');
    rooms.adopt(A);
    rooms.adopt(B);
    rooms.adopt(C);
    rooms.release(B);

    expect(rooms.declare()).toBe([A, C].join(','));
  });
});

describe('the room an operation falls back to', () => {
  it('is the one room, when there is one', () => {
    const rooms = new RoomSet('single');
    rooms.adopt(A);

    expect(rooms.only()).toBe(A);
  });

  it('is nothing when several are held, so the caller must say which', () => {
    /**
     * Picking one here would be the client guessing where a reply goes — the
     * same guess the server refuses, and the reason `room_id` was added to the
     * operations at all.
     */
    const rooms = new RoomSet('multi');
    rooms.adopt(A);
    rooms.adopt(B);

    expect(rooms.only()).toBeNull();
  });

  it('is nothing when no room is held', () => {
    expect(new RoomSet('multi').only()).toBeNull();
  });
});

describe('the server is the authority', () => {
  it('adopts the list it sends, dropping what it no longer covers', () => {
    /** A room claimed away by another session of this agent disappears here.
     * Keeping our own copy would re-declare it on every reconnect. */
    const rooms = new RoomSet('multi');
    rooms.adopt(A);
    rooms.adopt(B);

    rooms.accept([A]);

    expect(rooms.all).toEqual([A]);
    expect(rooms.declare()).toBe(A);
  });

  it('accepts an empty list rather than treating it as no news', () => {
    const rooms = new RoomSet('multi');
    rooms.adopt(A);

    rooms.accept([]);

    expect(rooms.all).toEqual([]);
  });
});

describe('release and clear', () => {
  it('reports whether the room was actually held', () => {
    const rooms = new RoomSet('multi');
    rooms.adopt(A);

    expect(rooms.release(A)).toBe(true);
    expect(rooms.release(A)).toBe(false);
  });

  it('hands back everything it was holding, so all of it can be unsubscribed', () => {
    const rooms = new RoomSet('multi');
    rooms.adopt(A);
    rooms.adopt(B);

    expect(rooms.clear()).toEqual([A, B]);
    expect(rooms.all).toEqual([]);
  });
});

describe('the set it hands out', () => {
  it('is a copy, so a caller cannot edit what the runtime is acting in', () => {
    const rooms = new RoomSet('multi');
    rooms.adopt(A);

    rooms.all.push(B);

    expect(rooms.all).toEqual([A]);
  });
});
