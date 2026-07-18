import type { ILifecycle } from '@switchdash/shared';
import { makeAutoObservable } from 'mobx';
import type { Session } from '@shared/core/sessions/sessions';
import { sessionAgentRegistry } from './session-agent-registry';
import type { SessionStore } from './session-store';

/**
 * A switchdash session is a single `claude` terminal. The switchdash multi-pane
 * workspace (tabs, splits, diff/editor/browser, terminal drawer) has been
 * removed — this view model only keeps the session's agent hydrated while the
 * session is provisioned, which is what connects its PTY. The terminal itself
 * is rendered by `SessionTerminal`.
 */
export class WorkspaceViewModel implements ILifecycle {
  /** Which region of the session view has focus. Kept for the terminal pane. */
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
