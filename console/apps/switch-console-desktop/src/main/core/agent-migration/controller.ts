import type {
  AgentMigrationState,
  MoveAllProgress,
  MoveAllResult,
  MoveToManagedResult,
  NewAgentMachine,
} from '@shared/core/agent-migration/agent-migration';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { agentMigrationService } from './agent-migration';
import { newManagedAgentService } from './new-managed-agent';
import type { AddManagedAgentParams, AddManagedAgentResult } from './new-managed-agent-service';

/** "Move to managed" and "Stop managing" for the agents Console runs, and new agents created managed. */
export const agentMigrationController = createRPCController({
  getState: (agentId: string): Promise<AgentMigrationState> => agentMigrationService.state(agentId),

  moveToManaged: (agentId: string): Promise<MoveToManagedResult> =>
    agentMigrationService.moveToManaged(agentId),

  stopManaging: (agentId: string): Promise<void> => agentMigrationService.stopManaging(agentId),

  /** Moves every agent of a workspace that can move, on this computer and on every SSH host. */
  moveAllInWorkspace: (scope: { serverId: string; workspaceId: string }): Promise<MoveAllResult> =>
    agentMigrationService.moveAll({ kind: 'workspace', ...scope }),

  stopManagingAllInWorkspace: (scope: {
    serverId: string;
    workspaceId: string;
  }): Promise<MoveAllResult> =>
    agentMigrationService.stopManagingAll({ kind: 'workspace', ...scope }),

  /** How far moving every agent of a workspace has got. */
  moveAllProgressInWorkspace: (scope: {
    serverId: string;
    workspaceId: string;
  }): Promise<MoveAllProgress> =>
    agentMigrationService.moveAllProgress({ kind: 'workspace', ...scope }),

  /** Whether a new agent on this machine (an SSH host, or this computer) runs as a managed agent. */
  newAgentMachine: (params: {
    serverId: string;
    workspaceId: string;
    sshHost: string | null;
  }): Promise<NewAgentMachine> => newManagedAgentService.machineFor(params),

  /** Creates a new agent as a managed agent on this computer or an SSH host. */
  addManagedAgent: (params: AddManagedAgentParams): Promise<AddManagedAgentResult> =>
    newManagedAgentService.add(params),
});
