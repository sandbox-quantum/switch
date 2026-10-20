import { describe, expect, it } from 'vitest';
import {
  agentConversations,
  byLatestDirectChat,
} from '@renderer/features/chats/agent-conversations';
import type { ChatSummary } from '@shared/core/chats/chats';
import type { RemoteAgentRoom } from '@shared/core/switch-servers/switch-servers';

const agent = (id: string, name: string, displayName: string | null = null) => ({
  id,
  name,
  displayName,
  iconUrl: null,
  provider: null,
});

const summary = (overrides: Partial<ChatSummary>): ChatSummary => ({
  roomId: 'r',
  name: 'Chat with helper',
  channelType: 'direct',
  bridgeType: null,
  channelName: null,
  agents: [],
  canManage: false,
  ownsAgent: false,
  lastMessage: null,
  ...overrides,
});

describe('agentConversations', () => {
  const room = (roomId: string, roomName: string, archived = false): RemoteAgentRoom => ({
    roomId,
    roomName,
    archived,
    status: 'live',
    roomRole: null,
  });

  it('puts unbridged direct chats under Direct chats and every other room under Rooms', () => {
    const direct = summary({ roomId: 'dm', agents: [agent('a', 'alpha')] });
    const slackDm = summary({ roomId: 'slack-dm', bridgeType: 'slack' });
    const channel = summary({ roomId: 'team', channelType: 'channel_private' });
    const split = agentConversations(
      [direct, slackDm, channel],
      [room('team', 'team'), room('dm', 'dm'), room('slack-dm', 'Dana'), room('old', 'old', true)],
      new Set()
    );
    expect(split.direct.map((chat) => chat.roomId)).toEqual(['dm']);
    expect(split.rooms.map((each) => each.roomId)).toEqual(['slack-dm', 'team']);
  });

  it('puts a direct room with two agents under Rooms', () => {
    const shared = summary({ roomId: 'pair', agents: [agent('a', 'alpha'), agent('b', 'beta')] });
    const split = agentConversations([shared], [], new Set());
    expect(split.direct).toEqual([]);
    expect(split.rooms).toEqual([{ roomId: 'pair', roomName: 'Chat with helper' }]);
  });

  it('puts a chat with several agents under Rooms when its membership does not list it', () => {
    const group = summary({
      roomId: 'group',
      name: 'Try me',
      channelType: 'channel_private',
      agents: [agent('a', 'alpha'), agent('b', 'beta')],
    });
    const split = agentConversations([group], [room('team', 'team')], new Set());
    expect(split.direct).toEqual([]);
    expect(split.rooms).toEqual([
      { roomId: 'team', roomName: 'team', archived: false, status: 'live', roomRole: null },
      { roomId: 'group', roomName: 'Try me' },
    ]);
  });

  it('excludes stale membership entries for removed rooms', () => {
    const split = agentConversations(
      [],
      [room('removed', 'Removed Room'), room('live', 'Live Room')],
      new Set(['removed'])
    );
    expect(split.rooms.map((each) => each.roomId)).toEqual(['live']);
  });
});

describe('byLatestDirectChat', () => {
  const agents = ['alpha', 'beta', 'gamma', 'delta'].map((agentId) => ({ agentId }));
  const chat = (roomId: string, agentId: string, sentAt: string | null) =>
    summary({
      roomId,
      agents: [agent(agentId, agentId)],
      lastMessage: sentAt ? { seq: 1, sentAt, preview: '', senderName: 'x' } : null,
    });
  const ids = (list: { agentId: string }[]) => list.map((each) => each.agentId);

  it('puts the newest chat first and agents with no chat after, in their order', () => {
    const chats = [
      chat('g1', 'gamma', '2026-01-01T00:00:00Z'),
      chat('g2', 'gamma', '2026-01-03T00:00:00Z'),
      chat('d1', 'delta', '2026-01-02T00:00:00Z'),
      chat('b1', 'beta', null),
    ];
    expect(ids(byLatestDirectChat(agents, chats))).toEqual(['gamma', 'delta', 'alpha', 'beta']);
  });

  it('ignores chats that are not 1-1 Console chats', () => {
    const pair = summary({
      roomId: 'pair',
      agents: [agent('delta', 'delta'), agent('beta', 'beta')],
      lastMessage: { seq: 1, sentAt: '2026-01-05T00:00:00Z', preview: '', senderName: 'x' },
    });
    const slack = { ...chat('s', 'gamma', '2026-01-05T00:00:00Z'), bridgeType: 'slack' };
    expect(ids(byLatestDirectChat(agents, [pair, slack]))).toEqual(ids(agents));
  });

  it('keeps the given order on a tie', () => {
    const at = '2026-01-01T00:00:00Z';
    const chats = [chat('d', 'delta', at), chat('b', 'beta', at)];
    expect(ids(byLatestDirectChat(agents, chats))).toEqual(['beta', 'delta', 'alpha', 'gamma']);
  });

  it('leaves the order unchanged with no chats', () => {
    expect(ids(byLatestDirectChat(agents, null))).toEqual(ids(agents));
  });
});
