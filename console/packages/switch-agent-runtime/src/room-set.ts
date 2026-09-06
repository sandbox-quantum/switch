/**
 * The rooms one runtime process is acting in.
 *
 * `bin.ts` held this as a single `string | null`, which was right while a
 * session was one room. An agent reachable on several surfaces at once is the
 * same session with the same context window and more than one room, so the
 * variable has to become a set — and every place that read it has to say what
 * it means now.
 *
 * Extracted rather than left inline because `bin.ts` reads its config at module
 * scope and exits from it, so it cannot be imported and nothing in it can be
 * unit tested. The rules here are small and each of them has a failure that is
 * silent, which is a bad combination to leave untested.
 */

export type RoomScope = 'single' | 'multi';

export class RoomSet {
  private readonly scope: RoomScope;
  /** Insertion-ordered, so the declared list is stable across reconnects and a
   * log line reads the same way twice. */
  private rooms: string[] = [];

  constructor(scope: RoomScope) {
    this.scope = scope;
  }

  get all(): string[] {
    return [...this.rooms];
  }

  get size(): number {
    return this.rooms.length;
  }

  has(roomId: string): boolean {
    return this.rooms.includes(roomId);
  }

  /**
   * Take on a room, and say which rooms that costs.
   *
   * Under `single` a new room replaces the old one, which is how a session hops
   * rooms — the caller releases what comes back. Under `multi` it costs
   * nothing: an agent gaining a surface must not lose the others, which is the
   * whole point of the scope.
   *
   * Re-adopting a room already held releases nothing, so a reconnect meeting
   * its own room does not blank it.
   */
  adopt(roomId: string): string[] {
    if (this.has(roomId)) return [];
    if (this.scope === 'single') {
      const released = this.rooms;
      this.rooms = [roomId];
      return released;
    }
    this.rooms = [...this.rooms, roomId];
    return [];
  }

  /** Give up one room. Returns whether it was held. */
  release(roomId: string): boolean {
    const before = this.rooms.length;
    this.rooms = this.rooms.filter((room) => room !== roomId);
    return this.rooms.length !== before;
  }

  clear(): string[] {
    const released = this.rooms;
    this.rooms = [];
    return released;
  }

  /**
   * Adopt the server's list wholesale; it is the authority on what we cover.
   *
   * Arrives on `connection_state` and again on `subscription_changed`. A room
   * claimed away by another session of this agent disappears here, and keeping
   * our own copy would mean re-declaring it on every reconnect.
   */
  accept(rooms: string[]): void {
    this.rooms = [...rooms];
  }

  /**
   * What to put on the reconnect URL.
   *
   * **Every** room, not the most recent one. Catch-up runs the moment the
   * stream opens, so a room left off is a room whose buffered events are
   * skipped as "not covered" *and* whose cursor is advanced past them — the
   * surface goes quiet with the socket up and the agent looking healthy.
   */
  declare(): string {
    return this.rooms.join(',');
  }

  /**
   * The room an operation acts on when the caller named none.
   *
   * Null when there is no room, and null when there are several — the caller
   * must say which, and the operation's own error says so. Picking one here
   * would be the client guessing where a reply goes.
   */
  only(): string | null {
    return this.rooms.length === 1 ? this.rooms[0] : null;
  }
}
