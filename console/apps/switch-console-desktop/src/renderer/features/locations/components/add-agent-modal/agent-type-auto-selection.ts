import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

/**
 * Which agent type to pick on the user's behalf, given the types that are
 * usable on the machine being targeted and the user's configured default agent.
 * Returns null to leave the choice to them.
 *
 * Everything past the agent-type picker is gated on a chosen type, so an unset
 * picker strands the rest of the Add Agent form. Auto-selection covers the two
 * cases where the choice is not a guess:
 *
 * - exactly one usable type — there is nothing to choose;
 * - several, one of which is the user's own default — a stated preference.
 *
 * With several usable types and no default among them the answer is null: the
 * user picks, because choosing for them silently decides which agent gets
 * onboarded.
 *
 * `defaultAgentId` is undefined while the setting is still loading. That
 * deliberately reads the same as "no default among them" — the ambiguous case
 * resolves to null and is retried once the value arrives, rather than racing
 * the read and picking differently depending on how slow it was.
 *
 * The rule never looks at how many types exist beyond the one/many split, and
 * never at their order. Keying on either makes onboarding change behaviour
 * every time a connector is added.
 */
export function autoSelectedAgentType(
  selectableIds: readonly AgentProviderId[],
  defaultAgentId: string | undefined
): AgentProviderId | null {
  if (selectableIds.length === 0) return null;
  if (selectableIds.length === 1) return selectableIds[0];
  return selectableIds.find((id) => id === defaultAgentId) ?? null;
}
