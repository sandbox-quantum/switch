import { buddyAgentName, findBuddy } from '@switch-console/chat-ui/model/buddy';
import type { FeatureFlags } from '@shared/core/feature-flags/feature-flags';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';

export {
  BUDDY_KEY,
  BUDDY_TEMPLATE_ID,
  buddyAgentName,
  findBuddy,
  isBuddy,
} from '@switch-console/chat-ui/model/buddy';

/**
 * Whether a server offers switch-buddy: it is made from a template the server
 * serves behind its `switch_buddy` flag, and runs as a managed agent, so
 * agent management must be on too.
 */
export function buddyOffered(
  flags: Pick<FeatureFlags, 'switch_buddy' | 'agent_management'>
): boolean {
  return flags.switch_buddy && flags.agent_management;
}

/**
 * Whether the server offers switch-buddy and the person has none yet: it is
 * waiting on an AI provider. Not while their agents are still unknown, so a
 * buddy that exists is never drawn as missing.
 */
export function buddyIsPending({
  onboardingBuilt,
  serverId,
  flags,
  agents,
}: {
  onboardingBuilt: boolean;
  serverId: string | null;
  flags: Pick<FeatureFlags, 'switch_buddy' | 'agent_management'>;
  agents: Pick<ManagedAgentView, 'name'>[] | null | undefined;
}): boolean {
  return (
    onboardingBuilt &&
    serverId !== null &&
    buddyOffered(flags) &&
    Array.isArray(agents) &&
    findBuddy(agents) === null
  );
}

/** The first name to greet someone by: the first word of their name. */
export function firstNameOf(name: string | null | undefined): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}

/**
 * The name the person's buddy will have, for showing it before it exists: the
 * one it is created under unless someone else in the workspace holds it, when
 * a number is added then.
 */
export function expectedBuddyName(
  user: { name: string | null; email: string | null } | null
): string {
  return buddyAgentName({ name: user?.name ?? null, email: user?.email ?? null }, new Set());
}
