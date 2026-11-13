import type {
  ProviderSetupAuthorization,
  ProviderSetupOperation,
  ProviderSetupSnapshot,
} from '@shared/core/provider-setup/provider-setup';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { providerSetupService } from './provider-setup-service';

export const providerSetupController = createRPCController({
  get: (provider: string): ProviderSetupSnapshot => providerSetupService.get(provider),
  refresh: (provider: string): Promise<void> => providerSetupService.refresh(provider),
  run: (
    provider: string,
    operation: ProviderSetupOperation,
    authorized: ProviderSetupAuthorization
  ): Promise<void> => providerSetupService.run(provider, operation, authorized),
  stop: (provider: string): void => providerSetupService.stop(provider),
  use: (provider: string, installation: string | null): Promise<void> =>
    providerSetupService.use(provider, installation),
  useExecutable: (provider: string, path: string): Promise<void> =>
    providerSetupService.useExecutable(provider, path),
});
