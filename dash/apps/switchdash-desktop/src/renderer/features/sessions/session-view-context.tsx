import { observer } from 'mobx-react-lite';
import { createContext, useContext, type ReactNode } from 'react';
import { ProjectViewWrapper } from '@renderer/features/projects/components/project-view-wrapper';
import type { SessionAgentStore } from '@renderer/features/sessions/stores/session-agent-store';
import {
  getSessionAgent,
  getSessionStore,
  getWorkspaceForSession,
  sessionViewKind,
  type SessionViewKind,
} from '@renderer/features/sessions/stores/session-selectors';
import type { WorkspaceStore } from '@renderer/features/sessions/stores/workspace';
import type { WorkspaceViewModel } from '@renderer/features/sessions/stores/workspace-view-model';

interface SessionViewContext {
  projectId: string;
  sessionId: string;
  /** The workspace ID for this session, or null when not yet registered. */
  workspaceId: string | null;
}

const SessionViewContext = createContext<SessionViewContext | null>(null);

export const SessionViewWrapper = observer(function SessionViewWrapper({
  children,
  projectId,
  sessionId,
}: {
  children: ReactNode;
  projectId: string;
  sessionId: string;
}) {
  const workspaceId = getSessionStore(projectId, sessionId)?.workspaceId ?? null;
  return (
    <ProjectViewWrapper projectId={projectId}>
      <SessionViewContext.Provider value={{ projectId, sessionId, workspaceId }}>
        {children}
      </SessionViewContext.Provider>
    </ProjectViewWrapper>
  );
});

export function useSessionViewContext(): SessionViewContext {
  const context = useContext(SessionViewContext);
  if (!context) {
    throw new Error('useSessionViewContext must be used within a SessionViewContextProvider');
  }
  return context;
}

export function useSessionViewKind(): SessionViewKind {
  const { projectId, sessionId } = useSessionViewContext();
  return sessionViewKind(getSessionStore(projectId, sessionId), projectId);
}

/** Returns the active WorkspaceStore. Throws if the session is not provisioned. */
export function useWorkspace(): WorkspaceStore {
  const { projectId, sessionId } = useSessionViewContext();
  const workspace = getWorkspaceForSession(projectId, sessionId);
  if (!workspace) {
    throw new Error('useWorkspace: session is not provisioned (no workspace)');
  }
  return workspace;
}

/** Returns the workspace ID. Throws if the session has no workspace yet. */
export function useWorkspaceId(): string {
  const { workspaceId } = useSessionViewContext();
  if (!workspaceId) throw new Error('useWorkspaceId: session has no workspace');
  return workspaceId;
}

/** Returns the WorkspaceViewModel. Throws if the session is not registered. */
export function useWorkspaceViewModel(): WorkspaceViewModel {
  const { projectId, sessionId } = useSessionViewContext();
  const viewModel = getSessionStore(projectId, sessionId)?.viewModel;
  if (!viewModel) {
    throw new Error('useWorkspaceViewModel: session is not registered (no view model)');
  }
  return viewModel;
}

/** Returns the SessionAgentStore for the session. Throws if not registered. */
export function useSessionAgent(): SessionAgentStore {
  const { sessionId } = useSessionViewContext();
  const store = getSessionAgent(sessionId);
  if (!store) {
    throw new Error('useSessionAgent: session is not registered (no session-agent store)');
  }
  return store;
}
