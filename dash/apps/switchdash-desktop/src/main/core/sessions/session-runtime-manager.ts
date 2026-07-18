import { ok, type Result } from '@switchdash/shared';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { killTmuxSession, makeAgentTmuxSessionName } from '@main/core/pty/tmux-session-name';
import type { SessionRuntimeResult } from '@main/core/sessions/session-builder';
import { workspaceRegistry, type TeardownMode } from '@main/core/workspaces/workspace-registry';
import { HookCore, type Hookable } from '@main/lib/hookable';
import { LifecycleMap } from '@main/lib/lifecycle-map';
import { log } from '@main/lib/logger';
import type { SessionBootstrapStatus } from '@shared/core/sessions/sessions';
import type { WorkspaceType as SharedWorkspaceType } from '@shared/core/workspaces/workspaces';
import type { ProvisionResult, SessionProvider } from '../projects/project-provider';
import { withTimeout } from '../projects/utils';
import {
  formatProvisionSessionError,
  formatTeardownSessionError,
  SESSION_TIMEOUT_MS,
  toTeardownError,
  type ProvisionSessionError,
  type TeardownSessionError,
} from './provision-session-error';

export type WorkspaceHint = {
  id: string;
  type: SharedWorkspaceType;
  path?: string;
};

type StoredSession = ProvisionResult & { projectId: string; ctx: IExecutionContext };

export type SessionManagerHooks = {
  'session:provisioned': (info: {
    projectId: string;
    sessionId: string;
    branchName: string | undefined;
    workspaceId: string;
    worktreeGitDir?: string;
  }) => void | Promise<void>;
  'session:torn-down': (info: {
    projectId: string;
    sessionId: string;
    workspaceId: string;
  }) => void | Promise<void>;
};

async function executeTeardown(
  session: SessionProvider,
  workspaceId: string,
  mode: TeardownMode
): Promise<void> {
  if (mode === 'detach') {
    await session.agent.detach();
    await session.terminals.detachAll();
  } else {
    await session.agent.destroy();
    await session.terminals.destroyAll();
  }
  await workspaceRegistry.release(workspaceId, mode);
}

async function cleanupDetachedSessions(
  _projectId: string,
  sessionId: string,
  ctx: IExecutionContext
): Promise<void> {
  // The agent pane is keyed on the shared session id, so all clients converge
  // on one tmux session.
  await killTmuxSession(ctx, makeAgentTmuxSessionName(sessionId));
}

class SessionRuntimeManager {
  private readonly _hooks = new HookCore<SessionManagerHooks>((name, e) =>
    log.error(`SessionManager: ${String(name)} hook error`, e)
  );
  private readonly _lifecycle = new LifecycleMap<
    StoredSession,
    ProvisionSessionError,
    TeardownSessionError
  >({
    postTeardown: (sessionId, stored) => {
      this._sessionsByProject.get(stored.projectId)?.delete(sessionId);
      this._hooks.callHookBackground('session:torn-down', {
        projectId: stored.projectId,
        sessionId,
        workspaceId: stored.persistData.workspaceId,
      });
    },
  });
  private readonly _sessionsByProject = new Map<string, Set<string>>();

  readonly hooks: Hookable<SessionManagerHooks> = this._hooks;

  /**
   * Registers a fully-provisioned session into the lifecycle map.
   * Idempotent — if the session is already registered, returns immediately.
   * Fires `session:provisioned` hook for git watchers and PR sync.
   */
  async registerSession(
    sessionId: string,
    result: SessionRuntimeResult,
    projectId: string,
    ctx: IExecutionContext
  ): Promise<void> {
    const stored: StoredSession = {
      sessionProvider: result.sessionProvider,
      persistData: {
        workspaceId: result.workspaceId,
        worktreeGitDir: result.worktreeGitDir,
      },
      projectId,
      ctx,
    };

    // Use provision() for deduplication: if already active, returns existing immediately.
    await this._lifecycle.provision(sessionId, async () => ok(stored));

    const byProject = this._sessionsByProject.get(projectId) ?? new Set<string>();
    byProject.add(sessionId);
    this._sessionsByProject.set(projectId, byProject);

    this._hooks.callHookBackground('session:provisioned', {
      projectId,
      sessionId,
      branchName: result.sessionProvider.sessionBranch,
      workspaceId: result.workspaceId,
      worktreeGitDir: result.worktreeGitDir,
    });
  }

  async teardownSession(
    sessionId: string,
    mode: TeardownMode = 'terminate'
  ): Promise<Result<void, TeardownSessionError>> {
    const result = this._lifecycle.teardown(
      sessionId,
      async ({ sessionProvider, persistData, projectId, ctx }) => {
        try {
          await withTimeout(
            executeTeardown(sessionProvider, persistData.workspaceId, mode),
            SESSION_TIMEOUT_MS
          );
          return ok();
        } catch (e) {
          log.error('SessionManager: failed to teardown session', { sessionId, error: String(e) });
          await cleanupDetachedSessions(projectId, sessionId, ctx).catch((cleanupError) => {
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

  async teardownAllForProject(projectId: string, mode: TeardownMode): Promise<void> {
    const sessionIds = Array.from(this._sessionsByProject.get(projectId) ?? []);
    if (mode === 'detach') {
      // Detach sessions but leave workspaces alive; provider.cleanup() will call
      // workspaceRegistry.releaseAllForProject to handle workspace teardown.
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
      // Remove entries from lifecycle maps without running workspace teardown.
      this._sessionsByProject.delete(projectId);
      await Promise.all(
        sessionIds.map(
          (id) => this._lifecycle.teardown(id, async () => ok()) ?? Promise.resolve(ok())
        )
      );
    } else {
      // teardownSession handles _sessionsByProject cleanup in onFinally.
      await Promise.all(sessionIds.map((id) => this.teardownSession(id, 'terminate')));
    }
  }

  getSession(sessionId: string): SessionProvider | undefined {
    return this._lifecycle.get(sessionId)?.sessionProvider;
  }

  getWorkspaceId(sessionId: string): string | undefined {
    return this._lifecycle.get(sessionId)?.persistData.workspaceId;
  }

  getPersistData(sessionId: string): ProvisionResult['persistData'] | undefined {
    return this._lifecycle.get(sessionId)?.persistData;
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
