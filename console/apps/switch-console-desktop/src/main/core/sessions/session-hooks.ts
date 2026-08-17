import type { ExitDecision } from '@main/core/agent-runtime/agent-runtime-supervisor';
import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

/**
 * In-process hook bus for session/agent runtime events. Distinct from the
 * renderer-bound IPC channels in `@shared/core/sessions/sessionEvents` —
 * main-process reactions must use this bus, since `events` only delivers
 * main→renderer.
 */
export type SessionHookMap = {
  /** The session row was deleted outside the sessionService delete path. */
  'session:deleted': (sessionId: string) => void | Promise<void>;
  /**
   * A remote session was deliberately terminated on another client (or this one)
   * and the sidecar broadcast a `session-terminated` event. The owning runtime
   * has already torn down its local PTY/relay; this signals the DB-level cleanup
   * (delete the row, tombstone the id, emit `session:deleted`) so the ghost
   * row does not linger and get re-attached into a blank tmux session.
   */
  'session:remote-terminated': (params: {
    locationId: string;
    sessionId: string;
    terminatedSessionId: string;
  }) => void | Promise<void>;
  /**
   * The session's agent PTY exited unexpectedly (i.e. not a deliberate stop).
   * In-process counterpart to the renderer-bound `agentSessionExitedChannel`.
   *
   * `decision` is the supervisor's verdict on the exit, and is what separates a
   * session that is about to be respawned from one that is over: only `failed`
   * means the recovery ladder is exhausted.
   */
  'session:agent-exited': (params: {
    sessionId: string;
    decision: ExitDecision['kind'];
  }) => void | Promise<void>;
  'session:input-submitted': (params: {
    sessionId: string;
    providerId: AgentProviderId;
  }) => void | Promise<void>;
};

class SessionHooks implements Hookable<SessionHookMap> {
  private readonly _core = new HookCore<SessionHookMap>((name, e) =>
    log.error(`SessionHooks: ${String(name)} hook error`, e)
  );

  on<K extends keyof SessionHookMap>(name: K, handler: SessionHookMap[K]) {
    return this._core.on(name, handler);
  }

  _emit<K extends keyof SessionHookMap>(name: K, ...args: Parameters<SessionHookMap[K]>): void {
    this._core.callHookBackground(name, ...args);
  }
}

export const sessionHooks = new SessionHooks();
