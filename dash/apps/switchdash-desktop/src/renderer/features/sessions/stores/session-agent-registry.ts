import { SessionAgentStore } from '@renderer/features/sessions/stores/session-agent-store';
import type { Session } from '@shared/core/sessions/sessions';

export class SessionAgentRegistry {
  private readonly entries = new Map<string, SessionAgentStore>();

  acquire(sessionId: string, locationId: string, preloaded?: Session[]): SessionAgentStore {
    const existing = this.entries.get(sessionId);
    if (existing) return existing;
    const store = new SessionAgentStore(locationId, sessionId, preloaded);
    this.entries.set(sessionId, store);
    return store;
  }

  get(sessionId: string): SessionAgentStore | undefined {
    return this.entries.get(sessionId);
  }

  release(sessionId: string): void {
    const store = this.entries.get(sessionId);
    if (!store) return;
    store.dispose();
    this.entries.delete(sessionId);
  }
}

export const sessionAgentRegistry = new SessionAgentRegistry();
