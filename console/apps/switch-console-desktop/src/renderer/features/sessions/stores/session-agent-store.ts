import type { IDisposable } from '@switch-console/shared';
import { action, computed, makeObservable, observable, reaction, runInAction } from 'mobx';
import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
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
import { makeAgentPtySessionId } from '@shared/core/pty/ptySessionId';
import {
  sessionAgentStatusChangedChannel,
  sessionAttachmentChangedChannel,
  sessionChangedChannel,
} from '@shared/core/sessions/sessionEvents';
import { type Session } from '@shared/core/sessions/sessions';

export const DEHYDRATE_RETRY_DELAY_MS = 500;

type HydrationState = 'stopped' | 'starting' | 'running' | 'stopping';

/** Mirrors the main-process attachment pool's view of a remote terminal. */
export type AttachState = 'detached' | 'attaching' | 'attached' | 'failed';

/**
 * Renderer-side handle for a session's single agent: its status store, its PTY
 * session, and the hydrate/dehydrate lifecycle that connects the agent PTY
 * while the session view is provisioned. One instance per session, held in the
 * session-agent registry.
 */
export class SessionAgentStore implements IDisposable {
  private offAgentStatusChanged: (() => void) | null = null;
  private offSessionExited: (() => void) | null = null;
  private offSessionChanges: (() => void) | null = null;
  private offAttachmentChanged: (() => void) | null = null;
  private readonly _disposeReaction: () => void;

  /** Data layer: the session record loaded from the main process (1:1 with this store). */
  readonly list: Resource<Session[]>;
  /** The session's single agent-status store — null until the session record loads. */
  agent: AgentStatusStore | null = null;
  /** The agent's PTY session — created alongside the record, connected lazily. */
  pty: PtySession | null = null;
  /**
   * Whether this session's terminal is open, for remote sessions. Owned by the
   * main-process attachment pool and pushed here; `detached` is a normal
   * resting state, not an error — the agent keeps running on its VM.
   */
  attachment: AttachState = 'detached';

  // Hydration lifecycle: desired-vs-actual for the agent PTY, with the same
  // stale-flip handling and dehydrate retry the old reconciler had.
  private hydrationDesired = false;
  private hydrationState: HydrationState = 'stopped';
  private dehydrateRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private hydrationDisposed = false;

  constructor(
    private readonly locationId: string,
    private readonly sessionId: string,
    preloaded?: Session[]
  ) {
    makeObservable(this, {
      agent: observable,
      pty: observable,
      attachment: observable,
      sessionStatus: computed,
    });

    const hasPreloaded = preloaded !== undefined;
    this.list = new Resource<Session[]>(
      hasPreloaded ? null : () => rpc.sessions.getSession(sessionId).then((s) => (s ? [s] : [])),
      hasPreloaded ? [] : [{ kind: 'demand' }],
      hasPreloaded ? { init: preloaded } : undefined
    );

    // When preloaded data is available, populate synchronously so the store is
    // usable immediately — even when this constructor is called from within a
    // MobX action, where reaction callbacks (including fireImmediately) are
    // deferred until the outermost action completes.
    if (preloaded) {
      runInAction(() => this.adopt(preloaded[0]));
    }

    // Adopt the session record whenever resource data changes. fireImmediately
    // handles the non-preloaded case; for preloaded data the store is already
    // populated above so this is a no-op on first run.
    this._disposeReaction = reaction(
      () => this.list.data,
      (data) => {
        if (!data?.length) return;
        runInAction(() => this.adopt(data[0]));
      },
      { fireImmediately: true }
    );

    this.offAgentStatusChanged = this.listenToAgentStatusChanged();
    this.offSessionExited = this.listenToSessionExited();
    this.offSessionChanges = this.listenToSessionChanges();
    this.offAttachmentChanged = this.listenToAttachmentChanged();
  }

  /**
   * Remote sessions are attached by the main-process pool when the user focuses
   * them, and only a few per host at a time. Provisioning one must therefore
   * not open its terminal — that eagerness is what put a whole host's worth of
   * channels on a single SSH transport.
   */
  private get attachmentIsPoolManaged(): boolean {
    return getLocationManagerStore().locations.get(this.locationId)?.data?.sshHost != null;
  }

  private listenToAttachmentChanged(): () => void {
    return events.on(sessionAttachmentChangedChannel, (payload) => {
      if (payload.sessionId !== this.sessionId) return;
      runInAction(() => {
        this.attachment = payload.state;
      });

      if (payload.state === 'attached') {
        // Explicit: PtySession connects itself via onBecomeObserved, which only
        // fires on the unobserved -> observed edge. After a dispose the terminal
        // pane is usually still mounted and observing, so it would never re-fire.
        void this.pty?.connect();
        return;
      }
      if (payload.state === 'detached' || payload.state === 'failed') {
        this.pty?.dispose();
      }
    });
  }

  private adopt(session: Session | undefined): void {
    if (!session) return;
    if (!this.agent) {
      this.agent = new AgentStatusStore(session);
    }
    if (!this.pty) {
      const handlers = makeFileLinkHandlers(this.locationId, this.sessionId);
      this.pty = new PtySession(
        makeAgentPtySessionId(this.locationId, this.sessionId),
        undefined,
        handlers.onOpenFile,
        handlers.onOpenExternal,
        { clearOnBackendStart: true }
      );
    }
  }

  private listenToAgentStatusChanged(): () => void {
    return events.on(sessionAgentStatusChangedChannel, (payload) => {
      if (payload.sessionId !== this.sessionId) return;
      const agent = this.agent;
      if (!agent) return;

      runInAction(() => {
        agent.status = payload.status;
        agent.seen = payload.seen;
        if (payload.status !== 'awaiting-input') {
          agent.lastNotificationType = null;
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
      this.agent?.clearWorking();
    });
  }

  private listenToSessionChanges(): () => void {
    return events.on(sessionChangedChannel, (event) => {
      if (event.sessionId !== this.sessionId) return;
      const agent = this.agent;
      if (!agent) return;
      runInAction(() => {
        Object.assign(agent.data, event.changes);
      });
    });
  }

  /** The session's agent status as shown on sidebar badges and notifications. */
  get sessionStatus(): AgentStatus | null {
    return this.agent?.indicatorStatus ?? null;
  }

  async markWorking(): Promise<void> {
    if (!this.list.data) {
      await this.list.load();
    }

    runInAction(() => {
      if (!this.agent) {
        log.warn(`SessionAgentStore: session ${this.sessionId} not found after load`, {
          locationId: this.locationId,
        });
        return;
      }
      this.agent.setWorking();
    });
  }

  // --- Hydration lifecycle -------------------------------------------------

  /**
   * Keep the agent PTY hydrated while the session view is provisioned.
   *
   * Local sessions only: their agent process is this app's to run, and it must
   * be live for keystroke injection to reach it. A remote agent runs on its VM
   * regardless, so its terminal is opened on focus by the attachment pool
   * instead — see `attachmentIsPoolManaged`.
   */
  setHydrationDesired(desired: boolean): void {
    if (this.hydrationDisposed) return;
    if (this.attachmentIsPoolManaged) return;
    this.hydrationDesired = desired;
    if (desired) this.clearDehydrateRetry();
    this.reconcileHydration();
  }

  private reconcileHydration(): void {
    if (this.hydrationDesired && this.hydrationState === 'stopped') {
      void this.hydrate();
      return;
    }
    if (!this.hydrationDesired && this.hydrationState === 'running') {
      void this.dehydrate();
    }
  }

  private async hydrate(): Promise<void> {
    this.hydrationState = 'starting';
    try {
      await rpc.sessions.hydrateSession(this.sessionId);
    } catch (error) {
      this.hydrationState = 'stopped';
      log.warn('SessionAgentStore: failed to hydrate session', {
        sessionId: this.sessionId,
        error,
      });
      return;
    }

    this.hydrationState = 'running';
    // intent may have flipped while we awaited — tear down if no longer wanted
    if (this.hydrationDesired) return;
    void this.dehydrate('stale-hydrate');
  }

  private async dehydrate(reason: 'sync' | 'stale-hydrate' = 'sync'): Promise<void> {
    this.hydrationState = 'stopping';
    this.pty?.dispose();
    try {
      await rpc.sessions.dehydrateSession(this.sessionId);
    } catch (error) {
      this.hydrationState = 'running';
      log.warn(
        reason === 'stale-hydrate'
          ? 'SessionAgentStore: failed to dehydrate stale session'
          : 'SessionAgentStore: failed to dehydrate session',
        { sessionId: this.sessionId, error }
      );
      if (!this.hydrationDesired) this.scheduleDehydrateRetry();
      return;
    }

    this.hydrationState = 'stopped';
    this.clearDehydrateRetry();
    // intent may have flipped while we awaited — restart if wanted again
    if (this.hydrationDesired) this.reconcileHydration();
  }

  private scheduleDehydrateRetry(): void {
    if (this.hydrationDisposed || this.dehydrateRetryTimer) return;
    this.dehydrateRetryTimer = setTimeout(() => {
      this.dehydrateRetryTimer = null;
      if (this.hydrationDesired) return;
      this.reconcileHydration();
    }, DEHYDRATE_RETRY_DELAY_MS);
  }

  private clearDehydrateRetry(): void {
    if (!this.dehydrateRetryTimer) return;
    clearTimeout(this.dehydrateRetryTimer);
    this.dehydrateRetryTimer = null;
  }

  dispose(): void {
    this.hydrationDesired = false;
    if (this.hydrationState === 'running') void this.dehydrate();
    this.hydrationDisposed = true;
    this.clearDehydrateRetry();
    this._disposeReaction();
    this.offAgentStatusChanged?.();
    this.offAgentStatusChanged = null;
    this.offSessionExited?.();
    this.offSessionExited = null;
    this.offSessionChanges?.();
    this.offSessionChanges = null;
    this.offAttachmentChanged?.();
    this.offAttachmentChanged = null;
    this.pty?.destroy();
  }
}

export class AgentStatusStore {
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
      indicatorStatus: computed,
    });
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
}
