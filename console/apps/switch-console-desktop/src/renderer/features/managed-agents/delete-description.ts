import {
  cloudDeleteLoginLine,
  cloudDeletePlan,
} from '@shared/core/managed-agents/cloud-delete-plan';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { providerDisplayName } from '@shared/core/providers/agent-provider-registry';
import { managedAgentLabel } from './managed-agent-state';

const DELETE_DESCRIPTION =
  'Its machine stops it and it is deleted from Switch, for every room it is in.';

/**
 * What the delete confirm says. With hosted agents v2 on, an agent on the
 * owner's v2 box also hears what happens to its provider's login there: it goes with the
 * last agent using it, and otherwise stays for the ones named.
 */
export function deleteDescription(
  agent: ManagedAgentView,
  agents: readonly ManagedAgentView[] | null | undefined,
  /** The owner's v2 box (hosted-machines' `controller_id`); null with v2 off or no box. */
  boxControllerId: string | null
): string {
  const plan = shownPlan(agent, agents, boxControllerId);
  if (!plan) return DELETE_DESCRIPTION;
  const provider = providerDisplayName(plan.provider) ?? plan.provider;
  return `${DELETE_DESCRIPTION} ${cloudDeleteLoginLine(plan, provider)}`;
}

/**
 * Whether the confirm told the person the login goes (true) or stays (false);
 * undefined when it said nothing about a login. Passed with the delete, so a
 * box that changed since the confirm opened is asked about again.
 */
export function confirmedWithdraw(
  agent: ManagedAgentView,
  agents: readonly ManagedAgentView[] | null | undefined,
  /** The owner's v2 box (hosted-machines' `controller_id`); null with v2 off or no box. */
  boxControllerId: string | null
): boolean | undefined {
  return shownPlan(agent, agents, boxControllerId)?.withdrawLogin;
}

function shownPlan(
  agent: ManagedAgentView,
  agents: readonly ManagedAgentView[] | null | undefined,
  /** The owner's v2 box (hosted-machines' `controller_id`); null with v2 off or no box. */
  boxControllerId: string | null
) {
  // The box is the controller hosted-machines names, never a machine's kind.
  if (!boxControllerId || !agents || agent.machine?.id !== boxControllerId) return null;
  const asPlanned = (a: ManagedAgentView) => ({
    agentId: a.agentId,
    label: managedAgentLabel(a),
    controllerId: a.machine?.id ?? null,
    provider: a.definition.provider,
  });
  return cloudDeletePlan(asPlanned(agent), agents.map(asPlanned));
}
