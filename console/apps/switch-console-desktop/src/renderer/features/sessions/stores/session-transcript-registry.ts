import { SessionTranscriptStore } from '@renderer/features/sessions/stores/session-transcript-store';

/**
 * One transcript store per provider-backed session, created on first use.
 *
 * Mirrors the session-agent registry: the view acquires on mount and releases
 * on unmount, so a session the user is not looking at holds no subscription.
 */
export class SessionTranscriptRegistry {
  private readonly entries = new Map<string, SessionTranscriptStore>();

  acquire(sessionId: string): SessionTranscriptStore {
    const existing = this.entries.get(sessionId);
    if (existing) return existing;
    const store = new SessionTranscriptStore(sessionId);
    this.entries.set(sessionId, store);
    return store;
  }

  get(sessionId: string): SessionTranscriptStore | undefined {
    return this.entries.get(sessionId);
  }

  release(sessionId: string): void {
    const store = this.entries.get(sessionId);
    if (!store) return;
    store.dispose();
    this.entries.delete(sessionId);
  }
}

export const sessionTranscriptRegistry = new SessionTranscriptRegistry();
