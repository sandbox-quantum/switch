import { describe, expect, it } from 'vitest';
import { chatRemovalNavigation } from '@renderer/features/chats/chat-removal';

const stay = { leaveChatView: false, clearAgentChat: false };

describe('chatRemovalNavigation', () => {
  it('leaves the chat view only when it shows the removed chat', () => {
    expect(chatRemovalNavigation('!a', { currentViewId: 'chat', chatRoomId: '!a' })).toEqual({
      leaveChatView: true,
      clearAgentChat: false,
    });
    expect(chatRemovalNavigation('!b', { currentViewId: 'chat', chatRoomId: '!a' })).toEqual(stay);
  });

  it('leaves the room view only when it shows the removed chat', () => {
    expect(chatRemovalNavigation('!a', { currentViewId: 'room', roomRoomId: '!a' })).toEqual({
      leaveChatView: true,
      clearAgentChat: false,
    });
    expect(chatRemovalNavigation('!b', { currentViewId: 'room', roomRoomId: '!a' })).toEqual(stay);
  });

  it('drops the agent page chat only when it is the removed one', () => {
    expect(
      chatRemovalNavigation('!a', { currentViewId: 'managedAgent', agentRoomId: '!a' })
    ).toEqual({ leaveChatView: false, clearAgentChat: true });
    expect(
      chatRemovalNavigation('!b', { currentViewId: 'managedAgent', agentRoomId: '!a' })
    ).toEqual(stay);
  });

  it('stays put on an agent page showing its newest chat by default', () => {
    expect(chatRemovalNavigation('!b', { currentViewId: 'managedAgent' })).toEqual(stay);
  });

  it('does not navigate from a chat view left in the background', () => {
    expect(chatRemovalNavigation('!a', { currentViewId: 'home', chatRoomId: '!a' })).toEqual(stay);
  });
});
