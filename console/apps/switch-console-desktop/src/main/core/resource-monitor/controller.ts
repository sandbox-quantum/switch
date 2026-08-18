import { ok } from '@switch-console/shared';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { sampleOnce, setResourceMonitorOpen } from './resource-sampler';

export const resourceMonitorController = createRPCController({
  /** One-shot sample of current PTY resource usage. */
  getSnapshot: async () => ok(await sampleOnce()),

  setOpen: (clientId: string, subscriptionId: string, open: boolean, sequence: number) => {
    setResourceMonitorOpen(clientId, subscriptionId, open, sequence);
    return ok();
  },
});
