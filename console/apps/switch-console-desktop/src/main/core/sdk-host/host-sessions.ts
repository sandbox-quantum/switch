import { hostSessionsByAgent, LIST_SCRIPT } from '@switch-console/agent-providers';
import type { Session } from '@switch-console/shared/session-v1';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { connectRemoteAgent } from '@main/core/agents/connect-remote-agent';
import { getAgentById } from '@main/core/agents/getAgentById';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';

async function agentContext(
  agentId: string
): Promise<{ ctx: IExecutionContext; switchAgentId: string; hostKey: string }> {
  const agent = await getAgentById(agentId);
  if (!agent?.switchAgentId) throw new Error('This agent is not linked to Switch.');
  const location = await getAgentLocation(agent);
  const ctx = location.sshHost
    ? (await connectRemoteAgent(agent)).ctx
    : new LocalExecutionContext();
  return {
    ctx,
    switchAgentId: agent.switchAgentId,
    // The pooled SSH connection is per host, so that is also the unit the
    // read below is shared over. Everything local shares one key for the
    // same reason: it is all one machine.
    hostKey: location.sshHost ? sshConnectionIdForHost(location.sshHost) : 'local',
  };
}

/**
 * How long one host's session listing is reused for. Comfortably shorter than
 * the discovery interval, so a normal round still reads fresh state, and long
 * enough to cover a host's agents whose timers have drifted apart.
 */
export const HOST_SESSIONS_TTL_MS = 3000;

const hostReads = new Map<string, { at: number; sessions: Promise<Map<string, Session[]>> }>();

/** Drop every cached listing. For tests, and for "refresh now" paths. */
export function clearHostSessionsCache(): void {
  hostReads.clear();
}

/**
 * Every session on one host, grouped by the Switch agent that owns it.
 *
 * Shared per host, because it used to be per agent and that was the single
 * largest standing cost of running Console: each linked agent listed sessions
 * every 5 seconds, and each listing read *all* of the host's session
 * directories to keep the few that were its own. Twenty agents on a host
 * meant twenty SSH commands every five seconds, forever, down a connection
 * that runs four at a time — and the answers were near-identical.
 *
 * Now one command answers for all of them. Concurrent callers join the
 * in-flight read rather than starting their own, which is what collapses the
 * burst when a host's agents all tick together; the short TTL catches the
 * stragglers whose timers have drifted.
 *
 * A failed read is not cached — the next caller retries rather than being
 * handed a stale rejection.
 */
async function hostSessions(agentId: string): Promise<Map<string, Session[]>> {
  const { ctx, hostKey } = await agentContext(agentId);
  const cached = hostReads.get(hostKey);
  if (cached && Date.now() - cached.at < HOST_SESSIONS_TTL_MS) return cached.sessions;

  const read = (async () => {
    // An empty agent id: every agent's sessions on the host, each with its owner.
    const { stdout } = await ctx.exec('node', ['-e', LIST_SCRIPT, '', '']);
    return hostSessionsByAgent(JSON.parse(stdout));
  })();
  read.catch(() => hostReads.delete(hostKey));
  hostReads.set(hostKey, { at: Date.now(), sessions: read });
  return read;
}

/**
 * Each session this agent has on its host, as its host last recorded it: the
 * status it reported, whether its host is running now, and the room it was
 * last handed a message in.
 *
 * An agent with no sessions gets an empty list, which is a fact about the
 * host rather than a gap: the read covered every agent on it.
 */
export async function listHostSessions(agentId: string): Promise<Session[]> {
  const { switchAgentId } = await agentContext(agentId);
  return (await hostSessions(agentId)).get(switchAgentId) ?? [];
}
