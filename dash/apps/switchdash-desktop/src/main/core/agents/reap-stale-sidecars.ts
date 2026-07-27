import {
  agentSidecarTmuxName,
  reapStaleAgentSidecars,
  type SidecarHost,
} from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import { getAgents } from './getAgents';

/**
 * The sidecar tmux names that are legitimately running in an agent's directory:
 * one per agent switchdash has at that location, since siblings sharing a
 * directory each run their own sidecar (CHOO-1440).
 *
 * `agent` is always included, even if the location query somehow misses its row
 * — reaping must never be able to kill the sidecar of the very agent it was
 * invoked for.
 */
async function expectedSidecarNames(agent: Agent, repoDir: string): Promise<string[]> {
  const siblings = await getAgents(agent.locationId);
  const slugs = new Set([agent.name ?? agent.id, ...siblings.map((a) => a.name ?? a.id)]);
  return [...slugs].map((slug) => agentSidecarTmuxName(repoDir, slug));
}

/**
 * Kill the sidecars left behind in this agent's directory by an earlier
 * generation of its name — an agent rename, or a release that changed how the
 * sidecar's tmux name is derived. See {@link reapStaleAgentSidecars} for why
 * those survive: nothing else on the host ever looks at a sidecar whose name is
 * not the one it just computed.
 *
 * Call this from paths that ensure a sidecar, not from read-only probes: it is
 * reconciliation, and a status read should not mutate the host.
 *
 * Best-effort — logged, never thrown. The caller is launching an agent; failing
 * that because a leftover process could not be enumerated would trade a cosmetic
 * problem for a real one.
 */
export async function reapStaleSidecarsForAgent(
  agent: Agent,
  host: SidecarHost,
  repoDir: string
): Promise<void> {
  try {
    await reapStaleAgentSidecars(host, repoDir, await expectedSidecarNames(agent, repoDir), log);
  } catch (error) {
    log.warn('reapStaleSidecarsForAgent: failed to reconcile sidecars', {
      agentId: agent.id,
      repoDir,
      error: String(error),
    });
  }
}
