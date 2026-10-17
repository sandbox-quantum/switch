import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import type { AgentProviderDefinition } from '@shared/core/providers/agent-provider-registry';

/**
 * Where a provider stands on this computer, as its agents controller last
 * reported it to Switch: what Switch checks before it will create an agent
 * with it, so the one answer the buddy pages go by.
 *
 * `checking`: no report on it yet — the controller is still starting, or has
 * not checked it.
 */
export type BuddyProviderState = 'ready' | 'sign-in' | 'install' | 'checking';

export type BuddyProvider = { id: string; name: string; state: BuddyProviderState };

export function buddyProviders(
  providers: readonly Pick<AgentProviderDefinition, 'id' | 'name'>[],
  machine: OwnedMachine | null
): BuddyProvider[] {
  return providers.map((provider) => {
    const reported = machine?.providers.find((entry) => entry.provider === provider.id);
    const state: BuddyProviderState = !reported
      ? 'checking'
      : reported.ready
        ? 'ready'
        : reported.problem === 'not installed'
          ? 'install'
          : reported.problem === 'login not checked yet'
            ? 'checking'
            : 'sign-in';
    return { id: provider.id, name: provider.name, state };
  });
}
