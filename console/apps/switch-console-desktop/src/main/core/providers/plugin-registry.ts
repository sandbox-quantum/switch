import { PROVIDER_RUNTIMES } from '@switch-console/agent-providers';
import type {
  CLIAgentPluginMetadata,
  CLIAgentPluginProvider,
} from '@switch-console/core/agents/plugins';
import { pluginRegistry } from '@switch-console/plugins/agents';
import {
  type AgentProviderDefinition,
  setAgentProviderCatalogue,
} from '@shared/core/providers/agent-provider-registry';
import { buildAgentProviderCatalogue } from './agent-provider-catalogue';

/**
 * Built when this module loads, which `src/main/index.ts` makes the first thing
 * the main process does, so shared code can read the catalogue from then on.
 */
export const AGENT_PROVIDER_CATALOGUE: readonly AgentProviderDefinition[] =
  buildAgentProviderCatalogue(pluginRegistry.getAll(), PROVIDER_RUNTIMES);
setAgentProviderCatalogue(AGENT_PROVIDER_CATALOGUE);

export function getPlugin(id: string): CLIAgentPluginProvider {
  const plugin = pluginRegistry.get(id);
  if (!plugin) throw new Error(`No plugin found for provider: ${id}`);
  return plugin;
}

export function getPluginMetadata(id: string): CLIAgentPluginMetadata {
  const plugin = pluginRegistry.get(id);
  if (!plugin) throw new Error(`No plugin metadata found for provider: ${id}`);
  return plugin.metadata;
}

export function listPlugins(): CLIAgentPluginProvider[] {
  return pluginRegistry.getAll();
}
