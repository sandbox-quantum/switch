import { eq } from 'drizzle-orm';
import { sessionRuntimeManager } from '@main/core/sessions/session-runtime-manager';
import { viewStateService } from '@main/core/view-state/view-state-service';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';

export async function deleteSession(sessionId: string): Promise<void> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) return;

  const teardownResult = await sessionRuntimeManager
    .teardownSession(sessionId, 'terminate')
    .catch((e) => {
      log.warn('deleteSession: teardown failed', { sessionId, error: String(e) });
      return null;
    });

  if (teardownResult && !teardownResult.success) {
    log.warn('deleteSession: teardown failed', {
      sessionId,
      error: teardownResult.error.message,
    });
  }

  await db.delete(sessions).where(eq(sessions.id, sessionId));
  void viewStateService.del(`session:${sessionId}`);
}
