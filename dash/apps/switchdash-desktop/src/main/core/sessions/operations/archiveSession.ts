import { eq, sql } from 'drizzle-orm';
import { sessionRuntimeManager } from '@main/core/sessions/session-runtime-manager';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';

export async function archiveSession(sessionId: string): Promise<void> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) return;

  await db
    .update(sessions)
    .set({
      archivedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(sessions.id, sessionId));

  const teardownResult = await sessionRuntimeManager
    .teardownSession(sessionId, 'detach')
    .catch((e) => {
      log.warn('archiveSession: teardown failed', { sessionId, error: String(e) });
      return null;
    });

  if (teardownResult && !teardownResult.success) {
    log.warn('archiveSession: teardown failed', { sessionId, error: teardownResult.error.message });
  }
}
