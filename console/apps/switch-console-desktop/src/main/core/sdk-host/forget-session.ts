import { rm } from 'node:fs/promises';
import { sharedSessionRoot } from '@switch-console/agent-providers';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { log } from '@main/lib/logger';
import { localWatcherControl, stopLocalSession } from './local-host';
import { withSidecar } from './sidecar-control';

/**
 * Tell the agent's room watcher that Console deleted one of its sessions.
 *
 * Without this the watcher keeps the session as its rooms' session and hands
 * it their messages, which a deleted session never answers. The watcher takes
 * its rooms off it, drops what was queued for it, stops its host and removes
 * its state, so a room's next message starts a new session.
 */
export async function forgetSession(agentId: string, sessionId: string): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent?.switchAgentId) return;
  if (!(await getAgentLocation(agent)).sshHost) {
    const watcher = localWatcherControl(agent.switchAgentId);
    if (watcher.running) return watcher.forget(sessionId);
    // No watcher running: nothing routes to the session now, and one started
    // later finds no state behind the room's session and drops it.
    await stopLocalSession(sessionId);
    await rm(sharedSessionRoot(sessionId), { recursive: true, force: true });
    return;
  }
  try {
    await withSidecar(agentId, (client) => client.forget(sessionId));
  } catch (error) {
    log.warn(
      'The agent sidecar was not told about a deleted session; its rooms may still reach it until the sidecar restarts',
      {
        agentId,
        sessionId,
        error: String(error),
      }
    );
  }
}
