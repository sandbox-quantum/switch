import { ConversationManagerStore } from '@renderer/features/sessions/conversations/conversation-manager';
import type { Session } from '@shared/core/sessions/sessions';

export class ConversationRegistry {
  private readonly entries = new Map<string, ConversationManagerStore>();

  acquire(sessionId: string, projectId: string, preloaded?: Session[]): ConversationManagerStore {
    const existing = this.entries.get(sessionId);
    if (existing) return existing;
    const store = new ConversationManagerStore(projectId, sessionId, preloaded);
    this.entries.set(sessionId, store);
    return store;
  }

  get(sessionId: string): ConversationManagerStore | undefined {
    return this.entries.get(sessionId);
  }

  release(sessionId: string): void {
    const store = this.entries.get(sessionId);
    if (!store) return;
    store.dispose();
    this.entries.delete(sessionId);
  }
}

export const conversationRegistry = new ConversationRegistry();
