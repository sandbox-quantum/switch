import type { IDisposable } from '@switchdash/shared';
import { getAgents } from '@main/core/agents/getAgents';
import type { IExecutionContext } from '@main/core/execution-context/types';
import type { FileSystemProvider } from '@main/core/fs/types';
import type { MachineRef } from '@main/core/runtime/types';
import { workspaceRegistry } from '@main/core/workspaces/workspace-registry';
import type { WorkspaceProviderData } from '@shared/core/workspaces/workspace-provider-data';
import type { AgentRuntimeProvider } from '../agent-runtime/types';
import { sessionRuntimeManager } from '../sessions/session-runtime-manager';
import type { WorkspaceType } from '../workspaces/workspace-factory';
import type { ProjectSettingsProvider } from './settings/provider';

export type { WorkspaceProviderData };

export type ProvisionResult = {
  agent: AgentRuntimeProvider;
  persistData: {
    workspaceId: string;
    workspaceProviderData?: WorkspaceProviderData;
    worktreeGitDir?: string;
  };
};

/**
 * Transport-specific dependencies: the only things that differ between local and SSH.
 * Pure data — no lifecycle methods.
 */
export type ProjectProviderTransport = {
  readonly kind: string;
  readonly projectMachine: MachineRef;
  readonly defaultWorkspaceType: WorkspaceType;
  readonly defaultWorkspaceMachine: MachineRef;
  readonly ctx: IExecutionContext;
  readonly fs: FileSystemProvider;
  readonly settings: ProjectSettingsProvider;
};

export class ProjectProvider implements IDisposable {
  readonly type: string;
  readonly projectId: string;
  readonly repoPath: string;
  readonly projectMachine: MachineRef;
  readonly settings: ProjectSettingsProvider;
  readonly fs: FileSystemProvider;
  /** Workspace type for standard sessions. BYOI sessions use their own remote workspace type. */
  readonly defaultWorkspaceType: WorkspaceType;
  readonly defaultWorkspaceMachine: MachineRef;

  private readonly _ctx: IExecutionContext;

  constructor(
    projectId: string,
    repoPath: string,
    transport: ProjectProviderTransport,
    private readonly _dispose: () => void
  ) {
    this.type = transport.kind;
    this.projectId = projectId;
    this.repoPath = repoPath;
    this.projectMachine = transport.projectMachine;
    this._ctx = transport.ctx;
    this.settings = transport.settings;
    this.fs = transport.fs;
    this.defaultWorkspaceType = transport.defaultWorkspaceType;
    this.defaultWorkspaceMachine = transport.defaultWorkspaceMachine;
  }

  get ctx(): IExecutionContext {
    return this._ctx;
  }

  async dispose(): Promise<void> {
    this._dispose();
    const projectSettings = await this.settings.get();
    // Detach (don't terminate) when work should outlive the app: tmux sessions,
    // and remote agents whose on-VM sidecar must keep listening to Switch while
    // switchdash is closed (CHOO-1059). Terminate only cleans up the local pane.
    const agents = await getAgents(this.projectId);
    const hasRemoteAgent = agents.some((agent) => agent.connection === 'remote');
    const mode = projectSettings.tmux || hasRemoteAgent ? 'detach' : 'terminate';
    await sessionRuntimeManager.teardownAllForProject(this.projectId, mode);
    await workspaceRegistry.releaseAllForProject(this.projectId, mode);
  }
}
