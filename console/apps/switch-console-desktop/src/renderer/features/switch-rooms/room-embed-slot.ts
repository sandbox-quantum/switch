import { makeAutoObservable, observable } from 'mobx';
import type { RoomTab } from './room-tab-store';

/**
 * A box where a room's conversation is drawn: on a page other than the room
 * view, or the part of the room view beside its side panel. `fallback` is the
 * tab the box's page opens on until one is picked; without it, the box opens on
 * the conversation only when its platform can be drawn inline.
 */
export type RoomEmbedSlot = { roomId: string; element: HTMLElement; fallback?: RoomTab };

/**
 * Where `RoomEmbedLayer` draws a room when a page shows one inside itself, as
 * an agent's page does beside its own column. The layer cannot be rendered
 * there — moving a `<webview>` reloads it — so the page marks out a box and the
 * layer is laid over it. A box left behind by a page that has since gone is
 * never taken: only the element that claimed the slot can release it.
 */
export class RoomEmbedSlotStore {
  slot: RoomEmbedSlot | null = null;

  constructor() {
    makeAutoObservable(this, { slot: observable.ref }, { autoBind: true });
  }

  claim(slot: RoomEmbedSlot): void {
    this.slot = slot;
  }

  release(element: HTMLElement): void {
    if (this.slot?.element === element) this.slot = null;
  }
}

export const roomEmbedSlotStore = new RoomEmbedSlotStore();
