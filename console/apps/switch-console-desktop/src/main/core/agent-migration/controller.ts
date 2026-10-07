import type {
  AgentRunner,
  MigrationProblem,
  NewAgentMachine,
} from '@shared/core/agent-migration/agent-migration';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { agentMigrationService } from './agent-migration';
import { newManagedAgentService } from './new-managed-agent';
import type { AddManagedAgentParams, AddManagedAgentResult } from './new-managed-agent-service';

/** The automatic move of the agents Console runs onto controllers, and new agents created managed. */
export const agentMigrationController = createRPCController({
  /** Who runs the agent: this Console, or a controller it was moved onto. */
  getRunner: (agentId: string): Promise<AgentRunner> => agentMigrationService.runner(agentId),

  /** Why the agents the automatic move could not move did not. */
  getProblems: (): MigrationProblem[] => agentMigrationService.migrationProblems(),

  /** Runs the automatic move again now, asking Switch afresh about the agent. */
  retry: (agentId: string): Promise<void> => {
    agentMigrationService.recheck(agentId);
    return agentMigrationService.migrateEverything();
  },

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
