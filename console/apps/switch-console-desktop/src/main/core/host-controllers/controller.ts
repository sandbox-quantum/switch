import type { HostControllerOverview } from '@shared/core/host-controllers/host-controllers';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { hostControllerService } from './host-controllers';

/** An SSH host as a machine for a Switch server: its agents controller, and the agents moved onto it. */
export const hostControllersController = createRPCController({
  getOverview: (params: {
    sshHost: string;
    serverId: string;
    workspaceId: string | null;
  }): Promise<HostControllerOverview> =>
    hostControllerService.overview(params.sshHost, params.serverId, params.workspaceId),

  enable: (params: { sshHost: string; serverId: string; workspaceId: string }): Promise<void> =>
    hostControllerService.enable(params.sshHost, params.serverId, params.workspaceId),

  restart: (params: { sshHost: string; serverId: string }): Promise<void> =>
    hostControllerService.restart(params.sshHost, params.serverId),

  /** Enrolls the host again when the server no longer knows the machine it was. */
  enrollAgain: (params: { sshHost: string; serverId: string }): Promise<void> =>
    hostControllerService.enrollAgain(params.sshHost, params.serverId),

  disable: (params: { sshHost: string; serverId: string }): Promise<void> =>
    hostControllerService.disable(params.sshHost, params.serverId, { force: false }),
});
