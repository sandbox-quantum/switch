import type { ProviderCustomConfig } from '@shared/core/app-settings';
import { agentProviderIds } from '@shared/core/providers/agent-provider-registry';
import { OverrideSettings } from './override-settings';
import {
  migrateProviderConfigOverrides,
  migrateProviderConfigToHostDependencyStore,
} from './provider-config-migrations';
import { providerCustomConfigEntrySchema } from './schema';

/**
 * Every registered provider starts from empty defaults, so its saved settings
 * are readable and reset has something to write. An id the catalogue does not
 * know has none, and the store reports it as absent. Read on each call, never
 * at import: the catalogue is installed as the main process loads its plugins.
 */
const providerDefaults = (): Record<string, ProviderCustomConfig> =>
  Object.fromEntries(agentProviderIds().map((id) => [id, {}]));

export const providerOverrideSettings = new OverrideSettings<ProviderCustomConfig>(
  'providerConfigs',
  providerDefaults,
  providerCustomConfigEntrySchema,
  migrateProviderConfigOverrides
);

/**
 * Run at app startup: migrates legacy cli/path/installSource fields from provider
 * config overrides to the host-dependency store, then invalidates the cache so the
 * next read sees the stripped config.
 */
export async function runProviderSettingsMigration(): Promise<void> {
  const { hostDependencyStore } = await import('../dependencies/host-dependency-store');
  const raw = await providerOverrideSettings.getRawOverrides();
  await migrateProviderConfigToHostDependencyStore(raw, hostDependencyStore);
  providerOverrideSettings.invalidateCache();
}
