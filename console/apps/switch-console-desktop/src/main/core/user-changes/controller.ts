import { createRPCController } from '@shared/lib/ipc/rpc';
import { userChangesService } from './user-changes';

/** The renderer's door to the change sockets (`user-changes.ts`). */
export const userChangesController = createRPCController({
  watch: async (serverId: string): Promise<boolean> => {
    userChangesService.watch(serverId);
    return userChangesService.isLive(serverId);
  },
  unwatch: async (serverId: string): Promise<void> => {
    userChangesService.unwatch(serverId);
  },
});
