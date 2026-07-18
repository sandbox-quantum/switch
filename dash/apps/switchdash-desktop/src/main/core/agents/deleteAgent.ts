import { eq } from 'drizzle-orm';
import {
  listAutoSessionSubagents,
  setAutoSessionAgent,
  setAutoSessionSubagent,
} from '@main/core/switch-rooms/auto-session-store';
import { autoSessionWatcher } from '@main/core/switch-rooms/auto-session-watcher';
import { viewStateService } from '@main/core/view-state/view-state-service';
import { db } from '@main/db/client';
import { agents, sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { sessionRuntimeManager } from '../sessions/session-runtime-manager';
import { agentEvents } from './agent-events';
import { getAgentLocation } from './agent-location';
import { getAgentById } from './getAgentById';
import { stopRemoteWatcher } from './remote-watcher';

/**
 * Delete an agent — the one real delete entry point (the sidebar's Remove
 * Agent routes here). Tears down everything a bare row delete would leak:
 *
 * 1. The agent's running sessions (runtime + view-state), which previously
 *    only the location-delete path handled.
 * 2. Its auto_session watcher (or, for a remote agent, the on-VM sidecar's
 *    watch flag + reconciler) and the local auto_session mirror. The watcher
 *    caches the agent's Switch credentials in memory, so without an explicit
 *    stop it keeps heartbeating and polling notifications for an agent that
 *    no longer exists.
 *
 * The agent's location row is intentionally kept — locations are reusable
 * and other agents may still live there.
 */
export async function deleteAgent(agentId: string): Promise<void> {
  const agent = await getAgentById(agentId);
  const location = agent ? await getAgentLocation(agent).catch(() => null) : null;

  const sessionRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.agentId, agentId));
  await Promise.allSettled(
    sessionRows.flatMap((row) => [
      sessionRuntimeManager.teardownSession(row.id),
      viewStateService.del(`session:${row.id}`),
    ])
  );

  if (location && location.sshHost !== null) {
    await stopRemoteWatcher(agentId).catch((error) => {
      log.warn('deleteAgent: failed to stop remote watcher', { agentId, error: String(error) });
    });
  } else {
    autoSessionWatcher.stopForAgent(agentId);
  }

  for (const { parentAgentId, name } of await listAutoSessionSubagents()) {
    if (parentAgentId !== agentId) continue;
    autoSessionWatcher.stopForSubagent(parentAgentId, name);
    await setAutoSessionSubagent(parentAgentId, name, false);
  }
  await setAutoSessionAgent(agentId, false);

  await db.delete(agents).where(eq(agents.id, agentId));
  agentEvents._emit('agent:deleted', agentId);
}
