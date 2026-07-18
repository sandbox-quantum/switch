import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

export type ConversationCrudHooks = {
  'conversation:renamed': (
    conversationId: string,
    projectId: string,
    sessionId: string,
    newTitle: string
  ) => void | Promise<void>;
  'conversation:deleted': (conversationId: string) => void | Promise<void>;
  /**
   * A remote session was deliberately terminated on another client (or this one)
   * and the sidecar broadcast a `session-terminated` event. The owning provider
   * has already torn down its local PTY/relay; this signals the DB-level cleanup
   * (delete the row, tombstone the id, emit `conversation:deleted`) so the ghost
   * row does not linger and get re-attached into a blank tmux session.
   */
  'conversation:remote-terminated': (params: {
    projectId: string;
    sessionId: string;
    conversationId: string;
  }) => void | Promise<void>;
  /**
   * An agent PTY exited unexpectedly (i.e. not a deliberate stop). In-process
   * counterpart to the renderer-bound `agentSessionExitedChannel` — main-process
   * reactions must use this, since `events` only delivers main→renderer.
   */
  'conversation:session-exited': (params: {
    conversationId: string;
    sessionId: string;
  }) => void | Promise<void>;
  'conversation:input-submitted': (params: {
    projectId: string;
    sessionId: string;
    conversationId: string;
    providerId: AgentProviderId;
  }) => void | Promise<void>;
};

class ConversationEvents implements Hookable<ConversationCrudHooks> {
  private readonly _core = new HookCore<ConversationCrudHooks>((name, e) =>
    log.error(`ConversationEvents: ${String(name)} hook error`, e)
  );

  on<K extends keyof ConversationCrudHooks>(name: K, handler: ConversationCrudHooks[K]) {
    return this._core.on(name, handler);
  }

  _emit<K extends keyof ConversationCrudHooks>(
    name: K,
    ...args: Parameters<ConversationCrudHooks[K]>
  ): void {
    this._core.callHookBackground(name, ...args);
  }
}

export const conversationEvents = new ConversationEvents();
