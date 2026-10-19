import type { ChatMessage, ChatSummary } from '@shared/core/chats/chats';

export type LoadedTimeline = {
  messages: ChatMessage[];
  loaded: boolean;
};

export type EmptyChatFinderDeps = {
  chatsOfAgent: (agentId: string) => ChatSummary[];
  userId: () => string | null;
  timeline: (roomId: string) => LoadedTimeline | undefined;
};

/**
 * Finds the most recent empty chat for an agent, where "empty" means the
 * current user has sent no messages. Agent greetings don't count as use.
 */
export class EmptyChatFinder {
  constructor(private readonly deps: EmptyChatFinderDeps) {}

  find(agentId: string): ChatSummary | null {
    const userId = this.deps.userId();
    if (!userId) return null;

    const chats = this.deps.chatsOfAgent(agentId);
    const empty = chats.filter((chat) => this.isEmpty(chat, userId));
    return empty[0] ?? null;
  }

  private isEmpty(chat: ChatSummary, userId: string): boolean {
    const timeline = this.deps.timeline(chat.roomId);

    if (timeline?.loaded) {
      return timeline.messages.every((msg) => msg.sender.userId !== userId);
    }

    if (chat.lastMessage === null) return true;

    const lastMessageFromAgent = chat.agents.some(
      (agent) =>
        chat.lastMessage?.senderName === agent.name ||
        chat.lastMessage?.senderName === agent.displayName
    );

    return this.hasDefaultName(chat) && lastMessageFromAgent;
  }

  /** "New chat" now; "Chat with <agents>" for chats made before that default. */
  private hasDefaultName(chat: ChatSummary): boolean {
    const agentNames = chat.agents.map((agent) => agent.displayName || agent.name).join(', ');
    return chat.name === 'New chat' || chat.name === `Chat with ${agentNames}`;
  }
}
