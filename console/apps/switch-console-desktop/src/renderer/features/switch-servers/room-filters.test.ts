import type { ChatSummary } from '@switch-console/chat-ui/contracts/chats';
import { describe, expect, it } from 'vitest';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';
import {
  consoleChatNotice,
  isConsoleDirectChat,
  isHiddenDirectChat,
  isMarkedConsoleDirectChat,
  isConsoleDirectChatSummary,
  isConsoleGroupChatSummary,
  withConsoleGroupChats,
} from './room-filters';

const agent = {
  id: 'a',
  name: 'a',
  displayName: null,
  iconUrl: null,
  provider: null,
  alias: null,
  ownerName: null,
  ownedByViewer: false,
};

describe('isConsoleDirectChat', () => {
  it('returns true for a direct unbridged room with one agent', () => {
    expect(isConsoleDirectChat({ channelType: 'direct', bridgeType: null, agentCount: 1 })).toBe(
      true
    );
  });

  it('returns false for a direct unbridged room with no agent or several', () => {
    expect(isConsoleDirectChat({ channelType: 'direct', bridgeType: null, agentCount: 0 })).toBe(
      false
    );
    expect(isConsoleDirectChat({ channelType: 'direct', bridgeType: null, agentCount: 2 })).toBe(
      false
    );
  });

  it('returns false for direct bridged rooms', () => {
    expect(isConsoleDirectChat({ channelType: 'direct', bridgeType: 'slack', agentCount: 1 })).toBe(
      false
    );
  });

  it('returns false for non-direct rooms', () => {
    for (const channelType of ['channel_public', 'channel_private', 'group', 'lobby', null])
      expect(isConsoleDirectChat({ channelType, bridgeType: null, agentCount: 1 })).toBe(false);
  });
});

describe('isConsoleDirectChatSummary', () => {
  it('counts the agents of a chat summary', () => {
    expect(
      isConsoleDirectChatSummary({ channelType: 'direct', bridgeType: null, agents: [agent] })
    ).toBe(true);
    expect(
      isConsoleDirectChatSummary({
        channelType: 'direct',
        bridgeType: null,
        agents: [agent, { ...agent, id: 'b' }],
      })
    ).toBe(false);
  });
});

const chat = (roomId: string, extra: Partial<ChatSummary> = {}): ChatSummary => ({
  roomId,
  name: roomId,
  channelType: 'channel_private',
  bridgeType: null,
  channelName: null,
  agents: [agent],
  canManage: false,
  ownsAgent: false,
  memberUserIds: [],
  memberCount: 0,
  unreadCount: 0,
  lastMessage: null,
  ...extra,
});

describe('isConsoleGroupChatSummary', () => {
  it('is an unbridged chat that is not 1-1, people-only included', () => {
    expect(isConsoleGroupChatSummary(chat('g'))).toBe(true);
    expect(isConsoleGroupChatSummary(chat('g', { agents: [] }))).toBe(true);
    expect(isConsoleGroupChatSummary(chat('d', { channelType: 'direct' }))).toBe(false);
  });

  it('leaves bridged rooms to their messaging app', () => {
    for (const bridgeType of ['slack', 'mattermost'])
      expect(isConsoleGroupChatSummary(chat('b', { bridgeType }))).toBe(false);
  });
});

describe('withConsoleGroupChats', () => {
  const room = (id: string): RemoteRoomSummary => ({
    id,
    name: id,
    description: '',
    channelType: 'channel_private',
    agentCount: 1,
    bridgeDisplayName: null,
    bridgeType: null,
    externalChannelUrl: null,
    ownerId: 'u',
    viewerIsMember: false,
    viewerIsRoomAdmin: false,
    isConsoleChat: false,
    archived: false,
    createdAt: '',
  });

  it('adds the group chats not already listed, sorted by name', () => {
    const listed = withConsoleGroupChats(
      [room('b'), room('d')],
      [
        chat('a'),
        chat('b'),
        chat('c', { channelType: 'direct' }),
        chat('e', { bridgeType: 'slack' }),
      ]
    );
    expect(listed.map((each) => each.id)).toEqual(['a', 'b', 'd']);
    expect(listed[1].ownerId).toBe('u');
  });
});

describe('isHiddenDirectChat', () => {
  const marked = { channelType: 'direct', bridgeType: null, isConsoleChat: true };

  it('leaves out a direct chat the server marks, whatever its agents and the flag', () => {
    for (const agentCount of [0, 1, 2])
      for (const agentChatsOn of [true, false])
        expect(isHiddenDirectChat({ ...marked, agentCount }, agentChatsOn)).toBe(true);
  });

  it('reads an unmarked room by shape, only with agent_chats on', () => {
    const unmarked = { ...marked, isConsoleChat: false, agentCount: 1 };
    expect(isHiddenDirectChat(unmarked, true)).toBe(true);
    expect(isHiddenDirectChat(unmarked, false)).toBe(false);
  });

  it('keeps a Console chat that became a group, and a bridged direct chat', () => {
    expect(
      isHiddenDirectChat({ ...marked, channelType: 'channel_private', agentCount: 1 }, true)
    ).toBe(false);
    expect(isHiddenDirectChat({ ...marked, bridgeType: 'slack', agentCount: 1 }, true)).toBe(false);
  });
});

describe('isMarkedConsoleDirectChat', () => {
  it('needs the server mark, a direct channel and no messaging app', () => {
    expect(
      isMarkedConsoleDirectChat({ channelType: 'direct', bridgeType: null, isConsoleChat: true })
    ).toBe(true);
    expect(
      isMarkedConsoleDirectChat({ channelType: 'direct', bridgeType: null, isConsoleChat: false })
    ).toBe(false);
    expect(
      isMarkedConsoleDirectChat({ channelType: 'direct', bridgeType: 'slack', isConsoleChat: true })
    ).toBe(false);
  });
});

describe('consoleChatNotice', () => {
  it('says a direct chat is one, not an agent-only room', () => {
    const notice = consoleChatNotice({
      channelType: 'direct',
      bridgeType: null,
      isConsoleChat: true,
    });
    expect(notice?.title).toBe('This is a direct chat with an agent');
    expect(JSON.stringify(notice)).not.toMatch(/agent-only/);
  });

  it('says a group chat is one', () => {
    expect(
      consoleChatNotice({ channelType: 'channel_private', bridgeType: null, isConsoleChat: true })
        ?.title
    ).toBe('This is a group chat in Switch Console');
  });

  it('is null for a room that is not an unbridged Console chat', () => {
    expect(
      consoleChatNotice({ channelType: 'channel_private', bridgeType: null, isConsoleChat: false })
    ).toBeNull();
    expect(
      consoleChatNotice({ channelType: 'direct', bridgeType: 'slack', isConsoleChat: true })
    ).toBeNull();
  });
});
