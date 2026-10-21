/**
 * Which of an agent's rooms share its session, as Switch has them.
 *
 * An agent with a shared session (`switch_core.shared_session` on the server)
 * has a home room, where the session is placed, and shared rooms whose
 * messages that session answers instead of a session of their own. The watcher
 * reads this when a message reaches a room no session attends, and again when
 * one reaches a room a share covers, so a room switched to isolated, or a home
 * that moved, is followed within `ttlMs`.
 */
export type SharingView = {
  /** The room the shared session is based in; null when the agent has none. */
  home: string | null;
  /** The rooms sharing it, home included. */
  shared: ReadonlySet<string>;
};

export const NO_SHARING: SharingView = { home: null, shared: new Set() };

export class SharedRooms {
  private cached: { view: SharingView; at: number } | null = null;
  private reading: Promise<SharingView> | null = null;

  constructor(
    private readonly read: () => Promise<SharingView>,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * The home room a message in `roomId` belongs to, when `roomId` shares the
   * agent's session; null for the home room itself and for an isolated room.
   */
  async homeFor(roomId: string): Promise<string | null> {
    const view = await this.view();
    if (!view.home || roomId === view.home || !view.shared.has(roomId)) return null;
    return view.home;
  }

  /** Forget what was read, so the next question reads again. */
  invalidate(): void {
    this.cached = null;
  }

  private async view(): Promise<SharingView> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.view;
    this.reading ??= this.read()
      .then((view) => {
        this.cached = { view, at: this.now() };
        return view;
      })
      .catch((error: unknown) => {
        // Routing goes on with what was last known rather than starting
        // sessions a shared room does not want, or stalling every message.
        console.warn(
          `Could not read which rooms share this agent's session: ${error instanceof Error ? error.message : String(error)}. Using what was last read.`
        );
        return this.cached?.view ?? NO_SHARING;
      })
      .finally(() => {
        this.reading = null;
      });
    return this.reading;
  }
}

/**
 * The view out of `get_agent_detail`'s answer: its `home_room_id`, and each
 * of its `rooms` whose `shared_session` is set. A server from before shared
 * sessions says neither, which reads as none.
 */
export function sharingFromDetail(detail: unknown): SharingView {
  if (typeof detail !== 'object' || detail === null) return NO_SHARING;
  const { home_room_id: home, rooms } = detail as { home_room_id?: unknown; rooms?: unknown };
  if (typeof home !== 'string' || !home) return NO_SHARING;
  const shared = new Set<string>([home]);
  if (Array.isArray(rooms))
    for (const room of rooms) {
      const { room_id: id, shared_session: mark } = (room ?? {}) as Record<string, unknown>;
      if (typeof id === 'string' && (mark === 'home' || mark === 'shared')) shared.add(id);
    }
  return { home, shared };
}
