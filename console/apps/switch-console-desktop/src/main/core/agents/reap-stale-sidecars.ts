import {
  agentSidecarTmuxName,
  reapStaleAgentSidecars,
  type SidecarHost,
} from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import { getAgents } from './getAgents';
import { SWITCH_AGENTS_DIR_RELATIVE } from './switch-settings-paths';

/**
 * Agent names configured in the directory according to the HOST — the stems of
 * the provider-neutral `.switch/agents/<name>.json` credentials every provider
 * writes.
 *
 * The local database only knows the agents *this* Switch Console manages, which is
 * not the same set as the agents that legitimately run in a shared directory
 * (CHOO-1937). Reaping against the local set alone would kill the sidecar of an
 * agent another install onboarded here — a process this install has never heard
 * of but which is doing real work for someone else.
 *
 * Best-effort: a host that cannot be listed contributes nothing rather than
 * failing the launch this runs alongside. That is the safe direction — a
 * narrower expected-set can only spare a sidecar, never kill an extra one.
 */
async function hostConfiguredSlugs(host: SidecarHost, repoDir: string): Promise<string[]> {
  try {
    const { stdout } = await host.exec('ls', ['-1A', `${repoDir}/${SWITCH_AGENTS_DIR_RELATIVE}`]);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length))
      .filter((name) => name.length > 0);
  } catch {
    return [];
  }
}

/**
 * The sidecar tmux names that are legitimately running in an agent's directory:
 * one per agent at that location, since siblings sharing a directory each run
 * their own sidecar (CHOO-1440).
 *
 * Drawn from the local database *and* the host's own credentials directory, so
 * the set covers agents this Switch Console does not manage. `agent` is always
 * included, even if both lookups somehow miss its row — reaping must never be
 * able to kill the sidecar of the very agent it was invoked for.
 */
async function expectedSidecarNames(
  agent: Agent,
  host: SidecarHost,
  repoDir: string
): Promise<string[]> {
  const siblings = await getAgents(agent.locationId);
  const slugs = new Set([
    agent.name ?? agent.id,
    ...siblings.map((a) => a.name ?? a.id),
    ...(await hostConfiguredSlugs(host, repoDir)),
  ]);
  return [...slugs].map((slug) => agentSidecarTmuxName(repoDir, slug));
}

/**
 * Kill the sidecars left behind in this agent's directory by an earlier
 * generation of its name — an agent rename, or a release that changed how the
 * sidecar's tmux name is derived. See {@link reapStaleAgentSidecars} for why
 * those survive: nothing else on the host ever looks at a sidecar whose name is
 * not the one it just computed.
 *
 * A rename deletes the old credentials file, and the storage migration deletes
 * the id-keyed one, so the host's own view still marks those generations
 * reapable — the directory's credentials are the record of which agents are
 * *currently* set up, not of every name ever used.
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
    await reapStaleAgentSidecars(
      host,
      repoDir,
      await expectedSidecarNames(agent, host, repoDir),
      log
    );
  } catch (error) {
    log.warn('reapStaleSidecarsForAgent: failed to reconcile sidecars', {
      agentId: agent.id,
      repoDir,
      error: String(error),
    });
  }
}
