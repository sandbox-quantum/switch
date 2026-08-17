import type { AddressingPolicy, AddressingRule } from '@shared/core/switch-servers/switch-servers';

/**
 * The addressing policy a newly created agent starts on, and the mapping
 * between a stored policy and the choices the UI offers for it (CHOO-2137).
 *
 * Shared rather than renderer-local because the main process reads policies
 * too — the owner-recognition probe in `gateway-client.ts` asks the same
 * question of a policy the chooser does, and one reading of `owner: true` that
 * both sides use is the point.
 */

/**
 * Whether any rule admits the agent's owner. Such a policy leans on the owner
 * having claimed a messaging identity, so it is the question both the rule
 * editor's warning and the messaging-apps warning are really asking.
 *
 * Any rule carrying `owner: true` counts, not just the shortcut shapes: a
 * hand-built rule set that names the owner depends on owner recognition
 * exactly as much as a shortcut does. `owner_agents` deliberately does not
 * count — an agent sender is recognised by its agent id, not by a claimed
 * messaging account, so a rule admitting only the owner's agents needs no
 * identity linked. A null policy is open, and an open agent answers everyone
 * regardless of who they are recognised as.
 */
export function policyNamesOwner(policy: AddressingPolicy | null): boolean {
  return policy !== null && policy.rules.some((rule) => rule.owner === true);
}

/**
 * What the "Who can send instructions" chooser offers.
 *
 * Three answers people actually want, each backed by one policy shape, and
 * `custom` — the rule editor — for everything else.
 */
export type AddressingMode = 'ownerAndAgents' | 'owner' | 'anyone' | 'custom';

/**
 * Its owner, and nobody and nothing else — not even the owner's own agents.
 * The default for a new agent: the strictest thing on offer is what an agent
 * running on someone's own machine should start on, and widening it is one
 * choice away.
 */
export function ownerOnlyPolicy(): AddressingPolicy {
  return { rules: [ownerRule(false)] };
}

/**
 * Its owner, plus any agent that owner runs — the orchestration case, where a
 * manager agent hands work to a worker and no human is in the loop.
 *
 * Both subjects are symbolic rather than lists of ids, so the rule keeps
 * working when a new workspace is connected, another agent is registered, or
 * the agent changes hands.
 */
export function ownerAndMyAgentsPolicy(): AddressingPolicy {
  return { rules: [ownerRule(true)] };
}

function ownerRule(ownerAgents: boolean): AddressingRule {
  return {
    rooms: '*',
    room_groups: '*',
    users: [],
    agents: [],
    owner: true,
    owner_agents: ownerAgents,
  };
}

/**
 * "Anyone" written as a rule, for the switch into the rule editor.
 *
 * An empty rule list is already open (both here and in switch-core, where
 * `AddressingPolicy.is_open()` allows everything), but an editor with no rules
 * in it does not show what the previous choice meant — this does.
 */
function anyoneRulePolicy(): AddressingPolicy {
  return {
    rules: [
      { rooms: '*', room_groups: '*', users: '*', agents: '*', owner: false, owner_agents: false },
    ],
  };
}

/**
 * Which choice a stored policy is. `custom` is everything the shortcuts cannot
 * express — including the owner-plus-named-agents shape earlier builds wrote,
 * which the editor shows faithfully as an `agents` list rather than flattening
 * it into a shortcut that would drop the names.
 */
export function addressingModeOf(policy: AddressingPolicy | null): AddressingMode {
  if (policy === null || policy.rules.length === 0) return 'anyone';
  if (policy.rules.length !== 1) return 'custom';
  const rule = policy.rules[0];
  if (rule.owner !== true || rule.rooms !== '*' || rule.room_groups !== '*') return 'custom';
  if (rule.users === '*' || rule.users.length > 0) return 'custom';
  if (rule.agents === '*' || rule.agents.length > 0) return 'custom';
  return rule.owner_agents === true ? 'ownerAndAgents' : 'owner';
}

/**
 * The policy a chooser change produces, seeded from the policy being left.
 *
 * Moving to `custom` carries the current policy into the editor so the rules
 * start from what the previous choice meant; moving to a shortcut replaces it,
 * since none of them can hold arbitrary rules.
 */
export function policyForMode(
  mode: AddressingMode,
  current: AddressingPolicy | null
): AddressingPolicy | null {
  if (mode === 'anyone') return null;
  if (mode === 'owner') return ownerOnlyPolicy();
  if (mode === 'ownerAndAgents') return ownerAndMyAgentsPolicy();
  if (current === null || current.rules.length === 0) return anyoneRulePolicy();
  return current;
}
