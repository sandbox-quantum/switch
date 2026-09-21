import { eq } from 'drizzle-orm';
import { listHostSessions } from '@main/core/sdk-host/host-sessions';
import { stopSharedSession } from '@main/core/sdk-host/shared-agent-runtime';
import { configureSharedWatcher } from '@main/core/sdk-host/shared-watcher';
import { manageAgentSidecar } from '@main/core/sdk-host/sidecar-management';
import { sessionHooks } from '@main/core/sessions/session-hooks';
import { sessionRuntimeManager } from '@main/core/sessions/session-runtime-manager';
import { switchRoomService } from '@main/core/switch-rooms/switch-room-service';
import { viewStateService } from '@main/core/view-state/view-state-service';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { sessionDeletedChannel } from '@shared/core/sessions/sessionEvents';
import { getAgentById } from './getAgentById';
import { remoteSessionReconciler } from './remote-session-reconciler';
import { startRemoteDiscovery } from './remote-watcher';

export async function resetRemoteAgent(agentId: string): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent?.workspaceId || !agent.switchAgentId)
    throw new Error('The agent is not linked to Switch.');
  await configureSharedWatcher(agentId, { connected: false, spawning: false }, 'explicit');
  remoteSessionReconciler.stop(agentId);
  const remote = await listHostSessions(agentId);
  for (const session of remote) {
    if (session.agentId === agent.switchAgentId && session.status !== 'stopped')
      await stopSharedSession(agentId, session.sessionId);
  }
  const local = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.agentId, agentId));
  for (const session of local) await removeLocalSession(session.id);
  // Someone asked for this agent back, so it ends on the same transition as
  // Start: a controller stopped by hand is started, rather than held down by
  // the record of that stop, which is durable and outlasts the reset. Auto-start
  // is a separate setting and is carried through untouched.
  await manageAgentSidecar(agentId, 'start');
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
