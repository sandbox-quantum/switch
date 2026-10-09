import { ok } from '@switch-console/shared';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { featureFlagsService } from './feature-flags';

export const featureFlagsController = createRPCController({
  /** A server's feature flags as last read from its gateway. */
  get: (serverId: string) => ok(featureFlagsService.get(serverId)),

  /** Read every server's flags now rather than waiting for the next poll. */
  refresh: async () => {
    await featureFlagsService.refreshAll();
    return ok();
  },
});
