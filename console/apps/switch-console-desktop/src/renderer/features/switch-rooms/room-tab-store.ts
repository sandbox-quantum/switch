import { makeAutoObservable } from 'mobx';

/** The two things a room page can show. */
export type RoomTab = 'chat' | 'configuration';

/**
 * Which tab the open room is showing.
 *
 * Held outside the room view because the conversation is drawn by
 * `RoomEmbedLayer`, which lives above the view switch and has to know when to
 * get out of the way. One selection rather than one per room: the conversation
 * is what a room is for, so opening a different room starts on it again — which
 * is why the tab is remembered against the room id and forgotten the moment the
 * id changes.
 */
export class RoomTabStore {
  private roomId: string | null = null;
  private tab: RoomTab = 'chat';

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  tabFor(roomId: string): RoomTab {
    return this.roomId === roomId ? this.tab : 'chat';
  }

  setTab(roomId: string, tab: RoomTab): void {
    this.roomId = roomId;
    this.tab = tab;
  }
}

export const roomTabStore = new RoomTabStore();
