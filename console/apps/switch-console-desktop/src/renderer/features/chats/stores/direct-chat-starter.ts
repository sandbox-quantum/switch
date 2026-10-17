import type { ChatSummary } from '@shared/core/chats/chats';
import { chatFailure } from './chat-errors';

export type DirectChatStarterDeps = {
  create: (input: {
    serverId: string;
    agentIds: string[];
    name: null;
    requestId: string;
    greeting: null;
  }) => Promise<ChatSummary>;
  created: (serverId: string, chat: ChatSummary) => void;
  opened: (chat: ChatSummary) => void;
  failed: (message: string) => void;
  findEmpty: (agentId: string) => ChatSummary | null;
  newId: () => string;
};

/**
 * Starts an unnamed direct chat with one agent. Reuses an existing empty chat
 * (one where the user has sent no messages) if one exists. A second start for
 * the same agent while one is in flight is ignored. After a failure that may
 * have landed, the next start reuses its request id, so it resumes that chat
 * rather than making another.
 */
export class DirectChatStarter {
  private readonly inFlight = new Set<string>();
  private readonly retryIds = new Map<string, string>();

  constructor(private readonly deps: DirectChatStarterDeps) {}

  async start(serverId: string, agentId: string): Promise<ChatSummary | null> {
    const existing = this.deps.findEmpty(agentId);
    if (existing) {
      this.deps.opened(existing);
      return existing;
    }

    const key = `${serverId}:${agentId}`;
    if (this.inFlight.has(key)) return null;
    this.inFlight.add(key);
    const requestId = this.retryIds.get(key) ?? this.deps.newId();
    try {
      const chat = await this.deps.create({
        serverId,
        agentIds: [agentId],
        name: null,
        requestId,
        greeting: null,
      });
      this.retryIds.delete(key);
      this.deps.created(serverId, chat);
      return chat;
    } catch (caught) {
      const failure = chatFailure(caught);
      if (failure.kind === 'other' && failure.uncertain) {
        this.retryIds.set(key, requestId);
        this.deps.failed(
          `${failure.message} Try again: it resumes the same chat rather than making another.`
        );
      } else {
        this.retryIds.delete(key);
        this.deps.failed(failure.message);
      }
      return null;
    } finally {
      this.inFlight.delete(key);
    }
  }
}
