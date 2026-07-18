import { ok, type Result } from '@switchdash/shared';
import { eq, sql } from 'drizzle-orm';
import { getAgentById } from '@main/core/agents/getAgentById';
import { projectManager } from '@main/core/projects/project-manager';
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
  workspaceId: string;
};

export type SessionLifecycleHooks = {
  'session:created': (session: Session, params: CreateSessionParams) => void | Promise<void>;
  'session:updated': (session: Session) => void | Promise<void>;
  'session:archived': (sessionId: string, projectId: string) => void | Promise<void>;
  'session:deleted': (sessionId: string, projectId: string) => void | Promise<void>;
  'session:workspace-ready': (sessionId: string, result: ProvisionResult) => void | Promise<void>;
};

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
   * Provisions the runtime for a session: builds the conversation + terminal
   * providers in the project root and registers the session. Idempotent —
   * fast-paths when already live. Fires the `session:workspace-ready` hook and
   * emits the `session:provisioned` IPC event on success.
   */
  async provisionWorkspace(
    sessionId: string
  ): Promise<Result<ProvisionResult, TeardownSessionError>> {
    const session = await this._loadSession(sessionId);
    const project = projectManager.getProject(session.agentProjectId);
    if (!project) throw new Error(`Project not found: ${session.agentProjectId}`);

    // Idempotency: session is already live — return current state.
    if (sessionRuntimeManager.getSession(sessionId)) {
      const pd = sessionRuntimeManager.getPersistData(sessionId);
      const provisionResult: ProvisionResult = {
        path: project.repoPath,
        workspaceId: pd?.workspaceId ?? project.projectId,
      };
      this._hooks.callHookBackground('session:workspace-ready', sessionId, provisionResult);
      events.emit(sessionProvisionedChannel, {
        sessionId,
        projectId: project.projectId,
        ...provisionResult,
      });
      return ok(provisionResult);
    }

    const built = await provisionSessionRuntime(session.session, project);
    await this._registerAndPersist(sessionId, project.projectId, built);

    const provisionResult: ProvisionResult = { path: built.path, workspaceId: built.workspaceId };
    this._hooks.callHookBackground('session:workspace-ready', sessionId, provisionResult);
    events.emit(sessionProvisionedChannel, {
      sessionId,
      projectId: project.projectId,
      ...provisionResult,
    });
    return ok(provisionResult);
  }

  async launch(sessionId: string): Promise<Result<ProvisionResult, TeardownSessionError>> {
    return this.provisionWorkspace(sessionId);
  }

  private async _loadSession(
    sessionId: string
  ): Promise<{ session: Session; agentProjectId: string }> {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    const agent = await getAgentById(row.agentId);
    if (!agent) throw new Error(`Agent not found: ${row.agentId}`);
    return {
      session: mapSessionRowToSession(row, agent.providerId),
      agentProjectId: agent.projectId,
    };
  }

  private async _registerAndPersist(
    sessionId: string,
    projectId: string,
    data: SessionRuntimeResult
  ): Promise<void> {
    const project = projectManager.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    await sessionRuntimeManager.registerSession(sessionId, data, projectId, project.ctx);

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
    const session = sessionRuntimeManager.getSession(sessionId);
    if (!session) return;
    await session.agent.stop();
  }

  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    await deleteSession(projectId, sessionId);
    this._hooks.callHookBackground('session:deleted', sessionId, projectId);
  }

  async deleteSessions(projectId: string, sessionIds: string[]): Promise<void> {
    await Promise.all(sessionIds.map((id) => deleteSession(projectId, id)));
    sessionIds.forEach((id) => this._hooks.callHookBackground('session:deleted', id, projectId));
  }

  async archiveSession(projectId: string, sessionId: string): Promise<void> {
    await archiveSession(projectId, sessionId);
    this._hooks.callHookBackground('session:archived', sessionId, projectId);
  }

  async restoreSession(id: string): Promise<void> {
    const session = await restoreSession(id);
    if (session) this._hooks.callHookBackground('session:updated', session);
  }

  async renameSession(
    projectId: string,
    sessionId: string,
    newTitle: string
  ): Promise<Result<RenameSessionSuccess, RenameSessionError>> {
    const result = await renameSession(projectId, sessionId, newTitle);
    if (result.success) this._hooks.callHookBackground('session:updated', result.data.session);
    return result;
  }

  // Operations with no hook — thin pass-throughs
  updateSessionStatus = updateSessionStatus;
  setSessionPinned = setSessionPinned;
  getSessions = getSessions;
}

export const sessionService = new SessionService();
