import { sessionSchema } from '@switch-console/shared/session-v1';
import { eq } from 'drizzle-orm';
import { stopSharedSession } from '@main/core/sdk-host/shared-agent-runtime';
import { configureSharedWatcher } from '@main/core/sdk-host/shared-watcher';
import { sessionHooks } from '@main/core/sessions/session-hooks';
import { sessionRuntimeManager } from '@main/core/sessions/session-runtime-manager';
import { switchRoomService } from '@main/core/switch-rooms/switch-room-service';
import { fetchSdkSessions } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { viewStateService } from '@main/core/view-state/view-state-service';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { sessionDeletedChannel } from '@shared/core/sessions/sessionEvents';
import { getAgentById } from './getAgentById';
import { remoteSessionReconciler } from './remote-session-reconciler';
import { ensureRemoteWatcher, startRemoteDiscovery } from './remote-watcher';

export async function resetRemoteAgent(agentId: string): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent?.serverId || !agent.switchAgentId)
    throw new Error('The agent is not linked to Switch.');
  const server = await getServer(agent.serverId);
  if (!server) throw new Error('The agent’s Switch server is missing.');
  await configureSharedWatcher(agentId, false);
  remoteSessionReconciler.stop(agentId);
  const remote = sessionSchema.array().parse(await fetchSdkSessions(server));
  for (const session of remote) {
    if (session.agentId === agent.switchAgentId && session.status !== 'stopped')
      await stopSharedSession(server, session.sessionId);
  }
  const local = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.agentId, agentId));
  for (const session of local) await removeLocalSession(session.id);
  await ensureRemoteWatcher(agentId);
  await startRemoteDiscovery(agentId);
}

async function removeLocalSession(sessionId: string): Promise<void> {
  await sessionRuntimeManager.teardownSession(sessionId).catch((error) => {
    log.warn('resetRemoteAgent: failed to teardown session runtime', {
      sessionId,
      error: String(error),
    });
  });
  switchRoomService.clearSession(sessionId);
  const deleted = await db.delete(sessions).where(eq(sessions.id, sessionId));
  await viewStateService.del(`session:${sessionId}`);
  if (deleted.changes === 0) return;
  // The same pair the reconciler's remote-driven delete fires: the hook for
  // anything in the main process that tracks a session's lifetime, and the IPC
  // event so an open window drops the row. Firing only the second leaves a
  // session that was reported as started and never as ended.
  sessionHooks._emit('session:deleted', sessionId);
  events.emit(sessionDeletedChannel, { sessionId });
}
