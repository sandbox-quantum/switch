import { makeObservable, observable, runInAction, toJS } from 'mobx';
import { toast } from 'sonner';
import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import type { LocationSettingsStore } from '@renderer/features/locations/stores/location-settings-store';
import { events, rpc } from '@renderer/lib/ipc';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import {
  lifecycleScriptStatusChannel,
  sessionCreatedChannel,
  sessionDeletedChannel,
  sessionProvisionProgressChannel,
  sessionProvisionedChannel,
  sessionStatusUpdatedChannel,
} from '@shared/core/sessions/sessionEvents';
import type {
  CreateSessionError,
  CreateSessionParams,
  Session,
  SessionLifecycleStatus,
} from '@shared/core/sessions/sessions';
import { sessionAgentRegistry } from './session-agent-registry';
import {
  createUnprovisionedSession,
  createUnregisteredSession,
  isProvisioned,
  isRegistered,
  isUnprovisioned,
  isUnregistered,
  type SessionStore,
} from './session-store';
import { sessionRuntimeRegistry } from './session-runtime-registry';

function formatCreateSessionError(error: CreateSessionError): string {
  switch (error.type) {
    case 'agent-not-found':
      return 'Agent not found.';
    case 'already-exists':
      return 'A session with this id already exists.';
    case 'spawn-failed':
      return error.message;
  }
}

export class SessionManagerStore {
  private readonly locationId: string;
  private readonly _settingsStore: LocationSettingsStore;
  private _loadPromise: Promise<void> | null = null;
  private _teardownPromises = new Map<string, Promise<void>>();
  private _provisionPromises = new Map<string, Promise<void>>();
  /** session:provisioned events that arrived before their session:created
   * (main-process automation emits both back-to-back; the created handler is
   * async, so provisioned can win the race). Applied once the session lands. */
  private _pendingProvisioned = new Map<string, { path: string }>();

  private _unsubSessionCreated: (() => void) | null = null;
  private _unsubSessionDeleted: (() => void) | null = null;
  private _unsubProvisionProgress: (() => void) | null = null;
  private _unsubStatusUpdated: (() => void) | null = null;
  private _unsubLifecycleScriptStatus: (() => void) | null = null;
  private _unsubProvisioned: (() => void) | null = null;

  sessions = observable.map<string, SessionStore>();

  constructor(locationId: string, settingsStore: LocationSettingsStore) {
    this.locationId = locationId;
    this._settingsStore = settingsStore;
    makeObservable(this, { sessions: observable });

    this._unsubSessionCreated = events.on(sessionCreatedChannel, ({ session }) => {
      if (this.sessions.has(session.id)) return;
      void rpc.agents.getAgentById(session.agentId).then((agent) => {
        if (!agent || agent.locationId !== this.locationId || this.sessions.has(session.id)) return;
        runInAction(() => {
          this.sessions.set(session.id, createUnprovisionedSession(this.locationId, session));
          // This session was created elsewhere (the auto-session watcher /
          // another window), so there is no record to seed — omit the preloaded
          // list so the store demand-fetches the real session record.
          sessionAgentRegistry.acquire(session.id, this.locationId);
          // A provisioned event for this session may have arrived first (the
          // automation path emits created→provisioned back-to-back). Apply it
          // now so the session reaches 'ready' without waiting for a restart.
          const pending = this._pendingProvisioned.get(session.id);
          if (pending) {
            this._pendingProvisioned.delete(session.id);
            this._applyProvisioned(session.id, pending.path);
          }
        });
      });
    });

    // A session removed by the main process out-of-band (a remote client
    // terminated a shared session, or the reconciler pruned a vanished VM
    // session). This window did not initiate the delete, so remove the row here
    // — otherwise it lingers as a ghost until restart.
    this._unsubSessionDeleted = events.on(
      sessionDeletedChannel,
      ({ sessionId }) => {
        const store = this.sessions.get(sessionId);
        if (!store) return;
        console.info('SessionManager: removing session (remote-driven delete)', {
          sessionId,
          locationId: this.locationId,
        });
        runInAction(() => this.sessions.delete(sessionId));
        this._releaseSessionRegistries(sessionId);
        store.dispose();
      }
    );

    this._unsubStatusUpdated = events.on(
      sessionStatusUpdatedChannel,
      ({ sessionId, status }) => {
        const store = this.sessions.get(sessionId);
        if (store && isProvisioned(store)) {
          runInAction(() => {
            store.data.status = status as SessionLifecycleStatus;
          });
        }
      }
    );

    this._unsubProvisionProgress = events.on(
      sessionProvisionProgressChannel,
      ({ sessionId, message }) => {
        const store = this.sessions.get(sessionId);
        if (store?.isBootstrapping) {
          runInAction(() => {
            store.provisionProgressMessage = message;
          });
        }
      }
    );

    this._unsubLifecycleScriptStatus = events.on(lifecycleScriptStatusChannel, (statusEvent) => {
      if (
        statusEvent.locationId !== this.locationId ||
        statusEvent.status !== 'failed' ||
        !statusEvent.surfaceFailure
      ) {
        return;
      }
      const { sessionId, type, message } = statusEvent;
      const sessionName = this.sessions.get(sessionId)?.data.title;
      const label = type[0].toUpperCase() + type.slice(1);
      toast.error(`${label} script failed${sessionName ? ` for ${sessionName}` : ''}`, {
        description: message,
      });
    });

    // Handles sessions provisioned by the automation path (or any main-process caller)
    // without renderer-initiated RPCs. The `isUnprovisioned` guard prevents a
    // double-transition if the renderer-driven RPC already completed first.
    this._unsubProvisioned = events.on(
      sessionProvisionedChannel,
      ({ sessionId, path }) => {
        void this._doHandleProvisioned(sessionId, path);
      }
    );
  }

  private _releaseSessionRegistries(sessionId: string): void {
    sessionAgentRegistry.release(sessionId);
  }

  loadSessions(): Promise<void> {
    if (!this._loadPromise) {
      this._loadPromise = rpc.sessions
        .getSessions(this.locationId)
        .then((sessions) => {
          runInAction(() => {
            for (const t of sessions) {
              this.sessions.set(t.id, createUnprovisionedSession(this.locationId, t));
              // Seed the agent store with the session record so sidebar badges
              // are available immediately.
              sessionAgentRegistry.acquire(t.id, this.locationId, [t]);
            }
          });
        })
        .catch((e) => {
          console.error('Error loading sessions', e);
        });
    }
    return this._loadPromise;
  }

  async createSession(params: CreateSessionParams) {
    // Register the session synchronously — before the first await — so callers
    // that navigate to the session view immediately after invoking this find it
    // in the sessions map (the view's guard redirects away otherwise).
    runInAction(() => {
      this.sessions.set(
        params.id,
        createUnregisteredSession(this.locationId, {
          id: params.id,
          lastInteractedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          title: params.title,
          status: 'in_progress',
          statusChangedAt: new Date().toISOString(),
          isPinned: false,
          subagentName: params.subagentName,
        })
      );
    });

    const agent = await rpc.agents.getAgentById(params.agentId);
    if (!agent) {
      runInAction(() => this.sessions.delete(params.id));
      throw new Error(formatCreateSessionError({ type: 'agent-not-found' }));
    }
    const providerId = agent.providerId;

    const clearOptimisticInitialWorking = () => {
      if (!params.initialPrompt?.trim()) return;
      sessionAgentRegistry.acquire(params.id, this.locationId).agent?.clearWorking();
    };

    runInAction(() => {
      // A session is its own (single) conversation in switchdash; create the
      // optimistic session record keyed by the session id.
      const now = new Date().toISOString();
      const optimistic: Session = {
        id: params.id,
        agentId: params.agentId,
        providerId: providerId as AgentProviderId,
        title: params.title,
        shellId: params.shellId ?? 'system',
        status: 'in_progress',
        statusChangedAt: now,
        agentSessionId: null,
        isInitialSession: true,
        isPinned: false,
        autoApprove: params.autoApprove ?? false,
        subagentName: params.subagentName,
        createdAt: now,
        updatedAt: now,
      };
      const agentStore = sessionAgentRegistry.acquire(params.id, this.locationId, [optimistic]);
      if (params.initialPrompt?.trim()) {
        void agentStore.markWorking();
      }
    });

    const result = await rpc.sessions
      .createSession(JSON.parse(JSON.stringify(toJS(params))) as typeof params)
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        clearOptimisticInitialWorking();
        runInAction(() => {
          const current = this.sessions.get(params.id);
          if (current && isUnregistered(current)) {
            current.phase = 'create-error';
            current.errorMessage = message;
          }
        });
        throw e;
      });

    if (!result.success) {
      const message = formatCreateSessionError(result.error);
      clearOptimisticInitialWorking();
      runInAction(() => {
        const current = this.sessions.get(params.id);
        if (current && isUnregistered(current)) {
          current.phase = 'create-error';
          current.errorMessage = message;
        }
      });
      throw new Error(message);
    }

    runInAction(() => {
      const current = this.sessions.get(params.id);
      if (current && isUnregistered(current)) {
        current.transitionToUnprovisioned(result.data.session, 'provision');
        // The session-agent registry entry was already acquired in the optimistic phase.
      }
    });

    this._settingsStore.pageData.invalidate();

    await this.provisionSession(params.id);
  }

  async provisionSession(sessionId: string): Promise<void> {
    await getLocationManagerStore().mountLocation(this.locationId);
    await this.loadSessions();

    const inFlight = this._provisionPromises.get(sessionId);
    if (inFlight) return inFlight;

    const session = this.sessions.get(sessionId);
    if (!session || !isUnprovisioned(session)) return;

    runInAction(() => {
      session.phase = 'provision';
    });

    const promise = this._doProvision(sessionId).finally(() => {
      this._provisionPromises.delete(sessionId);
    });

    this._provisionPromises.set(sessionId, promise);
    return promise;
  }

  private async _doProvision(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !isUnprovisioned(session)) return;

    // Single-phase provision: workspace bootstrap + session provider construction + registration.
    const result = await rpc.sessions.provisionWorkspace(sessionId);
    if (!result.success) {
      const message = result.error.message;
      runInAction(() => {
        const current = this.sessions.get(sessionId);
        if (current && isUnprovisioned(current)) {
          current.phase = 'provision-error';
          current.errorMessage = message;
        }
      });
      return;
    }

    sessionRuntimeRegistry.setBootstrapState(this.locationId, { kind: 'ready' });

    runInAction(() => {
      const current = this.sessions.get(sessionId);
      if (current && isUnprovisioned(current)) {
        sessionAgentRegistry.acquire(sessionId, this.locationId);
        current.ensureRegisteredStores();
        current.transitionToProvisioned(
          { ...current.data, lastInteractedAt: new Date().toISOString() },
          result.data.path
        );
        current.activate();
      }
    });
  }

  private async _doHandleProvisioned(sessionId: string, path: string): Promise<void> {
    runInAction(() => {
      const current = this.sessions.get(sessionId);
      // The session:created handler is async, so a main-process automation
      // path that emits created→provisioned can deliver provisioned first.
      // Buffer it; the created handler applies it when the session lands.
      if (!current) {
        this._pendingProvisioned.set(sessionId, { path });
        return;
      }
      this._applyProvisioned(sessionId, path);
    });
  }

  /** Transition an already-registered unprovisioned session to provisioned.
   * Must run inside a `runInAction`. */
  private _applyProvisioned(sessionId: string, path: string): void {
    const current = this.sessions.get(sessionId);
    if (current && isUnprovisioned(current)) {
      sessionAgentRegistry.acquire(sessionId, this.locationId);
      current.ensureRegisteredStores();
      current.transitionToProvisioned(
        { ...current.data, lastInteractedAt: new Date().toISOString() },
        path
      );
      current.activate();
    }
  }

  async teardownSession(sessionId: string): Promise<void> {
    const inFlight = this._teardownPromises.get(sessionId);
    if (inFlight) return inFlight;

    const session = this.sessions.get(sessionId);
    if (!session) return;

    runInAction(() => {
      const current = this.sessions.get(sessionId);
      if (!current) return;
      if (isProvisioned(current)) {
        current.transitionToUnprovisioned({ ...current.data }, 'teardown');
      } else if (isUnprovisioned(current)) {
        current.phase = 'teardown';
      }
    });

    const promise = rpc.sessions
      .teardownSession(sessionId)
      .then(() => {
        runInAction(() => {
          const current = this.sessions.get(sessionId);
          if (current && isUnprovisioned(current)) {
            current.phase = 'idle';
          }
        });
      })
      .catch((err: unknown) => {
        runInAction(() => {
          const current = this.sessions.get(sessionId);
          if (current && isUnprovisioned(current)) {
            current.phase = 'teardown-error';
          }
        });
        throw err;
      })
      .finally(() => {
        this._teardownPromises.delete(sessionId);
      });

    this._teardownPromises.set(sessionId, promise);
    return promise;
  }

  async setSessionPinned(sessionId: string, isPinned: boolean): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await session.setPinned(isPinned);
  }

  async archiveSession(sessionId: string): Promise<void> {
    const currentSession = this.sessions.get(sessionId);
    if (!currentSession || !isRegistered(currentSession)) return;
    const previousArchivedAt = currentSession.data.archivedAt;

    try {
      runInAction(() => {
        const session = this.sessions.get(sessionId);
        if (session && isRegistered(session)) {
          session.data.archivedAt = new Date().toISOString();
        }
      });
      await rpc.sessions.archiveSession(sessionId);
    } catch (e) {
      runInAction(() => {
        const session = this.sessions.get(sessionId);
        if (session && isRegistered(session)) {
          session.data.archivedAt = previousArchivedAt;
        }
      });
      throw e;
    }

    this._releaseSessionRegistries(sessionId);
    runInAction(() => {
      const session = this.sessions.get(sessionId);
      if (session && isRegistered(session)) {
        session.transitionToDryUnprovisioned({ ...session.data }, 'idle');
      }
    });
  }

  async restoreSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !isRegistered(session)) return;
    const archivedAt = session.data.archivedAt;

    try {
      await rpc.sessions.restoreSession(sessionId);
      runInAction(() => {
        const current = this.sessions.get(sessionId);
        if (current && isRegistered(current)) {
          current.data.archivedAt = undefined;
        }
      });
    } catch (e) {
      runInAction(() => {
        const current = this.sessions.get(sessionId);
        if (current && isRegistered(current)) {
          current.data.archivedAt = archivedAt;
        }
      });
      throw e;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    return this.deleteSessions([sessionId]);
  }

  async deleteSessions(sessionIds: string[]): Promise<void> {
    const removed = new Map<string, SessionStore>();

    runInAction(() => {
      for (const id of sessionIds) {
        const t = this.sessions.get(id);
        if (t) {
          removed.set(id, t);
          this.sessions.delete(id);
        }
      }
    });

    try {
      // Release the session-agent registry entry before disposing each session.
      removed.forEach((t, id) => {
        this._releaseSessionRegistries(id);
        t.dispose();
      });
      await rpc.sessions.deleteSessions(sessionIds);
    } catch (e) {
      runInAction(() => {
        removed.forEach((t, id) => this.sessions.set(id, t));
      });
      throw e;
    }
  }

  dispose(): void {
    this._unsubSessionCreated?.();
    this._unsubSessionCreated = null;
    this._unsubSessionDeleted?.();
    this._unsubSessionDeleted = null;
    this._unsubProvisionProgress?.();
    this._unsubProvisionProgress = null;
    this._unsubStatusUpdated?.();
    this._unsubStatusUpdated = null;
    this._unsubLifecycleScriptStatus?.();
    this._unsubLifecycleScriptStatus = null;
    this._unsubProvisioned?.();
    this._unsubProvisioned = null;
  }
}
