import { getPlugin } from '@main/core/providers/plugin-registry';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { resolveWorkspaceFsFor } from './agent-workspace-fs';

export type DiscoveredLocationAgent = {
  /** The definition/launch name (`.claude/agents/<name>.md` stem, `--agent <name>`). */
  name: string;
  switchAgentId: string | null;
  /** Whether the definition carries Switch credentials (registered on a server). */
  registered: boolean;
};

/**
 * Read-only scan of a working directory for the provider's on-disk agent
 * definitions and their Switch credentials — used by the Add Agent modal to
 * offer onboarding a directory that already contains agents (CHOO-1440). Returns
 * an empty list for a provider with no definition concept or a directory with
 * none.
 */
export async function discoverLocationAgents(params: {
  sshHost: string | null;
  dir: string;
  providerId: AgentProviderId;
}): Promise<DiscoveredLocationAgent[]> {
  const behavior = getPlugin(params.providerId).behavior.subagents;
  if (!behavior) return [];

  const workspace = await resolveWorkspaceFsFor(params.sshHost, params.dir);
  try {
    const found = await behavior.discoverLocal(workspace.fs, workspace.homeFs);
    return found.map((agent) => ({
      name: agent.name,
      switchAgentId: agent.switchAgentId,
      registered: agent.switchAgentId != null,
    }));
  } finally {
    workspace.close();
  }
}
