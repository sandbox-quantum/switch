import { describe, it, expect, vi } from 'vitest';
import { chatActions, confirmLeaveChat, type ChatRemovalContext } from './chat-actions';
import type { ChatSummary } from '../contracts/chats';
import { stubChatHost } from '../testing';

describe('chat-actions', () => {
  const serverId = 'test-server';
  const mockChat: ChatSummary = {
    roomId: 'test-room',
    name: 'Test Chat',
    channelType: 'direct',
    bridgeType: null,
    channelName: null,
    agents: [],
    canManage: true,
    ownsAgent: false,
    memberUserIds: [],
    memberCount: 0,
    unreadCount: 0,
    lastMessage: null,
  };

  const mockContext: ChatRemovalContext = {
    currentViewId: 'managedAgent',
    agentRoomId: 'test-room',
  };

  it('calls leaveOpenChat when archiving the currently open chat', async () => {
    const isOpenChat = vi.fn(() => true);
    const leaveOpenChat = vi.fn();
    const archive = vi.fn().mockResolvedValue(undefined);
    const host = stubChatHost({
      isOpenChat,
      leaveOpenChat,
      chats: {
        ...stubChatHost().chats,
        archive,
        archived: new Map(),
      } as any,
    });

    const actions = chatActions(serverId, mockChat, mockContext, host);
    const archiveAction = actions.find((a) => a.key === 'archive');
    expect(archiveAction).toBeDefined();

    archiveAction!.run();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(archive).toHaveBeenCalledWith(serverId, 'test-room');
    expect(isOpenChat).toHaveBeenCalledWith('test-room');
    expect(leaveOpenChat).toHaveBeenCalledWith('test-room');
  });

  it('calls leaveOpenChat when deleting the currently open chat', async () => {
    const isOpenChat = vi.fn(() => true);
    const leaveOpenChat = vi.fn();
    const deleteChat = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.fn().mockResolvedValue(true);
    const host = stubChatHost({
      isOpenChat,
      leaveOpenChat,
      confirm,
      chats: {
        ...stubChatHost().chats,
        delete: deleteChat,
        archived: new Map(),
      } as any,
    });

    const actions = chatActions(serverId, mockChat, mockContext, host);
    const deleteAction = actions.find((a) => a.key === 'delete');
    expect(deleteAction).toBeDefined();

    deleteAction!.run();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(confirm).toHaveBeenCalled();
    expect(deleteChat).toHaveBeenCalledWith(serverId, 'test-room');
    expect(isOpenChat).toHaveBeenCalledWith('test-room');
    expect(leaveOpenChat).toHaveBeenCalledWith('test-room');
  });

  it('calls leaveOpenChat when leaving the currently open chat', async () => {
    const isOpenChat = vi.fn(() => true);
    const leaveOpenChat = vi.fn();
    const leave = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.fn().mockResolvedValue(true);
    const host = stubChatHost({
      isOpenChat,
      leaveOpenChat,
      confirm,
      chats: {
        ...stubChatHost().chats,
        leave,
        archived: new Map(),
      } as any,
    });

    confirmLeaveChat(serverId, { ...mockChat, canManage: false }, mockContext, host);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(confirm).toHaveBeenCalled();
    expect(leave).toHaveBeenCalledWith(serverId, 'test-room');
    expect(isOpenChat).toHaveBeenCalledWith('test-room');
    expect(leaveOpenChat).toHaveBeenCalledWith('test-room');
  });

  it('does not call leaveOpenChat when removing a non-open chat', async () => {
    const isOpenChat = vi.fn(() => false);
    const leaveOpenChat = vi.fn();
    const archive = vi.fn().mockResolvedValue(undefined);
    const host = stubChatHost({
      isOpenChat,
      leaveOpenChat,
      chats: {
        ...stubChatHost().chats,
        archive,
        archived: new Map(),
      } as any,
    });

    const actions = chatActions(serverId, mockChat, mockContext, host);
    const archiveAction = actions.find((a) => a.key === 'archive');
    archiveAction!.run();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(archive).toHaveBeenCalledWith(serverId, 'test-room');
    expect(isOpenChat).toHaveBeenCalledWith('test-room');
    expect(leaveOpenChat).not.toHaveBeenCalled();
  });
});
