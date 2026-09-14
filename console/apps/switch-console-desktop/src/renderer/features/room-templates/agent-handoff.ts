import type { AddressingPolicy } from '@shared/core/switch-servers/switch-servers';

/** What the hand-off check needs to know about one agent in the room. */
export type HandoffAgent = {
  id: string;
  name: string;
  ownerId: string | null;
  addressingPolicy: AddressingPolicy | null;
};

/** One agent that will not hear another, and why. */
export type BlockedHandoff = {
  from: string;
  to: string;
};

/**
 * Whether `target` would accept a message from `source`, by the same rules the
 * server applies to an agent sender: an open policy admits anyone, a rule
 * admits the agent by id or, with `owner_agents`, any agent of the same owner.
 */
function admitsAgent(target: HandoffAgent, source: HandoffAgent): boolean {
  const policy = target.addressingPolicy;
  if (policy === null || policy.rules.length === 0) return true;
  return policy.rules.some((rule) => {
    if (rule.agents === '*') return true;
    if (rule.agents.includes(source.id)) return true;
    return (
      rule.owner_agents === true && target.ownerId !== null && target.ownerId === source.ownerId
    );
  });
}

/**
 * The pairs of agents in a room that cannot talk to each other.
 *
 * A coder/reviewer template only works if the coder's hand-off reaches the
 * reviewer, and an agent created from the Console starts owner-only, which
 * admits its owner and nobody else. The wizard warns before the room exists
 * rather than after the hand-off bounces.
 */
export function blockedHandoffs(agents: HandoffAgent[]): BlockedHandoff[] {
  const blocked: BlockedHandoff[] = [];
  for (const source of agents) {
    for (const target of agents) {
      if (source.id === target.id) continue;
      if (!admitsAgent(target, source)) blocked.push({ from: source.name, to: target.name });
    }
  }
  return blocked;
}
