import type { Session } from '@switch-console/shared/session-v1';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import type { AgentStatus } from '@shared/core/providers/agentEvents';
import { sessionAgentStatusChangedChannel } from '@shared/core/sessions/sessionEvents';

export function sdkActivityStatus(
  session: Pick<Session, 'status' | 'pendingRequestIds'>
): AgentStatus {
  if (session.status === 'error') return 'error';
  if (session.status === 'stopped') return 'idle';
  if (session.pendingRequestIds.length) return 'awaiting-input';
  if (session.status === 'running') return 'working';
  return 'idle';
}

export async function syncSdkSessionActivity(session: Session): Promise<void> {
  const status = sdkActivityStatus(session);
  const seen = status === 'idle' || status === 'working';
  const updated = await db
    .update(sessions)
    .set({ agentStatus: status, agentStatusSeen: seen ? 1 : 0 })
    .where(
      and(
        eq(sessions.id, session.sessionId),
        or(isNull(sessions.agentStatus), ne(sessions.agentStatus, status))
      )
    )
    .returning({ id: sessions.id });
  if (updated.length) {
    events.emit(sessionAgentStatusChangedChannel, { sessionId: session.sessionId, status, seen });
  }
}
