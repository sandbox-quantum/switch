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
  machine: Pick<OwnedMachine, 'providers'> | null
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

/** How many providers Meet switch-buddy offers to start with outright; the rest are a click further. */
export const START_BUTTONS = 2;

/** The order the "Start with …" buttons go in: the most used first. */
const PREFERRED = ['claude', 'codex'];

function startOrder(providers: BuddyProvider[]): BuddyProvider[] {
  const rank = (id: string) => {
    const at = PREFERRED.indexOf(id);
    return at === -1 ? PREFERRED.length : at;
  };
  return [...providers].sort((a, b) => rank(a.id) - rank(b.id));
}

/**
 * The "Start with …" buttons, once they can be decided, or null while not.
 *
 * Decided as soon as the preferred providers (Claude Code, Codex) are known
 * and one of them is ready: their checks are quick, while the others start a
 * process of their own to answer and are rarely the ones offered. With
 * neither ready, every check is waited for, or until `outOfPatience`.
 */
export function startButtons(
  providers: BuddyProvider[],
  outOfPatience: boolean
): BuddyProvider[] | null {
  const known = (provider: BuddyProvider) => provider.state !== 'checking';
  const preferred = providers.filter((provider) => PREFERRED.includes(provider.id));
  const decided =
    outOfPatience ||
    providers.every(known) ||
    (preferred.every(known) && preferred.some((provider) => provider.state === 'ready'));
  if (!decided) return null;
  return startOrder(providers.filter((provider) => provider.state === 'ready')).slice(
    0,
    START_BUTTONS
  );
}
