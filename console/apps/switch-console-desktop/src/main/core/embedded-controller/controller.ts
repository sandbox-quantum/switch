import { agentMigrationService } from '@main/core/agent-migration/agent-migration';
import type { EmbeddedControllerOverview } from '@shared/core/embedded-controller/embedded-controller';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { embeddedControllerService } from './embedded-controllers';

/** "Run managed agents on this computer", per Switch server. */
export const embeddedControllerController = createRPCController({
  /** `workspaceId`: where to ask the server while this computer is not enrolled. */
  getOverview: (params: {
    serverId: string;
    workspaceId: string | null;
  }): Promise<EmbeddedControllerOverview> =>
    embeddedControllerService.overview(params.serverId, params.workspaceId),

  enable: (params: { serverId: string; workspaceId: string }): Promise<void> =>
    embeddedControllerService.enable(params.serverId, params.workspaceId),

  disable: async (serverId: string): Promise<void> => {
    // Switch keeps an agent on its controller after the controller is removed,
    // where nothing runs it: bring the ones this Console moved back first.
    const moved = await agentMigrationService.movedOnto({ kind: 'this-computer', serverId });
    if (moved.length)
      throw new Error(
        `This computer runs ${moved.join(', ')} for this Console. Bring them back with Stop managing (or Bring all back) before turning it off.`
      );
    await embeddedControllerService.disable(serverId);
  },

  restart: (serverId: string): Promise<void> => embeddedControllerService.restart(serverId),

  dismissRemoved: (serverId: string): Promise<void> => embeddedControllerService.dismiss(serverId),
});
