import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

/**
 * A Switch agent: an agent identity bound to a single provider, living at a
 * location (a working directory on this machine or an SSH host). Many agents
 * may share a location. `switchAgentId` / `apiEndpoint` carry the Switch
 * identity detected from the location dir's `.claude/settings.local.json`.
 * `serverId` is the registered Switch server the agent belongs to (resolved
 * from `apiEndpoint`); null means unlinked — the server it points at is not
 * registered in this app.
 */
export type Agent = {
  id: string;
  locationId: string;
  name: string;
  providerId: AgentProviderId;
  /** The provider-level definition this agent launches as (e.g. a Claude Code
   * subagent — the `.claude/agents/<name>.md` stem, passed as `--agent <name>`),
   * or null for a plain agent with no definition. */
  definitionName: string | null;
  switchAgentId: string | null;
  apiEndpoint: string | null;
  serverId: string | null;
  status: string | null;
  /** When true, switchdash launches this agent's CLI with its auto-approve /
   * "bypass permissions" flag. Defaults false for local agents and true for
   * remote agents (seeded at onboarding); editable per agent. */
  autoApprove: boolean;
  createdAt: string;
  updatedAt: string;
};

/** True for an agent that launches as a provider definition (a former subagent). */
export function isDefinitionAgent(agent: Pick<Agent, 'definitionName'>): boolean {
  return agent.definitionName != null;
}

/**
 * The agent that represents a location in single-agent UI surfaces (the sidebar
 * location row, a location's settings target): the first non-definition ("real")
 * agent, falling back to the first agent. Keeps a former subagent's agent row
 * from being mistaken for the location's primary agent (CHOO-1440).
 */
export function representativeAgent<T extends Pick<Agent, 'definitionName'>>(
  agents: readonly T[]
): T | undefined {
  return agents.find((a) => a.definitionName == null) ?? agents[0];
}

export type CreateAgentParams = {
  id: string;
  locationId: string;
  name: string;
  providerId: AgentProviderId;
  /** The provider-level definition to launch as (`--agent <name>`), or null for
   * a plain agent. */
  definitionName?: string | null;
  switchAgentId: string | null;
  apiEndpoint: string | null;
  /** The Switch server this agent belongs to. Every agent must have one — it is
   * chosen and verified at onboarding (legacy rows may still be null until the
   * user assigns one). */
  serverId: string;
  /** Seed for the per-agent bypass-permissions flag: false for local agents,
   * true for remote agents. */
  autoApprove: boolean;
};

export type RenameAgentParams = {
  agentId: string;
  newName: string;
};
