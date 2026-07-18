import { ok, type Result } from '@switchdash/shared';
import type { IExecutionContext } from '@main/core/execution-context/types';
import {
  locationRuntimeRegistry,
  type TeardownMode,
} from '@main/core/locations/location-runtime-registry';
import { killTmuxSession, makeAgentTmuxSessionName } from '@main/core/pty/tmux-session-name';
import type { SessionRuntimeResult } from '@main/core/sessions/session-builder';
import { LifecycleMap } from '@main/lib/lifecycle-map';
import { log } from '@main/lib/logger';
import type { SessionBootstrapStatus } from '@shared/core/sessions/sessions';
import type { SessionProvider } from '../locations/location-provider';
import { withTimeout } from '../locations/utils';
import {
  formatProvisionSessionError,
  formatTeardownSessionError,
  SESSION_TIMEOUT_MS,
  toTeardownError,
  type ProvisionSessionError,
  type TeardownSessionError,
} from './provision-session-error';

type StoredSession = {
  sessionProvider: SessionProvider;
  locationId: string;
  ctx: IExecutionContext;
};

async function executeTeardown(
  session: SessionProvider,
  locationId: string,
  mode: TeardownMode
): Promise<void> {
  if (mode === 'detach') {
    await session.agent.detach();
    await session.terminals.detachAll();
  } else {
    await session.agent.destroy();
    await session.terminals.destroyAll();
  }
  await locationRuntimeRegistry.release(locationId, mode);
}

async function cleanupDetachedSessions(sessionId: string, ctx: IExecutionContext): Promise<void> {
  // The agent pane is keyed on the shared session id, so all clients converge
  // on one tmux session.
  await killTmuxSession(ctx, makeAgentTmuxSessionName(sessionId));
}

class SessionRuntimeManager {
  private readonly _lifecycle = new LifecycleMap<
    StoredSession,
    ProvisionSessionError,
    TeardownSessionError
  >({
    postTeardown: (sessionId, stored) => {
      this._sessionsByLocation.get(stored.locationId)?.delete(sessionId);
    },
  });
  private readonly _sessionsByLocation = new Map<string, Set<string>>();

  /**
   * Registers a fully-provisioned session into the lifecycle map.
   * Idempotent — if the session is already registered, returns immediately.
   */
  async registerSession(
    sessionId: string,
    result: SessionRuntimeResult,
    ctx: IExecutionContext
  ): Promise<void> {
    const stored: StoredSession = {
      sessionProvider: result.sessionProvider,
      locationId: result.locationId,
      ctx,
    };

    // Use provision() for deduplication: if already active, returns existing immediately.
    await this._lifecycle.provision(sessionId, async () => ok(stored));

    const byLocation = this._sessionsByLocation.get(result.locationId) ?? new Set<string>();
    byLocation.add(sessionId);
    this._sessionsByLocation.set(result.locationId, byLocation);
  }

  async teardownSession(
    sessionId: string,
    mode: TeardownMode = 'terminate'
  ): Promise<Result<void, TeardownSessionError>> {
    const result = this._lifecycle.teardown(
      sessionId,
      async ({ sessionProvider, locationId, ctx }) => {
        try {
          await withTimeout(executeTeardown(sessionProvider, locationId, mode), SESSION_TIMEOUT_MS);
          return ok();
        } catch (e) {
          log.error('SessionManager: failed to teardown session', { sessionId, error: String(e) });
          await cleanupDetachedSessions(sessionId, ctx).catch((cleanupError) => {
            log.warn('SessionManager: fallback cleanup failed', {
              sessionId,
              error: String(cleanupError),
            });
          });
          return { success: false as const, error: toTeardownError(e) };
        }
      }
    );

    return result ?? ok();
  }

  async teardownAllForLocation(locationId: string, mode: TeardownMode): Promise<void> {
    const sessionIds = Array.from(this._sessionsByLocation.get(locationId) ?? []);
    if (mode === 'detach') {
      // Detach sessions but leave the location runtime alive; the provider's
      // dispose() releases it via locationRuntimeRegistry.releaseAll.
      await Promise.all(
        sessionIds.flatMap((id) => {
          const stored = this._lifecycle.get(id);
          if (!stored) return [];
          return [
            stored.sessionProvider.agent.detach(),
            stored.sessionProvider.terminals.detachAll(),
          ];
        })
      );
      // Remove entries from lifecycle maps without running runtime teardown.
      this._sessionsByLocation.delete(locationId);
      await Promise.all(
        sessionIds.map(
          (id) => this._lifecycle.teardown(id, async () => ok()) ?? Promise.resolve(ok())
        )
      );
    } else {
      // teardownSession handles _sessionsByLocation cleanup in postTeardown.
      await Promise.all(sessionIds.map((id) => this.teardownSession(id, 'terminate')));
    }
  }

  getSession(sessionId: string): SessionProvider | undefined {
    return this._lifecycle.get(sessionId)?.sessionProvider;
  }

  getLocationId(sessionId: string): string | undefined {
    return this._lifecycle.get(sessionId)?.locationId;
  }

  getBootstrapStatus(sessionId: string): SessionBootstrapStatus {
    const s = this._lifecycle.bootstrapStatus(sessionId);
    if (s.status === 'error')
      return { status: 'error', message: formatProvisionSessionError(s.error) };
    return s;
  }

  getTeardownStatus(sessionId: string): SessionBootstrapStatus {
    const s = this._lifecycle.teardownStatus(sessionId);
    if (s.status === 'error')
      return { status: 'error', message: formatTeardownSessionError(s.error) };
    return s;
  }
}

export const sessionRuntimeManager = new SessionRuntimeManager();
