import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';

export async function setSessionPinned(sessionId: string, isPinned: boolean): Promise<void> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!row) throw new Error(`Session not found: ${sessionId}`);

  await db
    .update(sessions)
    .set({
      isPinned: isPinned ? 1 : 0,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(sessions.id, sessionId));
}
