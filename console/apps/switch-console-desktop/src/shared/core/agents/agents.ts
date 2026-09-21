import type { AgentProviderConfig } from '@shared/core/agents/agent-provider-config';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

/**
 * A Switch agent: an agent identity bound to a single provider, living at a
 * location (a working directory on this machine or an SSH host). Many agents
 * may share a location. `switchAgentId` / `apiEndpoint` carry the Switch
 * identity detected from the location dir's `.claude/settings.local.json`.
 * `workspaceId` is the workspace the agent belongs to; null means unlinked —
 * the workspace it was in is no longer registered in this app.
 */
export type Agent = {
  id: string;
  locationId: string;
  /** The agent's single identity. For a provider that launches as a named
   * definition (Claude Code → `--agent <name>`) this is that name; turning the
   * name into a launch is the provider's business (CHOO-1440). */
  name: string;
  providerId: AgentProviderId;
  switchAgentId: string | null;
  apiEndpoint: string | null;
  workspaceId: string | null;
  /**
   * The server hosting `workspaceId`, denormalised onto the agent: null exactly
   * when `workspaceId` is. Reaching an agent's gateway means reaching its
   * workspace's server, and this saves every caller repeating that one hop.
   */
  serverId: string | null;
  status: string | null;
  /** When true, Switch Console launches this agent's CLI with its auto-approve /
   * "bypass permissions" flag. Defaults false for local agents and true for
   * remote agents (seeded at onboarding); editable per agent. */
  autoApprove: boolean;
  /** The agent's owner on the Switch server, set when the agent was loaded from
   * another install. Null for agents this Console created. */
  ownerName: string | null;
  /** Per-agent, provider-specific launch config (e.g. Codex model / effort /
   * instructions). Null when unset. */
  providerConfig: AgentProviderConfig | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateAgentParams = {
  id: string;
  locationId: string;
  name: string;
  providerId: AgentProviderId;
  switchAgentId: string | null;
  apiEndpoint: string | null;
  /** The workspace this agent belongs to. Every agent must have one — it is
   * chosen and verified at onboarding (legacy rows may still be null until the
   * user assigns one). */
  workspaceId: string;
  /** Seed for the per-agent bypass-permissions flag: false for local agents,
   * true for remote agents. */
  autoApprove: boolean;
  /** The agent's owner on the Switch server, when loaded from another install. */
  ownerName?: string | null;
  /** Optional per-agent provider config set at creation. */
  providerConfig?: AgentProviderConfig | null;
};

export type RenameAgentParams = {
  agentId: string;
  newName: string;
};
