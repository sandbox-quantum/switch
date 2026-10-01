import { getRemoteAgentLocation } from '@main/core/agents/agent-location';
import { connectRemoteAgent } from '@main/core/agents/connect-remote-agent';
import { getAgentById } from '@main/core/agents/getAgentById';
import { type HostWatcherStatus, listHostWatchers } from './host-watchers';

/**
 * How long one host's watcher state is reused. Shorter than the poll that
 * reads it, so each round reads the host afresh, and long enough that the
 * status panel and the sidebar asking in the same moment share one read.
 */
export const HOST_WATCHERS_TTL_MS = 3000;

const hostReads = new Map<
  string,
  { at: number; watchers: Promise<Map<string, HostWatcherStatus>> }
>();

/** Drop every cached read. For tests. */
export function clearHostWatcherSnapshots(): void {
  hostReads.clear();
}

/**
 * What a remote agent's watcher is doing, from one read of its whole host.
 *
 * Everything Console shows about a remote watcher comes from here — whether
 * the process is alive, which build, what it recorded when it stopped, and
 * its connection to Switch as it wrote it itself — so the sidebar and the
 * agent's page cannot disagree, and nothing depends on a connection to the
 * sidecar staying up. Callers on the same host share the read in flight.
 *
 * Null when the host has no watcher for this agent. A read that fails is not
 * cached, so the next caller tries again.
 */
export async function hostWatcherStatus(agentId: string): Promise<HostWatcherStatus | null> {
  const agent = await getAgentById(agentId);
  if (!agent?.switchAgentId) throw new Error('This agent is not linked to Switch.');
  const location = await getRemoteAgentLocation(agent);
  if (!location) throw new Error('This agent does not run on an SSH host.');
  const hostKey = location.sshHost;
  let cached = hostReads.get(hostKey);
  if (!cached || Date.now() - cached.at >= HOST_WATCHERS_TTL_MS) {
    const watchers = connectRemoteAgent(agent).then(({ ctx }) => listHostWatchers(ctx));
    watchers.catch(() => {
      if (hostReads.get(hostKey)?.watchers === watchers) hostReads.delete(hostKey);
    });
    cached = { at: Date.now(), watchers };
    hostReads.set(hostKey, cached);
  }
  return (await cached.watchers).get(agent.switchAgentId) ?? null;
}
