import { makeAutoObservable } from 'mobx';
import { bridgeCanEmbed } from '@shared/core/switch-rooms/room-embed';

/** The two things a room page can show. */
export type RoomTab = 'chat' | 'configuration';

/**
 * What a room shown inside another page opens on: its conversation when its
 * platform can be drawn inline, otherwise its settings, rather than a notice
 * that the conversation lives elsewhere.
 */
export function embeddedRoomTab(bridgeType: string | null): RoomTab {
  return bridgeCanEmbed(bridgeType) ? 'chat' : 'configuration';
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
