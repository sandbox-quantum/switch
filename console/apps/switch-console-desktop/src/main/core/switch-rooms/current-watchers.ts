import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolveSharedHostBundlePath } from '@main/core/agent-runtime/impl/resolve-sidecar-bundle';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { connectRemoteAgent } from '@main/core/agents/connect-remote-agent';
import { listHostWatchers, watcherIsCurrent } from '@main/core/sdk-host/host-watchers';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import { listStoppedControllerAgentIds } from './auto-session-store';

/**
 * Which of these agents already have the watcher a bring-up would give them.
 *
 * One command for the whole host, answering for every agent on it, so the
 * expensive per-agent path runs only where it would change something. On a
 * settled host that is nobody, and the sweep costs one round trip instead of
 * roughly thirteen per agent.
 *
 * Every agent must be on the same host — the caller has already grouped them,
 * and the connection being shared per host is the whole point.
 *
 * **Returns agents to skip, never agents to act on.** If anything goes wrong
 * — the host is unreachable, the script fails, the agents are local — the
 * answer is the empty set and every agent takes the normal path. A wrong
 * "skip" leaves an agent off the air with nothing to notice it; a wrong
 * "bring up" costs round trips we are already paying today. Only one of those
 * is worth risking, so the failure mode is deliberately the expensive one.
 */
export async function currentWatchers(members: Agent[]): Promise<Set<string>> {
  const first = members[0];
  if (!first) return new Set();

  try {
    const location = await getAgentLocation(first);
    // Local agents are cheap to bring up — no SSH, no channel budget — so the
    // check would cost more than it saves.
    if (!location.sshHost) return new Set();

    const { ctx } = await connectRemoteAgent(first);
    const [statuses, stopped, bundle] = await Promise.all([
      listHostWatchers(ctx),
      listStoppedControllerAgentIds(),
      readFile(resolveSharedHostBundlePath()),
    ]);
    const bundleFile = `shared-host-${createHash('sha256').update(bundle).digest('hex')}.mjs`;

    const skip = new Set<string>();
    for (const agent of members) {
      if (!agent.switchAgentId) continue;
      // `applyControllerState` derives both flags from the same bit, so this
      // has to match it or a skip would hide a change of intent.
      const connected = !stopped.includes(agent.id);
      const status = statuses.get(agent.switchAgentId);
      if (watcherIsCurrent(status, { bundleFile, enabled: connected, spawn: connected }))
        skip.add(agent.id);
    }
    return skip;
  } catch (error) {
    // Not an error for the caller: it simply means nothing is skipped, and
    // the bring-up that follows will report the real failure with its own
    // context and retry policy.
    log.debug?.('Could not read the host’s watchers; bringing every agent up', {
      agentId: first.id,
      error: String(error),
    });
    return new Set();
  }
}
