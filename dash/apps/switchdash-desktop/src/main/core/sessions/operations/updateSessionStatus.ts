import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { type SessionLifecycleStatus } from '@shared/core/sessions/sessions';

export async function updateSessionStatus(
  sessionId: string,
  status: SessionLifecycleStatus
): Promise<void> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  if (row.status === status) return;

  await db
    .update(sessions)
    .set({
      status,
      updatedAt: sql`CURRENT_TIMESTAMP`,
      statusChangedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(sessions.id, sessionId));
}
