import type { IDisposable } from '@switchdash/shared';
import { action, computed, makeObservable, observable, reaction, runInAction } from 'mobx';
import { makeFileLinkHandlers } from '@renderer/features/sessions/stores/file-link-handlers';
import { events, rpc } from '@renderer/lib/ipc';
import { PtySession } from '@renderer/lib/pty/pty-session';
import { Resource } from '@renderer/lib/stores/resource';
import { log } from '@renderer/utils/logger';
import { soundPlayer } from '@renderer/utils/soundPlayer';
import {
  agentSessionExitedChannel,
  type AgentStatus,
  type NotificationType,
} from '@shared/core/providers/agentEvents';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import {
  sessionAgentStatusChangedChannel,
  sessionChangedChannel,
} from '@shared/core/sessions/sessionEvents';
import { type Session } from '@shared/core/sessions/sessions';

export class ConversationManagerStore implements IDisposable {
  private offAgentStatusChanged: (() => void) | null = null;
  private offSessionExited: (() => void) | null = null;
  private offConversationChanges: (() => void) | null = null;
  private readonly _disposeReaction: () => void;

  /** Data layer: the session record loaded from the main process (1:1 with this store). */
  readonly list: Resource<Session[]>;
  /** Runtime state stores keyed by conversation id — populated by reaction on list.data. */
  conversations = observable.map<string, ConversationStore>();
  /** Session layer keyed by conversation id — created alongside data, connected lazily. */
  sessions = observable.map<string, PtySession>();

  constructor(
    private readonly projectId: string,
    private readonly sessionId: string,
    preloaded?: Session[]
  ) {
    makeObservable(this, {
      conversations: observable,
      sessions: observable,
      sessionStatus: computed,
    });

    const hasPreloaded = preloaded !== undefined;
    this.list = new Resource<Session[]>(
      hasPreloaded ? null : () => rpc.sessions.getSession(sessionId).then((s) => (s ? [s] : [])),
      hasPreloaded ? [] : [{ kind: 'demand' }],
      hasPreloaded ? { init: preloaded } : undefined
    );

    // When preloaded data is available, populate the maps synchronously so
    // they are accessible immediately — even when this constructor is called
    // from within a MobX action, where reaction callbacks (including
    // fireImmediately) are deferred until the outermost action completes.
    if (preloaded) {
      runInAction(() => {
        for (const conversation of preloaded) {
          if (!this.conversations.has(conversation.id)) {
            this.conversations.set(conversation.id, new ConversationStore(conversation));
          }
          if (!this.sessions.has(conversation.id)) {
            this.sessions.set(conversation.id, this.createSession(conversation));
          }
        }
      });
    }

    // Sync conversations and sessions maps whenever resource data changes.
    // fireImmediately handles the non-preloaded case; for preloaded data the
    // maps are already populated above so this is a no-op on first run.
    this._disposeReaction = reaction(
      () => this.list.data,
      (data) => {
        if (!data) return;
        runInAction(() => {
          for (const conversation of data) {
            if (!this.conversations.has(conversation.id)) {
              this.conversations.set(conversation.id, new ConversationStore(conversation));
            }
            if (!this.sessions.has(conversation.id)) {
              this.sessions.set(conversation.id, this.createSession(conversation));
            }
          }
        });
      },
      { fireImmediately: true }
    );

    this.offAgentStatusChanged = this.listenToAgentStatusChanged();
    this.offSessionExited = this.listenToSessionExited();
    this.offConversationChanges = this.listenToConversationChanges();
  }

  private listenToAgentStatusChanged(): () => void {
    return events.on(sessionAgentStatusChangedChannel, (payload) => {
      if (payload.sessionId !== this.sessionId) return;
      const conversationStore = this.conversations.get(payload.sessionId);
      if (!conversationStore) return;

      runInAction(() => {
        conversationStore.status = payload.status;
        conversationStore.seen = payload.seen;
        if (payload.status !== 'awaiting-input') {
          conversationStore.lastNotificationType = null;
        }
      });

      if (payload.soundEvent) {
        soundPlayer.play(payload.soundEvent, true);
      }
    });
  }

  private listenToSessionExited(): () => void {
    return events.on(agentSessionExitedChannel, (event) => {
      if (event.sessionId !== this.sessionId) return;
      const conversationStore = this.conversations.get(event.sessionId);
      if (!conversationStore) return;
      conversationStore.clearWorking();
    });
  }

  private listenToConversationChanges(): () => void {
    return events.on(sessionChangedChannel, (event) => {
      if (event.sessionId !== this.sessionId) return;
      const store = this.conversations.get(event.sessionId);
      if (!store) return;
      runInAction(() => {
        Object.assign(store.data, event.changes);
      });
    });
  }

  get sessionStatus(): AgentStatus | null {
    let hasWorking = false;
    let hasUnseenError = false;
    let hasUnseenCompleted = false;
    for (const conversation of this.conversations.values()) {
      if (!conversation.seen && conversation.status === 'awaiting-input') return 'awaiting-input';
      if (conversation.status === 'working') hasWorking = true;
      if (!conversation.seen && conversation.status === 'error') hasUnseenError = true;
      if (!conversation.seen && conversation.status === 'completed') hasUnseenCompleted = true;
    }
    if (hasWorking) return 'working';
    if (hasUnseenError) return 'error';
    if (hasUnseenCompleted) return 'completed';
    return null;
  }

  async markConversationWorking(conversationId: string): Promise<void> {
    if (!this.list.data) {
      await this.list.load();
    }

    runInAction(() => {
      const store = this.conversations.get(conversationId);
      if (!store) {
        log.warn(`ConversationManagerStore: conversation ${conversationId} not found after load`, {
          projectId: this.projectId,
          sessionId: this.sessionId,
        });
        return;
      }
      store.setWorking();
    });
  }

  async hydrateConversation(_conversationId: string): Promise<void> {
    await rpc.sessions.hydrateSession(this.projectId, this.sessionId);
  }

  async dehydrateConversation(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    session?.dispose();
    await rpc.sessions.dehydrateSession(this.projectId, this.sessionId);
  }

  dispose(): void {
    this._disposeReaction();
    this.offAgentStatusChanged?.();
    this.offAgentStatusChanged = null;
    this.offSessionExited?.();
    this.offSessionExited = null;
    this.offConversationChanges?.();
    this.offConversationChanges = null;
    for (const session of this.sessions.values()) {
      session.destroy();
    }
  }

  private createSession(session: Session): PtySession {
    const handlers = makeFileLinkHandlers(this.projectId, this.sessionId);
    return new PtySession(
      makePtySessionId(this.projectId, this.sessionId, session.id),
      undefined,
      handlers.onOpenFile,
      handlers.onOpenExternal,
      { clearOnBackendStart: true }
    );
  }
}

export class ConversationStore {
  data: Session;
  status: AgentStatus;
  seen: boolean;
  lastNotificationType: NotificationType | null = null;

  constructor(session: Session) {
    this.data = session;
    this.status = session.agentStatus ?? 'idle';
    this.seen = session.agentStatusSeen ?? true;
    makeObservable(this, {
      data: observable,
      status: observable,
      seen: observable,
      lastNotificationType: observable,
      setStatus: action,
      setAwaitingInput: action,
      setWorking: action,
      clearWorking: action,
      markSeen: action,
      isInitialConversation: computed,
      indicatorStatus: computed,
    });
  }

  get isInitialConversation(): boolean {
    return this.data.isInitialSession === true;
  }

  get indicatorStatus(): AgentStatus | null {
    if (this.status === 'working') return 'working';
    if (this.seen) return null;
    if (this.status === 'awaiting-input') return 'awaiting-input';
    if (this.status === 'error') return 'error';
    if (this.status === 'completed') return 'completed';
    return null;
  }

  setStatus(status: AgentStatus) {
    this.status = status;
    this.seen = status === 'idle' || status === 'working';
    if (status !== 'awaiting-input') {
      this.lastNotificationType = null;
    }
  }

  setAwaitingInput(notificationType: NotificationType) {
    this.lastNotificationType = notificationType;
    this.setStatus('awaiting-input');
  }

  setWorking() {
    if (this.status === 'awaiting-input' && this.lastNotificationType === 'permission_prompt') {
      return;
    }
    this.lastNotificationType = null;
    this.setStatus('working');
  }

  clearWorking() {
    if (this.status === 'working' || this.status === 'awaiting-input') {
      this.setStatus('idle');
    }
  }

  markSeen() {
    this.seen = true;
    void rpc.sessions.markSessionSeen(this.data.id);
  }

  dispose() {
    // Session is managed by ConversationManagerStore.sessions — nothing to do here.
  }
}
