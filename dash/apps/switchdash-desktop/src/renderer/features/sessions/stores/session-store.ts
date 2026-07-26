import { err, type Result } from '@switchdash/shared';
import { makeAutoObservable, observable, runInAction } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import type {
  RenameSessionError,
  RenameSessionSuccess,
  Session,
  SessionLifecycleStatus,
} from '@shared/core/sessions/sessions';
import { sessionRuntimeRegistry } from './session-runtime-registry';
import { SessionViewModel } from './session-view-model';

export type UnregisteredSessionPhase = 'creating' | 'create-error';

export type UnprovisionedSessionPhase =
  | 'provision'
  | 'provision-error'
  | 'teardown'
  | 'teardown-error'
  | 'idle';

export type UnregisteredSessionData = {
  id: string;
  title: string;
  status: SessionLifecycleStatus;
  lastInteractedAt: string;
  createdAt: string;
  statusChangedAt: string;
  isPinned: boolean;
  /** Set when this session runs as a Claude Code subagent of its agent. */
  agentName?: string;
};

export class SessionStore {
  /** The location this session runs at (session → agent → location). */
  readonly locationId: string;
  state: 'unregistered' | 'unprovisioned' | 'provisioned';
  data: UnregisteredSessionData | Session;
  phase: UnregisteredSessionPhase | UnprovisionedSessionPhase | null;
  errorMessage: string | undefined = undefined;
  provisionProgressMessage: string | null = null;

  /** Whether this session currently holds an acquired location runtime. */
  private _acquired = false;
  /**
   * Stable view model — created when session first becomes registered, persists
   * across provision/unprovision cycles. Null only while session is unregistered.
   */
  viewModel: SessionViewModel | null = null;

  get displayName(): string {
    return this.data.title;
  }

  /** True only while creation/provisioning is actively running — error phases are settled, not busy. */
  get isBootstrapping(): boolean {
    return (
      (this.state === 'unregistered' && this.phase === 'creating') ||
      (this.state === 'unprovisioned' && this.phase === 'provision')
    );
  }

  constructor(
    locationId: string,
    data: UnregisteredSessionData | Session,
    state: SessionStore['state'],
    phase: UnregisteredSessionPhase | UnprovisionedSessionPhase | null = null
  ) {
    this.locationId = locationId;
    this.state = state;
    this.data = data;
    this.phase = phase;
    makeAutoObservable(this, {
      viewModel: observable.ref,
      /** Deep observable so nested fields (e.g. `status`) notify observers (e.g. sidebar). */
      data: observable,
    });

    // Create stable session-lifetime stores immediately for registered sessions.
    if (state !== 'unregistered') {
      this.ensureRegisteredStores();
    }
  }

  ensureRegisteredStores(): void {
    if (this.state === 'unregistered') return;
    if (!this.viewModel) {
      this.viewModel = new SessionViewModel(this);
    }
  }

  transitionToProvisioned(data: Session, path: string): void {
    this.data = data;
    this.ensureRegisteredStores();
    sessionRuntimeRegistry.acquire(this.locationId, path);
    this._acquired = true;
    this.state = 'provisioned';
    this.phase = null;
    this.errorMessage = undefined;
    this.provisionProgressMessage = null;
    this.viewModel?.initialize();
  }

  transitionToUnprovisioned(data: Session, phase: UnprovisionedSessionPhase = 'idle'): void {
    this.viewModel?.suspend();
    if (this._acquired) {
      sessionRuntimeRegistry.release(this.locationId);
      this._acquired = false;
    }
    this.data = data;
    this.state = 'unprovisioned';
    this.phase = phase;
    this.errorMessage = undefined;
    this.provisionProgressMessage = null;

    // Create stable stores on first registration (when transitioning from unregistered).
    if (!this.viewModel) this.ensureRegisteredStores();
  }

  transitionToDryUnprovisioned(data: Session, phase: UnprovisionedSessionPhase = 'idle'): void {
    this.dispose();
    this.data = data;
    this.state = 'unprovisioned';
    this.phase = phase;
    this.errorMessage = undefined;
    this.provisionProgressMessage = null;
  }

  transitionToUnregistered(data: UnregisteredSessionData): void {
    this.viewModel?.suspend();
    if (this._acquired) {
      sessionRuntimeRegistry.release(this.locationId);
      this._acquired = false;
    }
    this.data = data;
    this.state = 'unregistered';
    this.phase = 'creating';
    this.errorMessage = undefined;
  }

  activate(): void {
    if (this._acquired) {
      sessionRuntimeRegistry.activate(this.locationId);
    }
  }

  dispose(): void {
    this.viewModel?.dispose();
    this.viewModel = null;
    if (this._acquired) {
      sessionRuntimeRegistry.release(this.locationId);
      this._acquired = false;
    }
  }

  /** The provider of this session's agent, for the sidebar row logo. */
  get agentProviderId(): string | null {
    if (!isRegistered(this)) return null;
    return this.data.providerId ?? null;
  }

  async rename(name: string): Promise<Result<RenameSessionSuccess, RenameSessionError>> {
    const session = registeredSessionData(this);
    if (!session) return err({ type: 'session-not-found', sessionId: this.data.id });
    try {
      const result = await rpc.sessions.renameSession(session.id, name);
      if (!result.success) {
        return result;
      }
      runInAction(() => {
        const current = registeredSessionData(this);
        if (current) {
          current.title = name;
        }
      });
      return result;
    } catch (e) {
      log.error(e);
      throw e;
    }
  }

  async updateStatus(status: SessionLifecycleStatus): Promise<void> {
    const previousStatus = this.data.status;
    const previousStatusChangedAt = this.data.statusChangedAt;
    const nextChangedAt = new Date().toISOString();
    runInAction(() => {
      this.data.status = status;
      this.data.statusChangedAt = nextChangedAt;
    });
    try {
      await rpc.sessions.updateSessionStatus(this.data.id, status);
    } catch (e) {
      runInAction(() => {
        this.data.status = previousStatus;
        this.data.statusChangedAt = previousStatusChangedAt;
      });
      log.error(e);
      throw e;
    }
  }

  async setPinned(isPinned: boolean): Promise<void> {
    if (this.state === 'unregistered') return;
    const session = registeredSessionData(this);
    if (!session) return;
    const previous = session.isPinned;
    runInAction(() => {
      session.isPinned = isPinned;
    });
    try {
      await rpc.sessions.setSessionPinned(session.id, isPinned);
    } catch (e) {
      runInAction(() => {
        session.isPinned = previous;
      });
      log.error(e);
      throw e;
    }
  }
}

export type UnregisteredSession = SessionStore & {
  state: 'unregistered';
  data: UnregisteredSessionData;
  phase: UnregisteredSessionPhase;
  errorMessage: string | undefined;
};

export type UnprovisionedSession = SessionStore & {
  state: 'unprovisioned';
  data: Session;
  phase: UnprovisionedSessionPhase;
  errorMessage: string | undefined;
};

export function isUnregistered(t: SessionStore): t is UnregisteredSession {
  return t.state === 'unregistered';
}

export function isRegistered(
  t: SessionStore
): t is SessionStore & { state: 'unprovisioned' | 'provisioned'; data: Session } {
  return t.state !== 'unregistered';
}

export function isUnprovisioned(t: SessionStore): t is UnprovisionedSession {
  return t.state === 'unprovisioned';
}

export function isProvisioned(
  t: SessionStore
): t is SessionStore & { state: 'provisioned'; data: Session; locationId: string } {
  return t.state === 'provisioned';
}

/** Full `Session` payload when registered (unprovisioned or provisioned); `undefined` when unregistered. */
export function registeredSessionData(store: SessionStore): Session | undefined {
  return isRegistered(store) ? store.data : undefined;
}

export function unregisteredSessionData(store: SessionStore): UnregisteredSessionData | undefined {
  return isUnregistered(store) ? store.data : undefined;
}

export function createUnregisteredSession(
  locationId: string,
  data: UnregisteredSessionData
): SessionStore {
  return new SessionStore(locationId, data, 'unregistered', 'creating');
}

export function createUnprovisionedSession(locationId: string, data: Session): SessionStore {
  return new SessionStore(locationId, data, 'unprovisioned', 'idle');
}
