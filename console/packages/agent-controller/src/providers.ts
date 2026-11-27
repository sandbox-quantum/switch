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

/**
 * The providers a box offers: those its image carries the CLIs for, or may.
 * Every other provider stays registered, for desktop and self-installed machines; a box
 * neither reports it nor runs an agent that names it.
 */
export const BOX_PROVIDERS: readonly string[] = [
  'claude',
  'codex',
  'opencode',
  'cursor',
  'antigravity',
];

/**
 * The providers this controller offers: every registered one, or in box mode
 * only `BOX_PROVIDERS`. A box provider that isn't registered refuses, so the
 * list can't name a provider this build has dropped.
 */
export function providersFor(
  box: boolean,
  registered: readonly string[] = PROVIDERS,
  boxProviders: readonly string[] = BOX_PROVIDERS
): readonly string[] {
  if (!box) return registered;
  const missing = boxProviders.filter((id) => !registered.includes(id));
  if (missing.length) throw new Error(`Box providers with no registration: ${missing.join(', ')}.`);
  return registered.filter((id) => boxProviders.includes(id));
}
