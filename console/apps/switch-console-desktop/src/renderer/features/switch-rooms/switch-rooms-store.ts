import { makeAutoObservable, runInAction } from 'mobx';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { events, rpc } from '@renderer/lib/ipc';
import { sessionRoomChangedChannel } from '@shared/core/switch-rooms/switchRoomEvents';

/**
 * Renderer-side view of which Switch room each live session is connected to.
 * Seeded from the `switchRooms` RPC controller and kept current via the
 * `sessionRoomChangedChannel` event. Connections are runtime-only — a session
 * disappears here when it switches rooms or its session exits.
 */
export class SwitchRoomsStore {
  /** sessionId → connected room id. */
  private roomBySession = new Map<string, string>();
  private loaded = false;
  /** Why the initial connection seed failed, when it did. Non-null means the
   * session→room mapping is incomplete and must not be read as authoritative. */
  seedError: string | null = null;

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });

    events.on(sessionRoomChangedChannel, ({ sessionId, roomId }) => {
      runInAction(() => {
        if (roomId) this.roomBySession.set(sessionId, roomId);
        else this.roomBySession.delete(sessionId);
      });
    });
  }

  /**
   * Load the current connection set once (idempotent).
   *
   * A failure re-arms the load rather than leaving the flag set: the seed is
   * what every "which room is this session in" answer starts from, so wedging
   * it would report every session as connected to nothing, indefinitely and
   * without a word.
   */
  ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    void rpc.switchRooms
      .getConnections()
      .then((connections) => {
        runInAction(() => {
          this.seedError = null;
          for (const { sessionId, roomId } of connections) {
            this.roomBySession.set(sessionId, roomId);
          }
        });
      })
      .catch((cause: unknown) => {
        runInAction(() => {
          this.loaded = false;
          this.seedError = failureText(
            cause,
            'Could not read which Switch rooms these sessions are connected to.'
          );
        });
      });
  }

  /** The room a session is currently connected to, or null. */
  roomForSession(sessionId: string): string | null {
    return this.roomBySession.get(sessionId) ?? null;
  }
}

export const switchRoomsStore = new SwitchRoomsStore();
