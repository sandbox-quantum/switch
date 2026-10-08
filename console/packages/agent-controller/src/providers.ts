import { providerRuntimeIds } from '@switch-console/agent-providers';
import { pluginRegistry } from '@switch-console/plugins/agents';

/**
 * The providers both halves of a registration name: a plugin, and a runtime
 * the execution host can run. A provider with only one half is a build that
 * would report it and then fail to run it, so that refuses to start instead.
 */
export function registeredProviders(
  plugins: readonly string[],
  runtimes: readonly string[]
): readonly string[] {
  const missingRuntime = plugins.filter((id) => !runtimes.includes(id));
  const missingPlugin = runtimes.filter((id) => !plugins.includes(id));
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
  return plugins;
}

export const PROVIDERS: readonly string[] = registeredProviders(
  pluginRegistry.ids(),
  providerRuntimeIds()
);
