import { eq, sql } from 'drizzle-orm';
import { stopSavedSession } from '@main/core/sdk-host/stop-saved-session';
import { sessionRuntimeManager } from '@main/core/sessions/session-runtime-manager';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';

export async function archiveSession(sessionId: string): Promise<void> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) return;
  await stopSavedSession(sessionId, session.agentId);

  const teardownResult = await sessionRuntimeManager.teardownSession(sessionId, 'detach');
  if (!teardownResult.success) throw new Error(teardownResult.error.message);
  await db
    .update(sessions)
    .set({
      archivedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(sessions.id, sessionId));
}
