import type { UserChangesEvent } from '@shared/events/userChangesEvents';

/**
 * How often the sidebar reads its whole room state again while a workspace's
 * server does not push room changes (an older server, or its change socket is
 * between connections). The polling every Console did before the pushes.
 */
export const POLLED_RECONCILE_MS = 20_000;
/**
 * How often it reads everything again while every workspace on screen pushes
 * them. A notice can be lost without the socket closing (the pod that made the
 * change died before it published it, or an older pod made it during a rolling
 * deploy), so this bounds how long the sidebar can stay stale. The same bound
 * as the managed agents list's (`use-managed-agents.ts`).
 */
export const PUSHED_RECONCILE_MS = 5 * 60_000;
/**
 * The least time between two whole reads on window focus. Focus comes in bursts
 * (switching between windows and apps), and while the servers push, a read on
 * focus is only a catch-up after a sleep the socket has not noticed yet.
 */
export const POLLED_FOCUS_GAP_MS = 5_000;
export const PUSHED_FOCUS_GAP_MS = 60_000;
/**
 * How long room notices are gathered before they are read, so a burst (a
 * template creating rooms, a bridge adding a channel's members) is one read of
 * the rooms it names rather than one per notice. The server already gathers a
 * room's changes for a second before it sends them (`room_changes.py`).
 */
export const ROOM_NOTICE_BATCH_MS = 250;

/** The servers' kind for a room the signed-in user takes part in (`user_changes.py`). */
const ROOM = 'room';

type Scope = { workspaceId: string; serverId: string };

type Timer = ReturnType<typeof setTimeout>;

export type SidebarRoomPushesDeps = {
  /** Read the sidebar's whole room state again, in every workspace on screen. */
  refreshAll: () => Promise<void>;
  /** Read some rooms of one workspace again, and its agents' membership. */
  refreshRooms: (workspaceId: string, roomIds: string[]) => Promise<void>;
  /** Keep a workspace's change socket open while the sidebar shows it. */
  watch: (serverId: string, workspaceId: string) => Promise<unknown>;
  unwatch: (serverId: string, workspaceId: string) => Promise<unknown>;
  /** What the socket pushes now, or null while it does not. */
  liveKinds: (serverId: string, workspaceId: string) => Promise<string[] | null>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => Timer;
  clearTimer: (timer: Timer) => void;
};

/**
 * Keeps the sidebar's rooms current from the servers' change sockets
 * (`/gateway/changes/ws`, kind `room`), instead of reading every room and every
 * agent's membership every 20 seconds.
 *
 * A notice names the rooms that changed, so only those are read again
 * (`SwitchRoomsStore.refreshRooms`). A notice without a room, or a socket that
 * (re)opens and so may have missed some, reads everything. While every
 * workspace on screen pushes, the timer reads everything only every few minutes,
 * and focus at most once a minute; a workspace that does not keeps the polling
 * it had.
 */
export class SidebarRoomPushes {
  /** The workspaces followed, with the server each is on. */
  private readonly followed = new Map<string, string>();
  /** Followed workspaces whose server pushes room changes right now. */
  private readonly pushing = new Set<string>();
  /** Rooms named by notices not read yet, by workspace; null for every room. */
  private readonly pending = new Map<string, Set<string> | null>();
  private batch: Timer | null = null;
  /** When the last whole read started, on `now`'s clock. */
  private lastWholeRead: number | null = null;

  constructor(private readonly deps: SidebarRoomPushesDeps) {}

  /** Follow these workspaces' change sockets, and stop following the rest. */
  follow(scopes: Scope[]): void {
    const wanted = new Map(scopes.map((scope) => [scope.workspaceId, scope.serverId]));
    for (const [workspaceId, serverId] of [...this.followed]) {
      if (wanted.get(workspaceId) === serverId) continue;
      this.followed.delete(workspaceId);
      this.pushing.delete(workspaceId);
      this.pending.delete(workspaceId);
      void this.deps.unwatch(serverId, workspaceId);
    }
    for (const [workspaceId, serverId] of wanted) {
      if (this.followed.has(workspaceId)) continue;
      this.followed.set(workspaceId, serverId);
      void this.deps
        .watch(serverId, workspaceId)
        .then(() => this.deps.liveKinds(serverId, workspaceId))
        .then((kinds) => {
          // A `live` or `down` notice that came meanwhile is newer than this.
          if (this.followed.get(workspaceId) !== serverId) return;
          if (kinds?.includes(ROOM)) this.pushing.add(workspaceId);
        })
        .catch(() => {
          // Not pushing as far as anyone knows: the timer keeps polling.
        });
    }
  }

  /** Stop following every workspace. */
  stop(): void {
    this.follow([]);
    if (this.batch !== null) this.deps.clearTimer(this.batch);
    this.batch = null;
  }

  /** A notice from a change socket. */
  onEvent(event: UserChangesEvent): void {
    const workspaceId = event.workspaceId;
    if (workspaceId === null || this.followed.get(workspaceId) !== event.serverId) return;
    if (event.type === 'down') {
      this.pushing.delete(workspaceId);
      return;
    }
    if (event.type === 'live') {
      if (event.kinds.includes(ROOM)) this.pushing.add(workspaceId);
      else this.pushing.delete(workspaceId);
      // Whatever changed while the socket was closed was never told.
      this.queue(workspaceId, null);
      return;
    }
    for (const change of event.changes) {
      if (change.kind === ROOM) this.queue(workspaceId, change.id);
    }
  }

  /** Whether the timer's tick should read everything again. */
  reconcileDue(): boolean {
    return this.wholeReadOlderThan(this.allPushing() ? PUSHED_RECONCILE_MS : 0);
  }

  /** Whether a window focus should read everything again. */
  focusDue(): boolean {
    return this.wholeReadOlderThan(this.allPushing() ? PUSHED_FOCUS_GAP_MS : POLLED_FOCUS_GAP_MS);
  }

  /** Read everything again now, and count it as the last whole read. */
  async readWhole(): Promise<void> {
    this.lastWholeRead = this.deps.now();
    await this.deps.refreshAll();
  }

  /** Every workspace followed pushes room changes; false while none is followed. */
  allPushing(): boolean {
    return this.followed.size > 0 && [...this.followed.keys()].every((id) => this.pushing.has(id));
  }

  private wholeReadOlderThan(ms: number): boolean {
    return this.lastWholeRead === null || this.deps.now() - this.lastWholeRead >= ms;
  }

  private queue(workspaceId: string, roomId: string | null): void {
    const rooms = this.pending.get(workspaceId);
    if (roomId === null || rooms === null) this.pending.set(workspaceId, null);
    else if (rooms) rooms.add(roomId);
    else this.pending.set(workspaceId, new Set([roomId]));
    if (this.batch === null) {
      this.batch = this.deps.setTimer(() => {
        this.batch = null;
        void this.flush();
      }, ROOM_NOTICE_BATCH_MS);
    }
  }

  private async flush(): Promise<void> {
    const pending = [...this.pending];
    this.pending.clear();
    if (pending.some(([, rooms]) => rooms === null)) {
      await this.readWhole();
      return;
    }
    await Promise.all(
      pending.map(([workspaceId, rooms]) => this.deps.refreshRooms(workspaceId, [...rooms!]))
    );
  }
}
