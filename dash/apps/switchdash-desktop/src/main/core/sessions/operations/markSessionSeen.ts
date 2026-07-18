import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';

export async function markSessionSeen(sessionId: string): Promise<void> {
  await db.update(sessions).set({ agentStatusSeen: 1 }).where(eq(sessions.id, sessionId));
}
