import { makeAutoObservable } from 'mobx';

/** The things a room page can show beside its participants. */
export type RoomTab = 'chat' | 'resources' | 'configuration';

/**
 * What a room shown inside another page opens on: its conversation whenever it
 * has one — a group chat here, or a channel on a messaging app, drawn inline or
 * offered as a way out to that app — and its settings only when it has none.
 */
export function embeddedRoomTab(bridgeType: string | null, consoleChat: boolean): RoomTab {
  return bridgeType !== null || consoleChat ? 'chat' : 'configuration';
}

/**
 * Which tab the open room is showing, once one has been picked; until then
 * the page asks for what it opens on (`fallback`).
 *
 * Held outside the room view because the conversation is drawn by
 * `RoomEmbedLayer`, which lives above the view switch and has to know when to
 * get out of the way. One selection rather than one per room: opening a
 * different room starts again on what its page opens on — which is why the tab
 * is remembered against the room id and forgotten the moment the id changes.
 */
export class RoomTabStore {
  private roomId: string | null = null;
  private tab: RoomTab = 'chat';

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  tabFor(roomId: string, fallback: RoomTab): RoomTab {
    return this.roomId === roomId ? this.tab : fallback;
  }

  setTab(roomId: string, tab: RoomTab): void {
    this.roomId = roomId;
    this.tab = tab;
  }
}

export const roomTabStore = new RoomTabStore();
