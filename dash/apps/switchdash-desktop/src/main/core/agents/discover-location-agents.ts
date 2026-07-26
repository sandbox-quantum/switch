import { getLocationByHostDir } from '@main/core/locations/store';
import { getPlugin } from '@main/core/providers/plugin-registry';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { resolveWorkspaceFsFor } from './agent-workspace-fs';
import { getAgents } from './getAgents';

export type DiscoveredLocationAgent = {
  /** The definition/launch name (`.claude/agents/<name>.md` stem, `--agent <name>`). */
  name: string;
  description: string | null;
  /** Whether the definition already carries Switch credentials on disk. */
  registered: boolean;
  /** Whether the definition can join Switch (its tools allowlist keeps the
   * connector's MCP tools, or it inherits all tools). */
  eligible: boolean;
  /** Whether switchdash already has an agent row for this definition in this dir. */
  alreadyAgent: boolean;
};

/**
 * Read-only scan of a working directory for the provider's on-disk agent
 * definitions (`.claude/agents/*.md`) — used by the Add Agent modal to suggest
 * onboarding a directory's existing agents (CHOO-1440). It surfaces BOTH agents
 * already set up for Switch (carrying credentials) and plain provider subagents a
 * user created directly (no Switch setup yet), so either can be adopted as a
 * Switch agent. `alreadyAgent` marks definitions switchdash already has a row for,
 * so the modal never offers to re-add them. Works for local and remote (SSH)
 * directories. Returns an empty list for a provider with no definition concept.
 */
export async function discoverLocationAgents(params: {
  sshHost: string | null;
  dir: string;
  providerId: AgentProviderId;
}): Promise<DiscoveredLocationAgent[]> {
  const behavior = getPlugin(params.providerId).behavior.repoAgents;
  if (!behavior) return [];

  const location = await getLocationByHostDir(params.sshHost, params.dir);
  const existing = location
    ? new Set(
        (await getAgents(location.id))
          .map((a) => a.definitionName)
          .filter((n): n is string => n != null)
      )
    : new Set<string>();

  const workspace = await resolveWorkspaceFsFor(params.sshHost, params.dir);
  try {
    const definitions = await behavior.discoverDefinitions(workspace.fs);
    const local = await behavior.discoverLocal(workspace.fs, workspace.homeFs);
    const credentialled = new Set(local.filter((l) => l.switchAgentId !== null).map((l) => l.name));
    return definitions.map((def) => ({
      name: def.name,
      description: def.description,
      registered: def.registered || credentialled.has(def.name),
      eligible: def.eligible,
      alreadyAgent: existing.has(def.name),
    }));
  } finally {
    workspace.close();
  }
}
