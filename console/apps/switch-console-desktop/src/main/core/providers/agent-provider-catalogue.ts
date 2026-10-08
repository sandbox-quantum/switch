import type { ProviderRuntime } from '@switch-console/agent-providers';
import type { CLIAgentPluginMetadata } from '@switch-console/core/agents/plugins';
import type { AgentProviderDefinition } from '@shared/core/providers/agent-provider-registry';

/**
 * The provider catalogue: one entry per provider, in plugin registration order,
 * made from its plugin metadata and its runtime's login command.
 *
 * A provider registers in two places — a plugin in `packages/plugins` and a
 * runtime in `packages/agent-providers`. One with only one half is a build that
 * would list it and then fail to run it, so this throws naming the missing half.
 */
export function buildAgentProviderCatalogue(
  plugins: readonly { metadata: CLIAgentPluginMetadata }[],
  runtimes: readonly Pick<ProviderRuntime, 'id' | 'loginCommand'>[]
): AgentProviderDefinition[] {
  const pluginIds = plugins.map((plugin) => plugin.metadata.id);
  const runtimeById = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
  const missingRuntime = pluginIds.filter((id) => !runtimeById.has(id));
  const missingPlugin = [...runtimeById.keys()].filter((id) => !pluginIds.includes(id));
  if (missingRuntime.length || missingPlugin.length)
    throw new Error(
      [
        'Agent provider registration is incomplete.',
        ...(missingRuntime.length
          ? [`No runtime in agent-providers for: ${missingRuntime.join(', ')}.`]
          : []),
        ...(missingPlugin.length ? [`No plugin for: ${missingPlugin.join(', ')}.`] : []),
      ].join(' ')
    );
  return plugins.map(({ metadata }) => ({
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    docUrl: metadata.websiteUrl,
    cliLabel: metadata.cliLabel ?? metadata.name,
    loginCommand: runtimeById.get(metadata.id)!.loginCommand,
    knownAgentType: metadata.knownAgentType ?? metadata.id,
  }));
}
