import { describe, expect, it } from 'vitest';
import { RoomTabStore } from './room-tab-store';

describe('the room tab', () => {
  it('shows what the page opens on until a tab is picked, and the pick for that room only', () => {
    const store = new RoomTabStore();
    expect(store.tabFor('room-a', 'configuration')).toBe('configuration');

    store.setTab('room-a', 'chat');
    expect(store.tabFor('room-a', 'configuration')).toBe('chat');
    expect(store.tabFor('room-b', 'configuration')).toBe('configuration');
  });
});
