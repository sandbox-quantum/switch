import { describe, expect, it } from 'vitest';
import type { ChatSummary } from '@shared/core/chats/chats';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';
import {
  hidesConsoleDirectChats,
  isConsoleDirectChat,
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
      ],
      false
    );
    expect(listed.map((each) => each.id)).toEqual(['a', 'b', 'd']);
    expect(listed[1].ownerId).toBe('u');
  });

  it('adds a readable 1-1 chat the room list lacks when 1-1 chats are listed', () => {
    const direct = chat('d', { channelType: 'direct' });
    expect(withConsoleGroupChats([], [direct], true).map((each) => each.id)).toEqual(['d']);
    expect(withConsoleGroupChats([], [direct], false)).toEqual([]);
  });
});

describe('hidesConsoleDirectChats', () => {
  it('hides 1-1 chats only where agent management lists them on the agent page', () => {
    expect(hidesConsoleDirectChats({ agent_chats: true, agent_management: true })).toBe(true);
    expect(hidesConsoleDirectChats({ agent_chats: true, agent_management: false })).toBe(false);
    expect(hidesConsoleDirectChats({ agent_chats: false, agent_management: true })).toBe(false);
  });
});
