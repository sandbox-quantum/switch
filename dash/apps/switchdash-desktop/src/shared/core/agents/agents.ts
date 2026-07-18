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
  switchAgentId: string | null;
  apiEndpoint: string | null;
  serverId: string | null;
  status: string | null;
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
  /** The Switch server this agent belongs to. Every agent must have one — it is
   * chosen and verified at onboarding (legacy rows may still be null until the
   * user assigns one). */
  serverId: string;
};

export type RenameAgentParams = {
  agentId: string;
  newName: string;
};
