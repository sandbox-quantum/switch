import { providerRuntimeIds } from '@switch-console/agent-providers-box';
import { pluginRegistry } from '@switch-console/plugins/agents';

/**
 * Upstream's providers the box copy leaves out: their plugins are upstream's,
 * but the box carries no runtime for them, so the box never lists them and
 * refuses an agent that names one. Any other plugin still needs its runtime.
 */
export const LEFT_OUT_PROVIDERS: readonly string[] = [
  'cline',
  'copilot',
  'deepseek-harness',
  'droid',
  'goose',
  'junie',
  'kiro',
  'mistral-vibe',
  'pi',
  'qwen',
];

/**
 * The providers both halves of a registration name: a plugin, and a runtime
 * the execution host can run. A provider with only one half is a build that
 * would report it and then fail to run it, so that refuses to start instead,
 * except for the providers `leftOut` names, whose plugins are dropped. One of
 * those with a runtime after all refuses too, so the list cannot go stale.
 */
export function registeredProviders(
  plugins: readonly string[],
  runtimes: readonly string[],
  leftOut: readonly string[] = LEFT_OUT_PROVIDERS
): readonly string[] {
  const missingRuntime = plugins.filter((id) => !runtimes.includes(id) && !leftOut.includes(id));
  const missingPlugin = runtimes.filter((id) => !plugins.includes(id));
  const notLeftOut = runtimes.filter((id) => leftOut.includes(id));
  if (missingRuntime.length || missingPlugin.length || notLeftOut.length)
    throw new Error(
      [
        'Agent provider registration is incomplete.',
        ...(missingRuntime.length
          ? [`No runtime in agent-providers for: ${missingRuntime.join(', ')}.`]
          : []),
        ...(missingPlugin.length ? [`No plugin for: ${missingPlugin.join(', ')}.`] : []),
        ...(notLeftOut.length
          ? [`Listed as left out of the box, but has a runtime: ${notLeftOut.join(', ')}.`]
          : []),
      ].join(' ')
    );
  return plugins.filter((id) => !leftOut.includes(id));
}

export const PROVIDERS: readonly string[] = registeredProviders(
  pluginRegistry.ids(),
  providerRuntimeIds()
);
