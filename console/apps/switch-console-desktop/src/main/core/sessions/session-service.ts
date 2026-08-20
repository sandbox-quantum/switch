import { ok, type Result } from '@switch-console/shared';
import { eq, sql } from 'drizzle-orm';
import { getAgentById } from '@main/core/agents/getAgentById';
import { locationManager } from '@main/core/locations/location-manager';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';
import {
  sessionCreatedChannel,
  sessionProvisionedChannel,
} from '@shared/core/sessions/sessionEvents';
import type {
  CreateSessionError,
  CreateSessionParams,
  CreateSessionSuccess,
  RenameSessionError,
  RenameSessionSuccess,
  Session,
} from '@shared/core/sessions/sessions';
import { archiveSession } from './operations/archiveSession';
import { createSession } from './operations/createSession';
import { deleteSession } from './operations/deleteSession';
import { ensureSessionAttachable } from './operations/ensureSessionAttachable';
import { getSessions } from './operations/getSessions';
import { renameSession } from './operations/renameSession';
import { restoreSession } from './operations/restoreSession';
import { setSessionPinned } from './operations/setSessionPinned';
import { updateSessionStatus } from './operations/updateSessionStatus';
import type { TeardownSessionError } from './provision-session-error';
import { provisionSessionRuntime, type SessionRuntimeResult } from './session-builder';
import { sessionRuntimeManager } from './session-runtime-manager';
import { mapSessionRowToSession } from './utils/utils';

export type ProvisionResult = {
  path: string;
  locationId: string;
};

export type SessionLifecycleHooks = {
  'session:created': (session: Session, params: CreateSessionParams) => void | Promise<void>;
  'session:updated': (session: Session) => void | Promise<void>;
  'session:archived': (sessionId: string) => void | Promise<void>;
  'session:deleted': (sessionId: string) => void | Promise<void>;
  'session:runtime-ready': (sessionId: string, result: ProvisionResult) => void | Promise<void>;
};

/**
 * A session cannot start while its agent's location is closed. The condition is
 * a normal one — the user closed the agent — and is undone by reopening it, so
 * the message names the agent and the remedy. The location id it replaces was
 * an internal key the user could not have looked up anywhere.
 */
function notOpenMessage(agentName: string | undefined): string {
  const subject = agentName ? `The agent "${agentName}"` : 'This session’s agent';
  return `${subject} is not open, so its session cannot start. Open it from the sidebar and try again.`;
}

export class SessionService implements Hookable<SessionLifecycleHooks> {
  private readonly _hooks = new HookCore<SessionLifecycleHooks>((name, e) =>
    log.error(`SessionService: ${String(name)} hook error`, e)
  );

  on<K extends keyof SessionLifecycleHooks>(name: K, handler: SessionLifecycleHooks[K]) {
    return this._hooks.on(name, handler);
  }

  async createSession(
    params: CreateSessionParams
  ): Promise<Result<CreateSessionSuccess, CreateSessionError>> {
    const result = await createSession(params);
    if (result.success) {
      this.notifySessionCreated(result.data.session, params);
    }
    return result;
  }

  /** Fires the session:created hook and event. Call this after committing a session insert
   *  that was performed outside of `createSession` (e.g. inside an external transaction). */
  notifySessionCreated(session: Session, params: CreateSessionParams): void {
    this._hooks.callHookBackground('session:created', session, params);
    events.emit(sessionCreatedChannel, { session });
  }

  /**
   * Provisions the runtime for a session: builds the agent runtime in the
   * location root and registers the session. Idempotent — fast-paths when
   * already live. Fires the `session:runtime-ready` hook and
   * emits the `session:provisioned` IPC event on success.
   */
  /**
   * Bring a remote session's sidecar and relay up as part of provisioning.
   *
   * A remote runtime joins the attachment pool the moment it is registered, but
   * it learns which session it serves only from `ensureAttachable`. Without this
   * the pool holds a runtime that refuses every attach, so opening the session
   * shows an empty terminal for good. Local sessions have no sidecar and return
   * false. Best-effort: an unreachable host must not fail provisioning, and the
   * next attach reports the real error.
   */
  private async _makeAttachable(sessionId: string): Promise<void> {
    try {
      await ensureSessionAttachable(sessionId);
    } catch (error) {
      log.warn('SessionService: could not make session attachable', {
        sessionId,
        error: String(error),
      });
    }
  }

  async provisionSession(
    sessionId: string
  ): Promise<Result<ProvisionResult, TeardownSessionError>> {
    const session = await this._loadSession(sessionId);
    const location = locationManager.getLocation(session.agentLocationId);
    // Recoverable in one click, so say which agent and what to do rather than
    // handing the user the location's id, which appears nowhere they can act on.
    if (!location) throw new Error(notOpenMessage(session.session.agentName));

    // Idempotency: session is already live — return current state.
    if (sessionRuntimeManager.getAgent(sessionId)) {
      const provisionResult: ProvisionResult = {
        path: location.dir,
        locationId: sessionRuntimeManager.getLocationId(sessionId) ?? location.locationId,
      };
      await this._makeAttachable(sessionId);
      this._hooks.callHookBackground('session:runtime-ready', sessionId, provisionResult);
      events.emit(sessionProvisionedChannel, { sessionId, ...provisionResult });
      return ok(provisionResult);
    }

    const built = await provisionSessionRuntime(session.session, location);
    await this._registerAndPersist(sessionId, built);
    await this._makeAttachable(sessionId);

    const provisionResult: ProvisionResult = { path: built.path, locationId: built.locationId };
    this._hooks.callHookBackground('session:runtime-ready', sessionId, provisionResult);
    events.emit(sessionProvisionedChannel, { sessionId, ...provisionResult });
    return ok(provisionResult);
  }

  async launch(sessionId: string): Promise<Result<ProvisionResult, TeardownSessionError>> {
    return this.provisionSession(sessionId);
  }

  private async _loadSession(
    sessionId: string
  ): Promise<{ session: Session; agentLocationId: string }> {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    const agent = await getAgentById(row.agentId);
    if (!agent) throw new Error(`Agent not found: ${row.agentId}`);
    return {
      session: mapSessionRowToSession(row, agent.providerId, agent.name),
      agentLocationId: agent.locationId,
    };
  }

  private async _registerAndPersist(sessionId: string, data: SessionRuntimeResult): Promise<void> {
    const location = locationManager.getLocation(data.locationId);
    if (!location) throw new Error(notOpenMessage(undefined));

    await sessionRuntimeManager.registerSession(sessionId, data, location.ctx);

    await db
      .update(sessions)
      .set({ lastInteractedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(sessions.id, sessionId));
  }

  async teardown(
    sessionId: string,
    mode: Parameters<typeof sessionRuntimeManager.teardownSession>[1] = 'terminate'
  ): Promise<Result<void, TeardownSessionError>> {
    return sessionRuntimeManager.teardownSession(sessionId, mode);
  }

  /**
   * Stop a session's agent for good without deleting the session row. Routes
   * through the agent runtime so the PTY leaves respawn tracking and stays
   * stopped (a bare `pty.kill` would be respawned by the supervisor ~500ms
   * later). No-op when the session has no live runtime.
   */
  async stopAgent(sessionId: string): Promise<void> {
    const agent = sessionRuntimeManager.getAgent(sessionId);
    if (!agent) return;
    await agent.stop();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await deleteSession(sessionId);
    this._hooks.callHookBackground('session:deleted', sessionId);
  }

  async deleteSessions(sessionIds: string[]): Promise<void> {
    await Promise.all(sessionIds.map((id) => deleteSession(id)));
    sessionIds.forEach((id) => this._hooks.callHookBackground('session:deleted', id));
  }

  async archiveSession(sessionId: string): Promise<void> {
    await archiveSession(sessionId);
    this._hooks.callHookBackground('session:archived', sessionId);
  }

  async restoreSession(id: string): Promise<void> {
    const session = await restoreSession(id);
    if (session) this._hooks.callHookBackground('session:updated', session);
  }

  async renameSession(
    sessionId: string,
    newTitle: string
  ): Promise<Result<RenameSessionSuccess, RenameSessionError>> {
    const result = await renameSession(sessionId, newTitle);
    if (result.success) this._hooks.callHookBackground('session:updated', result.data.session);
    return result;
  }

  // Operations with no hook — thin pass-throughs
  updateSessionStatus = updateSessionStatus;
  setSessionPinned = setSessionPinned;
  getSessions = getSessions;
}

export const sessionService = new SessionService();
