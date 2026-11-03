import { createRPCController } from '@shared/lib/ipc/rpc';
import { userChangesService } from './user-changes';

/** The renderer's door to the change sockets (`user-changes.ts`). */
export const userChangesController = createRPCController({
  watch: async (serverId: string, workspaceId: string | null): Promise<boolean> => {
    userChangesService.watch(serverId, workspaceId);
    return userChangesService.isLive(serverId, workspaceId);
  },
  unwatch: async (serverId: string, workspaceId: string | null): Promise<void> => {
    userChangesService.unwatch(serverId, workspaceId);
  },
});
