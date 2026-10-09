import { err, ok } from '@switch-console/shared';
import { getServer } from '@main/core/switch-servers/servers-store';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { featureFlagsService } from './feature-flags';

export const featureFlagsController = createRPCController({
  /** A server's feature flags as last read from its gateway. */
  get: (serverId: string) => ok(featureFlagsService.get(serverId)),

  /** A server's feature flags, read now if they never have been. */
  current: async (serverId: string) => {
    const server = await getServer(serverId);
    if (!server) return err(`No Switch server ${serverId}`);
    return ok(await featureFlagsService.current(server));
  },
  /** Read every server's flags now rather than waiting for the next poll. */
  refresh: async () => {
    await featureFlagsService.refreshAll();
    return ok();
  },
});
