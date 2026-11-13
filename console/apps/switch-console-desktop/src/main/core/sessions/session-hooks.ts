import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';

/**
 * In-process hook bus for session/agent runtime events. Distinct from the
 * renderer-bound IPC channels in `@shared/core/sessions/sessionEvents` —
 * main-process reactions must use this bus, since `events` only delivers
 * main→renderer.
 */
/**
 * Who removed a session's row: a person (removing or resetting its agent, or
 * wiping its server), or the app on its own (a pass removing an agent its
 * server no longer has). Usage data counts only the first as someone using
 * the app.
 */
export type SessionRemovedBy = 'person' | 'app';

export type SessionHookMap = {
  /** The session row was deleted outside the sessionService delete path. */
  'session:deleted': (sessionId: string, removedBy: SessionRemovedBy) => void | Promise<void>;
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
