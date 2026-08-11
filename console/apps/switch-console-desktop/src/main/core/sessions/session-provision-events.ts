import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';
import type { ProvisionStep } from '@shared/core/sessions/sessionEvents';

type SessionProvisionProgress = {
  sessionId: string;
  step: ProvisionStep;
  message: string;
};

export type SessionProvisionHooks = {
  progress: (progress: SessionProvisionProgress) => void | Promise<void>;
};

class SessionProvisionEvents implements Hookable<SessionProvisionHooks> {
  private readonly _core = new HookCore<SessionProvisionHooks>((name, e) =>
    log.error(`SessionProvisionEvents: ${String(name)} hook error`, e)
  );

  on<K extends keyof SessionProvisionHooks>(name: K, handler: SessionProvisionHooks[K]) {
    return this._core.on(name, handler);
  }

  emitProgress(progress: SessionProvisionProgress): void {
    this._core.callHookBackground('progress', progress);
  }
}

export const sessionProvisionEvents = new SessionProvisionEvents();
