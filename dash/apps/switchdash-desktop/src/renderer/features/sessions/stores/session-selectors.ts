import { isUnmountedProject } from '@renderer/features/projects/stores/project';
import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import type { AgentStatus } from '@shared/core/providers/agentEvents';
import type { Session } from '@shared/core/sessions/sessions';
import { sessionAgentRegistry } from './session-agent-registry';
import type { SessionManagerStore } from './session-manager';
import {
  isProvisioned,
  isUnprovisioned,
  isUnregistered,
  registeredSessionData,
  type SessionStore,
} from './session-store';
import { workspaceRegistry } from './workspace-registry';
import type { WorkspaceViewModel } from './workspace-view-model';

/** Call only inside `observer` components (or other MobX reactions). */
export function getSessionManagerStore(projectId: string): SessionManagerStore | undefined {
  const p = getProjectManagerStore().projects.get(projectId);
  return p?.mountedProject?.sessionManager;
}

/** Call only inside `observer` components (or other MobX reactions). */
export function getSessionStore(projectId: string, sessionId: string): SessionStore | undefined {
  return getSessionManagerStore(projectId)?.sessions.get(sessionId);
}

/** Registered session payload (`Session`) when the row exists and is not unregistered; otherwise undefined. */
export function getRegisteredSessionData(
  projectId: string,
  sessionId: string
): Session | undefined {
  const store = getSessionStore(projectId, sessionId);
  if (!store) return undefined;
  return registeredSessionData(store);
}

/** Call only inside `observer` components (or other MobX reactions). */
export function getSessionView(
  projectId: string,
  sessionId: string
): WorkspaceViewModel | undefined {
  return getSessionStore(projectId, sessionId)?.viewModel ?? undefined;
}

export function sessionAgentStatus(store: SessionStore): AgentStatus | null {
  const agent = sessionAgentRegistry.get(store.data.id);
  return agent?.sessionStatus ?? null;
}

export type SessionViewKind =
  | 'missing'
  | 'project-mounting' // project is still opening — session data not yet available
  | 'project-error' // project failed to open
  | 'creating'
  | 'create-error'
  | 'provisioning'
  | 'provision-error'
  | 'teardown'
  | 'teardown-error'
  | 'idle'
  | 'ready';

/**
 * Derives the session view kind from the project + session store state.
 *
 * Pass `projectId` so that "project still opening" can be distinguished from
 * "session genuinely missing". Call only inside `observer` components.
 */
export function sessionViewKind(
  store: SessionStore | undefined,
  projectId: string
): SessionViewKind {
  const projectStore = getProjectManagerStore().projects.get(projectId);

  if (!projectStore) return 'missing';

  if (isUnmountedProject(projectStore)) {
    if (projectStore.phase === 'opening') return 'project-mounting';
    if (projectStore.phase === 'error') return 'project-error';
    return 'project-mounting';
  }

  if (projectStore.state === 'unregistered') return 'missing';

  if (!store) return 'missing';

  if (isUnregistered(store)) {
    if (store.phase === 'creating') return 'creating';
    return 'create-error';
  }
  if (isUnprovisioned(store)) {
    if (store.phase === 'provision') {
      return 'provisioning';
    }
    if (store.phase === 'provision-error') return 'provision-error';
    if (store.phase === 'teardown') return 'teardown';
    if (store.phase === 'teardown-error') return 'teardown-error';
    return 'idle';
  }
  return 'ready';
}

/** Returns the narrowed provisioned session store if the session is provisioned, otherwise undefined. */
export function asProvisioned(
  store: SessionStore | undefined
): (SessionStore & { state: 'provisioned'; workspaceId: string }) | undefined {
  return store && isProvisioned(store) ? store : undefined;
}

// ---------------------------------------------------------------------------
// New focused selectors (Phase 4)
// ---------------------------------------------------------------------------

export function getWorkspaceForSession(projectId: string, sessionId: string) {
  const wsId = getSessionStore(projectId, sessionId)?.workspaceId;
  return wsId ? (workspaceRegistry.get(projectId, wsId) ?? undefined) : undefined;
}

export function getWorkspaceViewModel(
  projectId: string,
  sessionId: string
): WorkspaceViewModel | undefined {
  return getSessionStore(projectId, sessionId)?.viewModel ?? undefined;
}

export function getSessionAgent(sessionId: string) {
  return sessionAgentRegistry.get(sessionId);
}

/** Returns the display name from any session store variant. */
export function sessionDisplayName(store: SessionStore | undefined): string | undefined {
  if (!store) return undefined;
  return store.data.title;
}

/** Returns the error message for error states. */
export function sessionErrorMessage(store: SessionStore | undefined): string | undefined {
  if (!store) return undefined;
  if (isUnregistered(store) && store.phase === 'create-error') {
    return store.errorMessage ?? 'Failed to create session';
  }
  if (isUnprovisioned(store)) {
    if (store.phase === 'provision-error') {
      return store.errorMessage ?? 'Failed to set up workspace';
    }
    if (store.phase === 'teardown-error') {
      return store.errorMessage ?? 'Failed to tear down session';
    }
  }
  return undefined;
}

/** Returns the mount error message for the project. */
export function projectMountErrorMessage(projectId: string): string {
  const store = getProjectManagerStore().projects.get(projectId);
  if (store && isUnmountedProject(store) && store.phase === 'error') {
    return store.error ?? 'Failed to open project';
  }
  return 'Failed to open project';
}
