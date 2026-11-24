import { homedir } from 'node:os';
import { providerRuntime } from '@switch-console/agent-providers';
import { events } from '@main/lib/events';
import { agentProviders } from '@shared/core/providers/agent-provider-registry';
import { providerUsageUpdatedChannel } from '@shared/events/providerUsageEvents';
import { localDependencyManager } from '../dependencies/dependency-managers';
import { ProviderUsageService } from './provider-usage-service';

export const providerUsageService = new ProviderUsageService({
  targets: () =>
    agentProviders().flatMap(({ id, supportsSubscriptionUsage }) => {
      const dependency = localDependencyManager.get(id);
      if (dependency?.status !== 'available' || !dependency.path) return [];
      return [
        {
          id,
          binaryPath: dependency.path,
          read: supportsSubscriptionUsage ? providerRuntime(id).readSubscriptionUsage : undefined,
        },
      ];
    }),
  context: () => ({
    cwd: homedir(),
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    ),
  }),
  publish: (state) => events.emit(providerUsageUpdatedChannel, state),
});
