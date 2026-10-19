import type {
  ConnectionAgent,
  ConnectionCatalogEntry,
} from '@shared/core/switch-servers/connection-catalog';

/** Said of an agent others can address: whoever addresses it would have it act as its owner. */
export const OPEN_AGENT_NOTE = 'Others can address it; it would act as you.';

/**
 * Whether the person adds agents to `entry` from its page: a service a grant
 * simply switches on, and GitHub, whose grant names repositories chosen above
 * the agents. A minted service other than GitHub is granted from the agent's
 * Connections.
 */
export function offersAddAgent(entry: ConnectionCatalogEntry): boolean {
  return entry.pass_through || entry.slug === 'github';
}

/** What the Add agent search says an added agent gets, for a service with no choice to make. */
export function addAgentIntro(entry: ConnectionCatalogEntry): string {
  return `An agent you add acts as you at ${entry.name}, with what your connection allows.`;
}

/** The count beside the heading: how many of the person's agents use the service. */
export function agentsSummary(count: number): string {
  return `${count} ${count === 1 ? 'agent' : 'agents'}`;
}

/** The agents the search offers: those without the service, matching what was typed. */
export function addableAgents(agents: ConnectionAgent[], filter: string): ConnectionAgent[] {
  const query = filter.trim().toLowerCase();
  return agents.filter(
    (agent) => !agent.granted && (query === '' || agent.name.toLowerCase().includes(query))
  );
}

/** What the section says when the person has no agents in the workspace. */
export function noAgentsText(serviceName: string): string {
  return `You have no agents in this workspace yet. Once you add one, turn ${serviceName} on for it from the agent's Connections.`;
}

/** What stands in for the agents on a server that cannot list them. */
export function agentsUnlistedText(serviceName: string): string {
  return `This server can't list your agents here. Turn ${serviceName} on for an agent from the agent's Connections.`;
}
