import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatSummary } from '@shared/core/chats/chats';
import { EmptyChatFinder } from './empty-chat-finder';

const makeChat = (overrides: Partial<ChatSummary> = {}): ChatSummary => ({
  roomId: 'room-1',
  name: 'Chat',
  channelType: 'direct',
  bridgeType: null,
  channelName: null,
  agents: [{ id: 'agent-1', name: 'Agent', displayName: null, iconUrl: null, provider: null }],
  canManage: false,
  ownsAgent: false,
  lastMessage: null,
  ...overrides,
});

const makeMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId: 'msg-1',
  seq: 1,
  roomId: 'room-1',
  sentAt: '2024-01-01T00:00:00Z',
  sender: {
    clientId: 'client-1',
    name: 'User',
    kind: 'human',
    agentId: null,
    userId: 'user-1',
  },
  source: 'text',
  body: 'Hello',
  format: null,
  threadRootId: null,
  attachments: [],
  clientTxn: null,
  ...overrides,
});

describe('EmptyChatFinder', () => {
  it('returns null when userId is null', () => {
    const finder = new EmptyChatFinder({
      chatsOfAgent: () => [],
      userId: () => null,
      timeline: () => undefined,
    });

    expect(finder.find('agent-1')).toBeNull();
  });

  it('returns null when no chats exist for agent', () => {
    const finder = new EmptyChatFinder({
      chatsOfAgent: () => [],
      userId: () => 'user-1',
      timeline: () => undefined,
    });

    expect(finder.find('agent-1')).toBeNull();
  });

  it('returns chat with no messages', () => {
    const chat = makeChat({ roomId: 'room-1', lastMessage: null });
    const finder = new EmptyChatFinder({
      chatsOfAgent: () => [chat],
      userId: () => 'user-1',
      timeline: () => undefined,
    });

    expect(finder.find('agent-1')).toBe(chat);
  });

  it('returns null when chat has user message (from summary)', () => {
    const chat = makeChat({
      lastMessage: {
        seq: 1,
        sentAt: '2024-01-01T00:00:00Z',
        preview: 'Hello',
        senderName: 'User',
      },
    });
    const finder = new EmptyChatFinder({
      chatsOfAgent: () => [chat],
      userId: () => 'user-1',
      timeline: () => undefined,
    });

    expect(finder.find('agent-1')).toBeNull();
  });

  it('returns chat with only agent messages when timeline is loaded', () => {
    const chat = makeChat({ roomId: 'room-1' });
    const agentMessage = makeMessage({
      sender: {
        clientId: 'client-2',
        name: 'Agent',
        kind: 'agent',
        agentId: 'agent-1',
        userId: null,
      },
    });
    const finder = new EmptyChatFinder({
      chatsOfAgent: () => [chat],
      userId: () => 'user-1',
      timeline: (roomId) =>
        roomId === 'room-1' ? { messages: [agentMessage], loaded: true } : undefined,
    });

    expect(finder.find('agent-1')).toBe(chat);
  });

  it('returns null when timeline has user message', () => {
    const chat = makeChat({ roomId: 'room-1' });
    const userMessage = makeMessage({
      sender: {
        clientId: 'client-1',
        name: 'User',
        kind: 'human',
        agentId: null,
        userId: 'user-1',
      },
    });
    const finder = new EmptyChatFinder({
      chatsOfAgent: () => [chat],
      userId: () => 'user-1',
      timeline: (roomId) =>
        roomId === 'room-1' ? { messages: [userMessage], loaded: true } : undefined,
    });

    expect(finder.find('agent-1')).toBeNull();
  });

  it('returns null when timeline has both agent and user messages', () => {
    const chat = makeChat({ roomId: 'room-1' });
    const agentMessage = makeMessage({
      seq: 1,
      sender: {
        clientId: 'client-2',
        name: 'Agent',
        kind: 'agent',
        agentId: 'agent-1',
        userId: null,
      },
    });
    const userMessage = makeMessage({
      seq: 2,
      sender: {
        clientId: 'client-1',
        name: 'User',
        kind: 'human',
        agentId: null,
        userId: 'user-1',
      },
    });
    const finder = new EmptyChatFinder({
      chatsOfAgent: () => [chat],
      userId: () => 'user-1',
      timeline: (roomId) =>
        roomId === 'room-1' ? { messages: [agentMessage, userMessage], loaded: true } : undefined,
    });

    expect(finder.find('agent-1')).toBeNull();
  });

  it('returns most recent empty chat', () => {
    const older = makeChat({
      roomId: 'room-1',
      lastMessage: null,
    });
    const newer = makeChat({
      roomId: 'room-2',
      lastMessage: null,
    });
    const finder = new EmptyChatFinder({
      chatsOfAgent: () => [newer, older],
      userId: () => 'user-1',
      timeline: () => undefined,
    });

    expect(finder.find('agent-1')).toBe(newer);
  });

  it('prefers timeline over summary when timeline is loaded', () => {
    const chat = makeChat({
      roomId: 'room-1',
      lastMessage: {
        seq: 1,
        sentAt: '2024-01-01T00:00:00Z',
        preview: 'Hello',
        senderName: 'Agent',
      },
    });
    const agentMessage = makeMessage({
      sender: {
        clientId: 'client-2',
        name: 'Agent',
        kind: 'agent',
        agentId: 'agent-1',
        userId: null,
      },
    });
    const finder = new EmptyChatFinder({
      chatsOfAgent: () => [chat],
      userId: () => 'user-1',
      timeline: (roomId) =>
        roomId === 'room-1' ? { messages: [agentMessage], loaded: true } : undefined,
    });

    expect(finder.find('agent-1')).toBe(chat);
  });

  it('uses summary when timeline not loaded', () => {
    const chat = makeChat({ roomId: 'room-1', lastMessage: null });
    const finder = new EmptyChatFinder({
      chatsOfAgent: () => [chat],
      userId: () => 'user-1',
      timeline: (roomId) => (roomId === 'room-1' ? { messages: [], loaded: false } : undefined),
    });

    expect(finder.find('agent-1')).toBe(chat);
  });

  it('returns chat with default name and agent greeting when timeline not loaded', () => {
    const chat = makeChat({
      roomId: 'room-1',
      name: 'Chat with Agent',
      agents: [{ id: 'agent-1', name: 'Agent', displayName: null, iconUrl: null, provider: null }],
      lastMessage: {
        seq: 1,
        sentAt: '2024-01-01T00:00:00Z',
        preview: 'Hello',
        senderName: 'Agent',
      },
    });
    const finder = new EmptyChatFinder({
      chatsOfAgent: () => [chat],
      userId: () => 'user-1',
      timeline: () => undefined,
    });

    expect(finder.find('agent-1')).toBe(chat);
  });

  it('returns chat named "New Chat" with an agent greeting', () => {
    const chat = makeChat({
      roomId: 'room-1',
      name: 'New Chat',
      agents: [{ id: 'agent-1', name: 'Agent', displayName: null, iconUrl: null, provider: null }],
      lastMessage: {
        seq: 1,
        sentAt: '2024-01-01T00:00:00Z',
        preview: 'Hello',
        senderName: 'Agent',
      },
    });
    const finder = new EmptyChatFinder({
      chatsOfAgent: () => [chat],
      userId: () => 'user-1',
      timeline: () => undefined,
    });

    expect(finder.find('agent-1')).toBe(chat);
  });

  it('returns chat with the earlier "New chat" name and an agent greeting', () => {
    const chat = makeChat({
      roomId: 'room-1',
      name: 'New chat',
      agents: [{ id: 'agent-1', name: 'Agent', displayName: null, iconUrl: null, provider: null }],
      lastMessage: {
        seq: 1,
        sentAt: '2024-01-01T00:00:00Z',
        preview: 'Hello',
        senderName: 'Agent',
      },
    });
    const finder = new EmptyChatFinder({
      chatsOfAgent: () => [chat],
      userId: () => 'user-1',
      timeline: () => undefined,
    });

    expect(finder.find('agent-1')).toBe(chat);
  });

  it('returns chat with default name using displayName and agent greeting', () => {
    const chat = makeChat({
      roomId: 'room-1',
      name: 'Chat with Ada',
      agents: [{ id: 'agent-1', name: 'ada', displayName: 'Ada', iconUrl: null, provider: null }],
      lastMessage: {
        seq: 1,
        sentAt: '2024-01-01T00:00:00Z',
        preview: 'Hello',
        senderName: 'Ada',
      },
    });
    const finder = new EmptyChatFinder({
      chatsOfAgent: () => [chat],
      userId: () => 'user-1',
      timeline: () => undefined,
    });

    expect(finder.find('agent-1')).toBe(chat);
  });

  it('returns null when chat has default name but last message from user', () => {
    const chat = makeChat({
      roomId: 'room-1',
      name: 'Chat with Agent',
      lastMessage: {
        seq: 1,
        sentAt: '2024-01-01T00:00:00Z',
        preview: 'Hello',
        senderName: 'User',
      },
    });
    const finder = new EmptyChatFinder({
      chatsOfAgent: () => [chat],
      userId: () => 'user-1',
      timeline: () => undefined,
    });

    expect(finder.find('agent-1')).toBeNull();
  });

  it('returns null when chat has custom name even with agent greeting', () => {
    const chat = makeChat({
      roomId: 'room-1',
      name: 'My Custom Chat',
      lastMessage: {
        seq: 1,
        sentAt: '2024-01-01T00:00:00Z',
        preview: 'Hello',
        senderName: 'Agent',
      },
    });
    const finder = new EmptyChatFinder({
      chatsOfAgent: () => [chat],
      userId: () => 'user-1',
      timeline: () => undefined,
    });

    expect(finder.find('agent-1')).toBeNull();
  });

  it('handles multi-agent chat default name', () => {
    const chat = makeChat({
      roomId: 'room-1',
      name: 'Chat with Ada, Bob',
      agents: [
        { id: 'agent-1', name: 'ada', displayName: 'Ada', iconUrl: null, provider: null },
        { id: 'agent-2', name: 'bob', displayName: 'Bob', iconUrl: null, provider: null },
      ],
      lastMessage: {
        seq: 1,
        sentAt: '2024-01-01T00:00:00Z',
        preview: 'Hello',
        senderName: 'Ada',
      },
    });
    const finder = new EmptyChatFinder({
      chatsOfAgent: () => [chat],
      userId: () => 'user-1',
      timeline: () => undefined,
    });

    expect(finder.find('agent-1')).toBe(chat);
  });
});
