import { err, ok } from '@switch-console/shared';
import { z } from 'zod';
import { isValidProviderId } from '@shared/core/providers/agent-provider-registry';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { providerUsageService } from './instance';

const providerIdSchema = z.string().refine(isValidProviderId).optional();

export const providerUsageController = createRPCController({
  getSnapshots: () => ok(providerUsageService.getSnapshots()),
  refresh: async (providerId?: string) => {
    const input = providerIdSchema.safeParse(providerId);
    if (!input.success) return err('Unknown agent provider.');
    return ok(await providerUsageService.refresh(input.data));
  },
  setActive: (active: boolean) => {
    const input = z.boolean().safeParse(active);
    if (!input.success) return err('Expected a boolean for active.');
    providerUsageService.setActive(input.data);
    return ok<void>();
  },
});
