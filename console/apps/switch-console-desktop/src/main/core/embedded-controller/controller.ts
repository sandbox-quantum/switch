import { homedir } from 'node:os';
import { getServer } from '@main/core/switch-servers/servers-store';
import type {
  EmbeddedControllerOverview,
  MachineDetailsChange,
} from '@shared/core/embedded-controller/embedded-controller';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { defaultWorkspacePath, serverWorkspacesDir } from './controller-files';
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

  /** Enrolls this computer again when the server no longer knows the machine it was. */
  enrollAgain: (serverId: string): Promise<void> => embeddedControllerService.enrollAgain(serverId),

  /**
   * Where this computer's controller puts a managed agent that names no
   * directory, `~` for the home directory; null for a name that cannot be a
   * directory, which the form refuses anyway.
   */
  defaultWorkspace: async (params: { serverId: string; name: string }): Promise<string | null> => {
    const server = await getServer(params.serverId);
    if (!server) throw new Error(`No server ${params.serverId} in Console.`);
    const path = defaultWorkspacePath(serverWorkspacesDir(homedir(), server.url), params.name);
    if (path === null) return null;
    const home = homedir();
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  },
});
