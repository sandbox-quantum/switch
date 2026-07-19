import { getAgentById } from '@main/core/agents/getAgentById';
import { resolveAgentWorkspace } from '@main/core/workspaces/resolve-agent-workspace';
import type { Workspace } from '@main/core/workspaces/workspace';
import { workspaceRegistry } from '@main/core/workspaces/workspace-registry';
import { events } from '@main/lib/events';
import {
  sessionProvisionProgressChannel,
  type ProvisionStep,
} from '@shared/core/sessions/sessionEvents';
import type { Session } from '@shared/core/sessions/sessions';
import type { ProjectProvider, SessionProvider } from '../projects/project-provider';
import type { ProjectSettingsProvider } from '../projects/settings/provider';
import {
  buildSessionProviders,
  createWorkspaceFactory,
  resolveSessionEnv,
  type WorkspaceType,
} from '../workspaces/workspace-factory';
import { sessionProvisionEvents } from './session-provision-events';

/**
 * The runtime artefacts of a provisioned session. In switchdash every session
 * runs in the project root directory; the "workspace" is keyed per project dir
 * (decision B) and shared by all of that project's sessions.
 */
export type SessionRuntimeResult = {
  path: string;
  workspaceId: string;
  worktreeGitDir?: string;
  sessionProvider: SessionProvider;
};

/**
 * Provisions the runtime for a session: acquires the project-dir workspace
 * (running lifecycle scripts once per project dir) and builds the session's
 * agent runtime + terminal providers in the project root.
 */
export async function provisionSessionRuntime(
  session: Session,
  project: ProjectProvider
): Promise<SessionRuntimeResult> {
  // The transport is the agent's, not the project's: a remote agent runs its
  // sessions on its SSH host even though the project lives locally.
  const agent = await getAgentById(session.agentId);
  if (!agent) {
    throw new Error(
      `provisionSessionRuntime: agent ${session.agentId} not found for session ${session.id}`
    );
  }
  const { type, workspaceId, workDir } = resolveAgentWorkspace(agent, {
    projectId: project.projectId,
    repoPath: project.repoPath,
  });

  emitSessionProvisionProgress({
    sessionId: session.id,
    projectId: project.projectId,
    step: 'initialising-workspace',
    message: 'Initialising workspace…',
  });

  const workspace = await workspaceRegistry.acquire(
    workspaceId,
    project.projectId,
    createWorkspaceFactory(workspaceId, type, {
      session,
      workDir,
      projectId: project.projectId,
      projectPath: project.repoPath,
      settings: project.settings,
      logPrefix: 'provisionSessionRuntime',
    })
  );

  emitSessionProvisionProgress({
    sessionId: session.id,
    projectId: project.projectId,
    step: 'starting-sessions',
    message: 'Preparing session…',
  });

  let buildSucceeded = false;
  try {
    const sessionProvider = await buildSessionFromWorkspace(
      session,
      workspace,
      type,
      project.projectId,
      project.repoPath,
      project.settings
    );
    buildSucceeded = true;
    return {
      path: workDir,
      workspaceId,
      worktreeGitDir: undefined,
      sessionProvider,
    };
  } finally {
    if (!buildSucceeded) {
      await workspaceRegistry.release(workspaceId, 'terminate').catch(() => {});
    }
  }
}

export function emitSessionProvisionProgress(data: {
  sessionId: string;
  projectId: string;
  step: ProvisionStep;
  message: string;
}): void {
  events.emit(sessionProvisionProgressChannel, data);
  sessionProvisionEvents.emitProgress(data);
}

/**
 * Shared tail of the provision flow — builds a SessionProvider from an already-acquired
 * workspace. Works for both local and SSH transports.
 */
export async function buildSessionFromWorkspace(
  session: Session,
  workspace: Workspace,
  type: WorkspaceType,
  projectId: string,
  projectPath: string,
  settings: ProjectSettingsProvider
): Promise<SessionProvider> {
  const { sessionEnvVars, tmuxEnabled, shellSetup } = await resolveSessionEnv(
    session,
    workspace,
    projectPath,
    settings
  );

  const { agent, terminals } = await buildSessionProviders(type, {
    projectId,
    sessionId: session.id,
    workspaceId: workspace.id,
    sessionPath: workspace.path,
    tmuxEnabled,
    shellSetup,
    sessionEnvVars,
  });

  return {
    sessionId: session.id,
    sessionBranch: undefined,
    sessionEnvVars,
    agent,
    terminals,
  };
}
