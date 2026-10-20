import { describe, expect, it } from 'vitest';
import { RoomEmbedSlotStore } from './room-embed-slot';

const box = () => ({}) as HTMLElement;

describe('the room embed slot', () => {
  it('holds the box a page claimed, and lets it go when that page releases it', () => {
    const store = new RoomEmbedSlotStore();
    const element = box();
    store.claim({ roomId: 'room-a', element });
    expect(store.slot?.roomId).toBe('room-a');
    expect(store.slot?.element).toBe(element);

    store.release(element);
    expect(store.slot).toBeNull();
  });

  it('keeps a newer claim when an older box is released after it', () => {
    const store = new RoomEmbedSlotStore();
    const older = box();
    const newer = box();
    store.claim({ roomId: 'room-a', element: older });
    store.claim({ roomId: 'room-b', element: newer });

    store.release(older);
    expect(store.slot?.roomId).toBe('room-b');
    expect(store.slot?.element).toBe(newer);
  });
});
