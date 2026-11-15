import { describe, expect, it, vi } from 'vitest';
import type { ChatSummary } from '@shared/core/chats/chats';
import { groupToOpenAsRoom } from './console-chat-redirect';

const chats = vi.hoisted(() => new Map<string, Partial<ChatSummary>>());
vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: {} }));
vi.mock('./stores/chats', () => ({ chatsStore: { chat: (roomId: string) => chats.get(roomId) } }));

const agent = { id: 'a1' } as ChatSummary['agents'][number];

describe('groupToOpenAsRoom', () => {
  it('follows the open chat into its room the moment it becomes a group', () => {
    chats.set('r1', { roomId: 'r1', channelType: 'direct', bridgeType: null, agents: [agent] });
    expect(groupToOpenAsRoom('r1')).toBeNull();
    // Someone added a person: the summary turns the chat into a group.
    chats.set('r1', {
      roomId: 'r1',
      channelType: 'channel_private',
      bridgeType: null,
      agents: [agent],
    });
    expect(groupToOpenAsRoom('r1')).toBe('r1');
  });

  it('leaves nothing to follow with no chat open or a bridged room', () => {
    expect(groupToOpenAsRoom(null)).toBeNull();
    chats.set('r2', {
      roomId: 'r2',
      channelType: 'channel_private',
      bridgeType: 'slack',
      agents: [agent],
    });
    expect(groupToOpenAsRoom('r2')).toBeNull();
  });
});
