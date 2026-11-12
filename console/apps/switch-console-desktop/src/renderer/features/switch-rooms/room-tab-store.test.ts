import { describe, expect, it } from 'vitest';
import { embeddedRoomTab, RoomTabStore } from './room-tab-store';

describe('the room tab', () => {
  it('opens a room shown inside a page on its conversation whenever it has one', () => {
    expect(embeddedRoomTab('mattermost', false)).toBe('chat');
    expect(embeddedRoomTab('slack', false)).toBe('chat');
    expect(embeddedRoomTab(null, true)).toBe('chat');
    expect(embeddedRoomTab(null, false)).toBe('configuration');
  });

  it('shows what the page opens on until a tab is picked, and the pick for that room only', () => {
    const store = new RoomTabStore();
    expect(store.tabFor('room-a', 'configuration')).toBe('configuration');

    store.setTab('room-a', 'chat');
    expect(store.tabFor('room-a', 'configuration')).toBe('chat');
    expect(store.tabFor('room-b', 'configuration')).toBe('configuration');
  });
});
