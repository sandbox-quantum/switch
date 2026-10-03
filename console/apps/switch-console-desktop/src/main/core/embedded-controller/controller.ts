import type {
  EmbeddedControllerOverview,
  MachineDetailsChange,
} from '@shared/core/embedded-controller/embedded-controller';
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

  disable: (serverId: string): Promise<void> => embeddedControllerService.disable(serverId),

  restart: (serverId: string): Promise<void> => embeddedControllerService.restart(serverId),

  /** Renames this computer as a machine and/or changes its description, on the server. */
  updateDetails: (params: { serverId: string; changes: MachineDetailsChange }): Promise<void> =>
    embeddedControllerService.updateDetails(params.serverId, params.changes),

  dismissRemoved: (serverId: string): Promise<void> => embeddedControllerService.dismiss(serverId),
});
