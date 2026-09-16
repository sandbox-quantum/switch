import type { ILifecycle } from '@switch-console/shared';
import { makeAutoObservable } from 'mobx';
import type { Session } from '@shared/core/sessions/sessions';
import { sessionAgentRegistry } from './session-agent-registry';
import type { SessionStore } from './session-store';

/** Keeps the SDK session attached while its transcript is provisioned. */
export class SessionViewModel implements ILifecycle {
  /** Which region of the session view has focus.  */
  focusedRegion: 'main' | 'bottom' = 'main';

  readonly sessionId: string;

  private _active = false;

  constructor(_sessionStore: SessionStore) {
    this.sessionId = (_sessionStore.data as Session).id;
    makeAutoObservable(this);
  }

  /** Called when the session becomes provisioned. */
  initialize(): void {
    if (this._active) return;
    this._active = true;
    sessionAgentRegistry.get(this.sessionId)?.setHydrationDesired(true);
  }

  /** Called when the session becomes unprovisioned. */
  suspend(): void {
    if (!this._active) return;
    this._active = false;
    sessionAgentRegistry.get(this.sessionId)?.setHydrationDesired(false);
  }

  dispose(): void {
    this.suspend();
  }

  setFocusedRegion(region: 'main' | 'bottom'): void {
    this.focusedRegion = region;
  }
}
