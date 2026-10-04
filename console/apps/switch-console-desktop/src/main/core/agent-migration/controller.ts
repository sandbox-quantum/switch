import type {
  AgentMigrationState,
  MoveAllResult,
} from '@shared/core/agent-migration/agent-migration';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { agentMigrationService } from './agent-migration';

/** "Move to managed" and "Stop managing" for the agents Console runs. */
export const agentMigrationController = createRPCController({
  getState: (agentId: string): Promise<AgentMigrationState> => agentMigrationService.state(agentId),

  moveToManaged: (agentId: string): Promise<void> => agentMigrationService.moveToManaged(agentId),

  stopManaging: (agentId: string): Promise<void> => agentMigrationService.stopManaging(agentId),

  /** Cancels a move or return still waiting for a turn to end. */
  cancel: (agentId: string): Promise<void> => {
    agentMigrationService.cancel(agentId);
    return Promise.resolve();
  },

  moveAllOnThisComputer: (serverId: string): Promise<MoveAllResult> =>
    agentMigrationService.moveAll({ kind: 'this-computer', serverId }),

  stopManagingAllOnThisComputer: (serverId: string): Promise<MoveAllResult> =>
    agentMigrationService.stopManagingAll({ kind: 'this-computer', serverId }),

  /** The Console agents moved onto this computer for a server, by name. */
  movedOntoThisComputer: (serverId: string): Promise<string[]> =>
    agentMigrationService.movedOnto({ kind: 'this-computer', serverId }),
});
