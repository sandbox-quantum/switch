import type { ChatSummary } from '@switch-console/chat-ui/contracts/chats';
import type { TimelineApi } from '@switch-console/chat-ui/stores/chat-timeline-store';
import { ChatsStore, type ChatsEvents } from '@switch-console/chat-ui/stores/chats-store';
import { describe, expect, it } from 'vitest';
import { withConsoleGroupChats } from '@renderer/features/switch-servers/room-filters';

/** A group chat the person is in, as the feed summarises it. */
const group: ChatSummary = {
  roomId: 'g',
  name: 'g',
  channelType: 'channel_private',
  bridgeType: null,
  channelName: null,
  agents: [
    {
      id: 'a1',
      name: 'ada',
      displayName: null,
      iconUrl: null,
      provider: null,
      alias: null,
      ownerName: null,
      ownedByViewer: false,
    },
  ],
  canManage: true,
  ownsAgent: false,
  memberUserIds: [],
  memberCount: 0,
  unreadCount: 0,
  lastMessage: { seq: 1, sentAt: '2026-01-01T00:00:00Z', preview: 'hi', senderName: 'Ada' },
};

/** The chats store, connected and listing `group`, with a way to push summaries from the feed. */
async function viewer() {
  let onSummary: Parameters<ChatsEvents['onSummary']>[0] = () => {};
  const events: ChatsEvents = {
    onMessage: () => () => {},
    onSummary: (cb) => {
      onSummary = cb;
      return () => {};
    },
    onRemoved: () => () => {},
    onState: () => () => {},
    onReset: () => () => {},
  };
  const store = new ChatsStore(
    {
      connect: async () => ({ state: 'live', detail: null }),
      disconnect: async () => {},
      list: async () => [group],
      listArchived: async () => [],
      identity: async () => ({ userId: 'u', tenantId: 't' }),
      timeline: () => ({}) as TimelineApi,
      archive: async () => {},
      unarchive: async () => {},
      delete: async () => {},
      markRead: async () => {},
      removeMember: async () => {},
      roomsChanged: async () => {},
    },
    events
  );
  await store.connect('s1');
  return { store, group, push: (chat: ChatSummary) => onSummary({ serverId: 's1', chat }) };
}

describe('a chat the person is invited to', () => {
  it('appears among the sidebar rooms when its summary arrives on the feed', async () => {
    const { store, push, group } = await viewer();
    const invited = {
      ...group,
      roomId: 'invited',
      name: 'Test room - X/M/L',
      memberUserIds: ['owner', 'u'],
      memberCount: 2,
    };
    expect(withConsoleGroupChats([], store.chats.values()).map((room) => room.id)).toEqual(['g']);

    push(invited);

    const rooms = withConsoleGroupChats([], store.chats.values());
    expect(rooms.map((room) => room.id).sort()).toEqual(['g', 'invited']);
    expect(rooms.find((room) => room.id === 'invited')).toMatchObject({
      name: 'Test room - X/M/L',
      viewerIsMember: true,
      isConsoleChat: true,
    });
  });

  it('is not added a second time when the room list already has it', async () => {
    const { store } = await viewer();
    const listed = withConsoleGroupChats([], store.chats.values());
    expect(withConsoleGroupChats(listed, store.chats.values())).toHaveLength(1);
  });
});
